require "bundler/setup"
require "sinatra/base"
require "faye/websocket"
require "json"
require "open3"
require "fileutils"
require "dotenv"

Dotenv.load

require_relative "lib/eauth"
require_relative "lib/lich_launcher"
require_relative "lib/game_connection"
require_relative "lib/xml_parser"
require_relative "lib/game_state"
require_relative "lib/script_api"
require_relative "lib/log_service"
require_relative "lib/map_service"
require_relative "lib/moon_tracker"

Faye::WebSocket.load_adapter("thin")

class GameApp < Sinatra::Base
  set :server, :thin
  set :port, (ENV["DR_PORT"] || 4567).to_i
  set :bind, "0.0.0.0"

  # Serve built frontend
  set :public_folder, File.join(__dir__, "frontend", "dist")

  # WebSocket clients
  @@ws_clients = []
  @@ws_mutex = Mutex.new
  @@game_connection = nil
  @@game_state = GameState.new
  @@script_api = nil
  @@log_service = nil
  @@map_service = nil
  @@moon_tracker = nil
  @@event_batch = []
  @@batch_mutex = Mutex.new
  @@flush_scheduled = false
  @@rexp_last_polled = nil
  REXP_POLL_INTERVAL = 600  # seconds (10 minutes)

  get "/" do
    send_file File.join(settings.public_folder, "index.html")
  end

  get "/ws" do
    return [400, {}, ["Not a WebSocket request"]] unless Faye::WebSocket.websocket?(env)

    ws = Faye::WebSocket.new(env, nil, ping: 15)

    ws.on :open do |_event|
      puts "[ws] Client connected"
      @@ws_mutex.synchronize { @@ws_clients << ws }
      # Send current state snapshot
      ws.send({ type: "snapshot", state: @@game_state.snapshot }.to_json)
      # Send recent thoughts history from logs
      if @@log_service
        thoughts_history = @@log_service.read_recent("thoughts", hours: 24)
        unless thoughts_history.empty?
          ws.send({ type: "stream_history", id: "thoughts", lines: thoughts_history }.to_json)
        end
      end
      # Send current map state
      map_state = @@map_service&.current_map_state
      ws.send(map_state.to_json) if map_state
      # Send current moon state
      ws.send(@@moon_tracker.ws_event.to_json) if @@moon_tracker
    end

    ws.on :message do |event|
      data = JSON.parse(event.data) rescue nil
      next unless data

      case data["type"]
      when "command"
        if data["text"]
          puts "[ws] Command: #{data['text']}"
          @@log_service&.log_command(data["text"])
          @@log_service&.log_raw_command(data["text"])
          @@game_connection&.send_command(data["text"])
        end
      when "log_toggle"
        stream = data["stream"]
        if stream && LogService::KNOWN_STREAMS.include?(stream)
          if data["enabled"]
            @@log_service&.enable(stream)
          else
            @@log_service&.disable(stream)
          end
          # Broadcast updated log status to all clients
          GameApp.broadcast_log_status
        end
      when "log_status"
        ws.send({ type: "log_status", streams: @@log_service&.enabled_streams || [] }.to_json)
      end
    end

    ws.on :close do |event|
      puts "[ws] Client disconnected (code=#{event.code}, reason=#{event.reason})"
      @@ws_mutex.synchronize { @@ws_clients.delete(ws) }
    end

    ws.rack_response
  end

  def self.broadcast(event_hash)
    @@batch_mutex.synchronize do
      @@event_batch << event_hash
      unless @@flush_scheduled
        @@flush_scheduled = true
        # Flush batch on next EventMachine tick (sub-millisecond grouping)
        EventMachine.next_tick { flush_batch }
      end
    end
  end

  def self.broadcast_log_status
    broadcast(type: "log_status", streams: @@log_service&.enabled_streams || [])
  end

  def self.flush_batch
    batch = nil
    @@batch_mutex.synchronize do
      batch = @@event_batch
      @@event_batch = []
      @@flush_scheduled = false
    end
    return if batch.empty?

    json = batch.to_json
    @@ws_mutex.synchronize do
      @@ws_clients.each do |ws|
        begin
          ws.send(json)
        rescue => e
          puts "[ws] Send error: #{e.message}"
        end
      end
    end
  end

  def self.fully_asleep?
    sleep_data = @@game_state.snapshot[:exp]["sleep"]
    sleep_data && sleep_data[:text]&.match?(/You are fully relaxed/)
  end

  def self.maybe_poll_rexp
    return unless fully_asleep?
    return if @@rexp_last_polled && (Time.now - @@rexp_last_polled) < REXP_POLL_INTERVAL
    @@rexp_last_polled = Time.now
    puts "[rexp] Polling REXP during roundtime"
    @@game_connection&.send_command("exp")
  end

  SETTINGS_FILE = File.join(__dir__, "settings", "highlights.json")

  get "/settings" do
    content_type :json
    if File.exist?(SETTINGS_FILE)
      content = File.read(SETTINGS_FILE)
      content.strip.empty? ? { highlights: [], presets: [] }.to_json : content
    else
      { highlights: [], presets: [] }.to_json
    end
  end

  post "/settings" do
    content_type :json
    body = JSON.parse(request.body.read)
    FileUtils.mkdir_p(File.dirname(SETTINGS_FILE))
    File.write(SETTINGS_FILE, body.to_json)
    { ok: true }.to_json
  end

  PLAYER_SERVICES_FILE = File.join(__dir__, "settings", "player-services.json")
  DEFAULT_PLAYER_SERVICES = { services: [{ id: "1", title: "Thief mark", command: "mark %p" }] }.freeze

  get "/player-services" do
    content_type :json
    if File.exist?(PLAYER_SERVICES_FILE)
      content = File.read(PLAYER_SERVICES_FILE)
      content.strip.empty? ? DEFAULT_PLAYER_SERVICES.to_json : content
    else
      DEFAULT_PLAYER_SERVICES.to_json
    end
  end

  post "/player-services" do
    content_type :json
    body = JSON.parse(request.body.read)
    FileUtils.mkdir_p(File.dirname(PLAYER_SERVICES_FILE))
    File.write(PLAYER_SERVICES_FILE, body.to_json)
    { ok: true }.to_json
  end

  def self.boot!
    account  = ENV["DR_USERNAME"]  || abort("Set DR_USERNAME in .env or environment")
    password = ENV["DR_PASSWORD"]  || abort("Set DR_PASSWORD in .env or environment")
    character = ENV["DR_CHARACTER"] || abort("Set DR_CHARACTER in .env or environment")
    game_code = ENV["DR_GAME_CODE"] || "DR"

    # Step 1: eAuth
    puts "=== Authenticating with eAccess ==="
    login = EAuth.login(
      account: account,
      password: password,
      character: character,
      game_code: game_code,
    )
    puts "  Host: #{login[:host]}"
    puts "  Port: #{login[:port]}"
    puts "  Key:  #{login[:key][0..8]}..."

    # Step 2: Launch Lich
    puts "\n=== Launching Lich ==="
    lich_port = LichLauncher.launch(
      host: login[:host],
      port: login[:port],
      key: login[:key],
      game_code: game_code,
    )

    # Step 3: Set up logging, maps, moon tracker, and XML parser
    log_dir = File.join(__dir__, "logs")
    @@log_service = LogService.new(log_dir, character)

    maps_dir = File.join(__dir__, "maps")
    @@map_service = MapService.new(maps_dir)

    @@moon_tracker = MoonTracker.new(
      data_dir: File.join(__dir__, "data"),
      on_update: ->(event) { GameApp.broadcast(event) },
    )
    @@moon_tracker.start

    parser = XmlParser.new
    initial_inv_sent = false
    autostart_done = false
    first_prompt_at = nil
    parser.on_event = ->(event) do
      derived = @@game_state.update(event)
      @@log_service.log_event(event)
      broadcast(event)
      derived.each { |e| broadcast(e) }

      if event[:type] == "compass"
        map_event = @@map_service.update(@@game_state.snapshot)
        broadcast(map_event) if map_event
      end

      # Detect Lich autostart completion so we don't collide with startup scripts.
      if event[:type] == "text" && event[:text]&.include?("autostart has exited")
        autostart_done = true
      end

      if event[:type] == "roundtime" && event[:value].to_i > 0
        GameApp.maybe_poll_rexp
      end

      if event[:type] == "exp" && event[:skill] == "sleep" && !event[:text]&.match?(/fully relaxed/)
        @@rexp_last_polled = nil
      end

      # Detect moon and sun rise/set events in plain game text.
      if event[:type] == "text" && @@moon_tracker
        text = event[:text].to_s.strip
        if (m = text.match(/^(Katamba|Xibar|Yavash) sets/))
          @@moon_tracker.moon_event(m[1].downcase, false)
        elsif (m = text.match(/^(Katamba|Xibar|Yavash) slowly rises/))
          @@moon_tracker.moon_event(m[1].downcase, true)
        elsif text.match?(/heralding another fine day|rises to create the new day|as the sun rises, hidden|as the sun rises behind it|faintest hint of the rising sun|The rising sun slowly|Night slowly turns into day as the horizon/i)
          @@moon_tracker.sun_event(true)
        elsif text.match?(/The sun sinks below the horizon|night slowly drapes its starry banner|sun slowly sinks behind the scattered clouds and vanishes|grey light fades into a heavy mantle of black/i)
          @@moon_tracker.sun_event(false)
        elsif (m = text.match(/it is (?:currently .+ and it is (?:approaching |early |late )?)?(dawn|sunrise|morning|afternoon|midday|noon|dusk|sunset|evening|night|midnight)/i))
          period = case m[1].downcase
            when "dawn", "sunrise"           then "dawn"
            when "dusk", "sunset"             then "dusk"
            when "evening"                    then "night"
            when "night", "midnight"         then "night"
            else                                  "day"
          end
          @@moon_tracker.set_sky_period(period)
        end
      end

      # Lich intercepts `exp` and outputs rexp as plain text instead of a component update.
      # Detect the pattern and synthesize an exp event so the frontend panel stays current.
      if event[:type] == "text" && event[:text]&.start_with?("Rested EXP Stored:")
        rexp_event = { type: "exp", skill: "rexp", text: event[:text].strip }
        @@game_state.update(rexp_event)
        broadcast(rexp_event)
      end

      if event[:type] == "prompt" && !initial_inv_sent
        first_prompt_at ||= Time.now
        # Wait until autostart is done (or 90s have elapsed as a fallback),
        # and there's no active roundtime.
        elapsed = Time.now - first_prompt_at
        state = @@game_state.snapshot
        if (autostart_done || elapsed >= 90) && (state[:roundtime].nil? || state[:roundtime] == 0)
          @@game_connection.send_command("time")
          @@game_connection.send_command("inv list")
          initial_inv_sent = true
        end
      end
    end
    parser.on_raw_line = ->(line) { @@log_service.log_raw(line) }

    # Step 4: Connect to Lich
    puts "\n=== Connecting to game via Lich ==="
    @@game_connection = GameConnection.new(
      host: "127.0.0.1",
      port: lich_port,
      key: login[:key],
      parser: parser,
    )
    @@game_connection.connect

    # Step 5: Start ScriptApiServer for kor-scripts
    puts "\n=== Starting ScriptApiServer ==="
    @@script_api = ScriptApiServer.new(
      port: (ENV["SCRIPT_API_PORT"] || 49166).to_i,
      game_state: @@game_state,
      on_window_event: ->(event) { broadcast(event) },
      on_command: ->(cmd) { @@game_connection.send_command(cmd) },
    )
    @@script_api.start

    # Step 6: Write PID file and clean up on shutdown
    pid_file = File.join(__dir__, "logs", "server", "#{character.downcase}.pid")
    FileUtils.mkdir_p(File.dirname(pid_file))
    File.write(pid_file, Process.pid.to_s)

    at_exit do
      puts "\n=== Shutting down ==="
      File.delete(pid_file) rescue nil
      @@log_service&.close
      @@script_api&.stop
      @@game_connection&.close
      LichLauncher.shutdown
    end

    # Step 7: Start web server
    puts "\n=== Starting web server on http://localhost:#{settings.port} ==="
    run!
  end
end

GameApp.boot! if __FILE__ == $0
