require "json"
require "net/http"
require "openssl"
require "fileutils"

class MoonTracker
  FIREBASE_URL = "https://dr-scripts.firebaseio.com/moon_data_v2.json"

  MOONS = %w[katamba yavash xibar].freeze

  MOON_KEY = {
    "katamba" => "k",
    "yavash"  => "y",
    "xibar"   => "x",
  }.freeze

  RISE = 1
  SET  = 0

  # After a moon RISES, how long (seconds) until it SETS
  UP_DURATION = {
    "katamba" => 177 * 60,
    "yavash"  => 177 * 60,
    "xibar"   => 174 * 60,
  }.freeze

  # After a moon SETS, how long (seconds) until it RISES
  DOWN_DURATION = {
    "katamba" => 174 * 60,
    "yavash"  => 175 * 60,
    "xibar"   => 172 * 60,
  }.freeze

  # Sun cycle durations (~4 real hours each based on DR's ~3x time ratio)
  SUN_UP_DURATION   = 240 * 60
  SUN_DOWN_DURATION = 240 * 60

  # Minutes before/after a sun transition to show dawn or dusk
  DAWN_DUSK_THRESHOLD = 20

  # How long a time-of-day text override is trusted before falling back to computed value
  SKY_OVERRIDE_TTL = 60 * 60  # 1 hour

  def initialize(data_dir:, on_update:)
    @data_dir = data_dir
    @on_update = on_update
    @mutex = Mutex.new
    @sun_state = { is_day: nil, next_event_at: nil, last_rise_t: nil, last_set_t: nil }
    @state = load_state
    @last_fetch = Time.now
    @next_fetch_delay = nil
    @last_broadcast_minutes = nil
    @last_broadcast_period = nil
    @sky_period_override = nil
    @sky_period_override_at = nil
  end

  # Spawn background thread for periodic Firebase re-fetches.
  def start
    Thread.new do
      loop do
        sleep 1
        check_refetch
        maybe_broadcast_tick
      rescue => e
        puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] Background thread error: #{e.message}"
      end
    end
  end

  # Called by server.rb when a moon rise/set event is seen in game text.
  def moon_event(moon, is_up)
    now = Time.now
    @mutex.synchronize do
      @state[moon] = {
        up:            is_up,
        next_event_at: now + duration_after_event(moon, is_up),
        last_event_t:  now.to_i,
      }
      @next_fetch_delay = nil
    end
    save_state
    @on_update.call(ws_event)
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] #{moon} #{is_up ? "rose" : "set"}"
  end

  # Called by server.rb when the `time` command output reveals the current time of day.
  # Overrides the Firebase-computed sky_period for up to SKY_OVERRIDE_TTL seconds.
  def set_sky_period(period)
    @mutex.synchronize do
      @sky_period_override    = period
      @sky_period_override_at = Time.now
    end
    @on_update.call(ws_event)
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] Sky period set from game text: #{period}"
  end

  # Called by server.rb when a sun rise/set event is seen in game text.
  def sun_event(is_up)
    now = Time.now
    @mutex.synchronize do
      @sun_state = {
        is_day:        is_up,
        next_event_at: now + (is_up ? SUN_UP_DURATION : SUN_DOWN_DURATION),
        last_rise_t:   is_up ? now.to_i : @sun_state[:last_rise_t],
        last_set_t:    is_up ? @sun_state[:last_set_t] : now.to_i,
      }
      # Direct sun observation overrides any time-text override
      @sky_period_override = nil
      @sky_period_override_at = nil
    end
    save_state
    @on_update.call(ws_event)
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] Sun #{is_up ? "rose" : "set"}"
  end

  # Current moon state as a WebSocket event, for use in the connect snapshot.
  def ws_event
    { type: "moon_state", moons: current_moons, sky_period: sky_period }
  end

  private

  # -- State loading (Firebase > local file > unknown) ----------------------

  def load_state
    raw = fetch_raw_firebase
    if raw
      puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] Loaded state from Firebase"
      sun = extract_sun_state(raw)
      @sun_state = sun if sun
      return extract_moon_state(raw)
    end

    local = load_local_state
    if local
      puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] Loaded state from local file (Firebase unavailable)"
      return local
    end

    puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] No state found, waiting for in-game events"
    MOONS.each_with_object({}) { |moon, h| h[moon] = { up: nil, next_event_at: nil, last_event_t: nil } }
  end

  # Push a moon_state update whenever any minute value or sky period ticks.
  def maybe_broadcast_tick
    current = current_moons
    minutes = MOONS.map { |m| current[m][:minutes_until] }
    period  = sky_period
    return if minutes == @last_broadcast_minutes && period == @last_broadcast_period

    @last_broadcast_minutes = minutes
    @last_broadcast_period  = period
    @on_update.call({ type: "moon_state", moons: current, sky_period: period })
  end

  # -- Periodic re-fetch ----------------------------------------------------

  def check_refetch
    delay = @mutex.synchronize { seconds_until_next_fetch }
    return unless Time.now - @last_fetch >= delay

    raw = fetch_raw_firebase
    if raw
      updated = false
      @mutex.synchronize do
        MOONS.each do |moon|
          entry = raw[MOON_KEY[moon]]
          next unless entry && !entry["e"].nil? && entry["t"]

          our_t = @state[moon][:last_event_t]
          next if our_t && entry["t"] <= our_t

          is_up = entry["e"] == RISE
          @state[moon] = advance_moon_state(moon, is_up, Time.at(entry["t"]) + duration_after_event(moon, is_up))
          @state[moon][:last_event_t] = entry["t"]
          puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] #{moon} updated from Firebase re-fetch"
          updated = true
        end

        sun = extract_sun_state(raw)
        if sun
          @sun_state = sun
          updated = true
        end

        @next_fetch_delay = nil
      end
      save_state if updated
      @on_update.call(ws_event) if updated
    end

    @last_fetch = Time.now
  end

  # 80% of the nearest upcoming moon event, minimum 60 seconds.
  # Cached until reset (after a re-fetch or local event).
  def seconds_until_next_fetch
    return @next_fetch_delay if @next_fetch_delay

    remaining = MOONS.map { |m| @state[m][:next_event_at] }
                     .compact
                     .map { |t| t - Time.now }
                     .select { |s| s > 0 }
    @next_fetch_delay = remaining.empty? ? 60 : [(remaining.min * 0.8).to_i, 60].max
  end

  # -- Firebase -------------------------------------------------------------

  def fetch_raw_firebase
    uri = URI.parse(FIREBASE_URL)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.verify_mode = OpenSSL::SSL::VERIFY_NONE
    http.open_timeout = 5
    http.read_timeout = 5

    puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] Fetching state from Firebase"
    response = http.get(uri.request_uri, "Content-Type" => "application/json")
    raw = JSON.parse(response.body)
    raw.nil? ? nil : raw
  rescue => e
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] Firebase fetch failed: #{e.message}"
    nil
  end

  def extract_moon_state(raw)
    MOONS.each_with_object({}) do |moon, h|
      entry = raw[MOON_KEY[moon]]
      if entry && !entry["e"].nil? && entry["t"]
        is_up = entry["e"] == RISE
        h[moon] = advance_moon_state(moon, is_up, Time.at(entry["t"]) + duration_after_event(moon, is_up))
        h[moon][:last_event_t] = entry["t"]
      else
        h[moon] = { up: nil, next_event_at: nil, last_event_t: nil }
      end
    end
  end

  # Returns a sun_state hash from Firebase raw data, or nil if not present.
  # Does NOT modify @sun_state — caller is responsible.
  def extract_sun_state(raw)
    sun = raw["s"]
    return nil unless sun

    rise_t = sun["r"]
    set_t  = sun["s"]
    return nil unless rise_t || set_t

    if rise_t && set_t
      if rise_t >= set_t
        state = advance_sun_state(true, Time.at(rise_t) + SUN_UP_DURATION)
      else
        state = advance_sun_state(false, Time.at(set_t) + SUN_DOWN_DURATION)
      end
    elsif rise_t
      state = advance_sun_state(true, Time.at(rise_t) + SUN_UP_DURATION)
    else
      state = advance_sun_state(false, Time.at(set_t) + SUN_DOWN_DURATION)
    end

    state.merge(last_rise_t: rise_t, last_set_t: set_t)
  end

  # -- Local file persistence -----------------------------------------------

  def state_file_path
    FileUtils.mkdir_p(@data_dir)
    File.join(@data_dir, "moon_state.json")
  end

  def load_local_state
    return nil unless File.exist?(state_file_path)

    raw = JSON.parse(File.read(state_file_path))

    if (sun_entry = raw["__sun__"]) && !sun_entry["is_day"].nil? && sun_entry["next_event_at"]
      sun = advance_sun_state(sun_entry["is_day"], Time.at(sun_entry["next_event_at"]))
      @sun_state = sun.merge(
        last_rise_t: sun_entry["last_rise_t"],
        last_set_t:  sun_entry["last_set_t"],
      )
    end

    MOONS.each_with_object({}) do |moon, h|
      entry = raw[moon]
      if entry && !entry["up"].nil? && entry["next_event_at"]
        h[moon] = advance_moon_state(moon, entry["up"], Time.at(entry["next_event_at"]))
        h[moon][:last_event_t] = entry["last_event_t"]
      else
        h[moon] = { up: nil, next_event_at: nil, last_event_t: nil }
      end
    end
  rescue => e
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] Local state load failed: #{e.message}"
    nil
  end

  def save_state
    moon_snapshot, sun_snapshot = @mutex.synchronize { [@state.transform_values(&:dup), @sun_state.dup] }

    data = MOONS.each_with_object({}) do |moon, h|
      s = moon_snapshot[moon]
      h[moon] = {
        "up"            => s[:up],
        "next_event_at" => s[:next_event_at]&.to_i,
        "last_event_t"  => s[:last_event_t],
      }
    end

    data["__sun__"] = {
      "is_day"        => sun_snapshot[:is_day],
      "next_event_at" => sun_snapshot[:next_event_at]&.to_i,
      "last_rise_t"   => sun_snapshot[:last_rise_t],
      "last_set_t"    => sun_snapshot[:last_set_t],
    }

    File.write(state_file_path, JSON.generate(data))
  rescue => e
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [moon] State save failed: #{e.message}"
  end

  # -- Moon cycle math -------------------------------------------------------

  def duration_after_event(moon, is_up)
    is_up ? UP_DURATION[moon] : DOWN_DURATION[moon]
  end

  def advance_moon_state(moon, up, next_event_at)
    while next_event_at <= Time.now
      up = !up
      next_event_at += duration_after_event(moon, up)
    end
    { up: up, next_event_at: next_event_at }
  end

  def advance_sun_state(is_day, next_event_at)
    while next_event_at <= Time.now
      is_day = !is_day
      next_event_at += is_day ? SUN_UP_DURATION : SUN_DOWN_DURATION
    end
    { is_day: is_day, next_event_at: next_event_at }
  end

  def minutes_until(time)
    return nil if time.nil?
    [((time - Time.now) / 60).to_i, 0].max
  end

  def current_moons
    @mutex.synchronize do
      MOONS.each_with_object({}) do |moon, h|
        s = @state[moon]
        if s[:next_event_at] && s[:next_event_at] <= Time.now
          s = advance_moon_state(moon, s[:up], s[:next_event_at])
          s[:last_event_t] = @state[moon][:last_event_t]
          @state[moon] = s
        end
        h[moon] = { up: s[:up], minutes_until: minutes_until(s[:next_event_at]) }
      end
    end
  end

  def sky_period
    @mutex.synchronize do
      # Trust override from game `time` text for up to SKY_OVERRIDE_TTL
      if @sky_period_override && (Time.now - @sky_period_override_at) < SKY_OVERRIDE_TTL
        return @sky_period_override
      end

      s = @sun_state
      return "night" if s[:is_day].nil?

      mins = minutes_until(s[:next_event_at])
      if s[:is_day]
        mins && mins <= DAWN_DUSK_THRESHOLD ? "dusk" : "day"
      else
        mins && mins <= DAWN_DUSK_THRESHOLD ? "dawn" : "night"
      end
    end
  end
end
