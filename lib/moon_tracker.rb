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

  def initialize(data_dir:, on_update:)
    @data_dir = data_dir
    @on_update = on_update
    @mutex = Mutex.new
    @state = load_state
    @last_fetch = Time.now
    @next_fetch_delay = nil
    @last_broadcast_minutes = nil
  end

  # Spawn background thread for periodic Firebase re-fetches.
  def start
    Thread.new do
      loop do
        sleep 1
        check_refetch
        maybe_broadcast_tick
      rescue => e
        puts "[moon] Background thread error: #{e.message}"
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
    push_firebase_update(moon, is_up, now)
    @on_update.call(ws_event)
    puts "[moon] #{moon} #{is_up ? "rose" : "set"}"
  end

  # Current moon state as a WebSocket event, for use in the connect snapshot.
  def ws_event
    { type: "moon_state", moons: current_moons }
  end

  private

  # -- State loading (Firebase > local file > unknown) ----------------------

  def load_state
    raw = fetch_raw_firebase
    if raw
      puts "[moon] Loaded state from Firebase"
      return parse_firebase_raw(raw)
    end

    local = load_local_state
    if local
      puts "[moon] Loaded state from local file (Firebase unavailable)"
      return local
    end

    puts "[moon] No state found, waiting for in-game events"
    MOONS.each_with_object({}) { |moon, h| h[moon] = { up: nil, next_event_at: nil, last_event_t: nil } }
  end

  # Push a moon_state update whenever any minute value ticks down.
  def maybe_broadcast_tick
    current = current_moons
    minutes = MOONS.map { |m| current[m][:minutes_until] }
    return if minutes == @last_broadcast_minutes

    @last_broadcast_minutes = minutes
    @on_update.call({ type: "moon_state", moons: current })
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
          puts "[moon] #{moon} updated from Firebase re-fetch"
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

    puts "[moon] Fetching state from Firebase"
    response = http.get(uri.request_uri, "Content-Type" => "application/json")
    raw = JSON.parse(response.body)
    raw.nil? ? nil : raw
  rescue => e
    puts "[moon] Firebase fetch failed: #{e.message}"
    nil
  end

  def parse_firebase_raw(raw)
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

  def push_firebase_update(moon, is_up, timestamp)
    uri = URI.parse("https://dr-scripts.firebaseio.com/moon_data_v2/#{MOON_KEY[moon]}.json")
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.verify_mode = OpenSSL::SSL::VERIFY_NONE
    http.open_timeout = 5
    http.read_timeout = 5

    request = Net::HTTP::Put.new(uri.request_uri, "Content-Type" => "application/json")
    request.body = { "t" => timestamp.to_i, "e" => is_up ? RISE : SET }.to_json
    puts "[moon] Pushing #{moon} #{is_up ? "rise" : "set"} to Firebase"
    http.request(request)
  rescue => e
    puts "[moon] Firebase push failed: #{e.message}"
  end

  # -- Local file persistence -----------------------------------------------

  def state_file_path
    FileUtils.mkdir_p(@data_dir)
    File.join(@data_dir, "moon_state.json")
  end

  def load_local_state
    return nil unless File.exist?(state_file_path)

    raw = JSON.parse(File.read(state_file_path))
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
    puts "[moon] Local state load failed: #{e.message}"
    nil
  end

  def save_state
    snapshot = @mutex.synchronize { @state.transform_values(&:dup) }
    data = MOONS.each_with_object({}) do |moon, h|
      s = snapshot[moon]
      h[moon] = {
        "up"            => s[:up],
        "next_event_at" => s[:next_event_at]&.to_i,
        "last_event_t"  => s[:last_event_t],
      }
    end
    File.write(state_file_path, JSON.generate(data))
  rescue => e
    puts "[moon] State save failed: #{e.message}"
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

  def minutes_until(time)
    return nil if time.nil?
    [((time - Time.now) / 60).to_i, 0].max
  end

  def current_moons
    @mutex.synchronize do
      MOONS.each_with_object({}) do |moon, h|
        s = @state[moon]
        h[moon] = { up: s[:up], minutes_until: minutes_until(s[:next_event_at]) }
      end
    end
  end
end
