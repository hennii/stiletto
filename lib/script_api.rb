require "socket"
require "uri"
require "json"

class ScriptApiServer
  def initialize(port:, game_state:, on_window_event:, on_command:, pulse_tracker: nil)
    @port = port
    @game_state = game_state
    @pulse_tracker = pulse_tracker
    @on_window_event = on_window_event
    @on_command = on_command
    @windows = {}
    @windows_mutex = Mutex.new
    @clients = []
    @clients_mutex = Mutex.new
    @server = nil
    @accept_thread = nil
  end

  def start
    @server = TCPServer.new("127.0.0.1", @port)
    @server.setsockopt(Socket::SOL_SOCKET, Socket::SO_REUSEADDR, true)
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [script_api] Listening on 127.0.0.1:#{@port}"

    @accept_thread = Thread.new do
      loop do
        begin
          client = @server.accept
          client.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)
          client.sync = true
          @clients_mutex.synchronize { @clients << client }
          puts "[#\{Time.now.strftime('%H:%M:%S')}] [script_api] Client connected (#{@clients.size} total)"
          Thread.new(client) { |c| handle_client(c) }
        rescue IOError, Errno::EBADF
          break
        rescue => e
          puts "[#\{Time.now.strftime('%H:%M:%S')}] [script_api] Accept error: #{e.message}"
        end
      end
    end
  end

  def stop
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [script_api] Shutting down"
    @server&.close rescue nil
    @clients_mutex.synchronize do
      @clients.each { |c| c.close rescue nil }
      @clients.clear
    end
    @accept_thread&.join(2)
  end

  private

  def handle_client(client)
    while (line = client.gets("\n"))
      line = line.chomp
      next if line.empty?
      result = dispatch(line)
      client.write("#{result}\\0")
      client.flush
    end
  rescue IOError, Errno::ECONNRESET, Errno::EPIPE
    # Client disconnected
  rescue => e
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [script_api] Client error: #{e.message}"
  ensure
    client.close rescue nil
    @clients_mutex.synchronize { @clients.delete(client) }
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [script_api] Client disconnected"
  end

  def dispatch(line)
    # Parse: VERB COMMAND?arg1&arg2
    verb, rest = line.split(" ", 2)
    return "" unless rest

    command, args_str = rest.split("?", 2)
    args = args_str ? args_str.split("&").map { |a| URI.decode_www_form_component(a) } : []

    case verb.upcase
    when "CLIENT"
      handle_client_command(command, args)
    when "GET"
      handle_get(command, args)
    when "PUT"
      handle_put(command, args)
    else
      ""
    end
  rescue => e
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [script_api] Dispatch error: #{e.message}"
    ""
  end

  def handle_client_command(command, args)
    case command
    when "WINDOW_LIST"
      @windows_mutex.synchronize { @windows.keys.join("\n") }

    when "WINDOW_ADD"
      name = args[0]
      title = args[1] || name
      return "0" unless name

      @windows_mutex.synchronize do
        @windows[name] = { title: title, lines: [] }
      end
      fire_window_event("add", name, title: title)
      "1"

    when "WINDOW_REMOVE"
      name = args[0]
      return "0" unless name

      @windows_mutex.synchronize { @windows.delete(name) }
      fire_window_event("remove", name)
      "1"

    when "WINDOW_CLEAR"
      name = args[0]
      return "0" unless name

      @windows_mutex.synchronize do
        return "0" unless @windows[name]
        @windows[name][:lines] = []
      end
      fire_window_event("clear", name)
      "1"

    when "WINDOW_WRITE"
      name = args[0]
      text = args[1] || ""
      return "0" unless name

      @windows_mutex.synchronize do
        return "0" unless @windows[name]
        @windows[name][:lines] << text
      end
      fire_window_event("write", name, text: text)
      "1"

    when "TRAY_WRITE"
      msg = args[0] || ""
      fire_window_event("notify", nil, text: msg)
      "1"

    else
      ""
    end
  end

  def handle_get(command, args)
    state = @game_state.snapshot

    case command
    when "CHAR_NAME"
      state[:char_name].to_s

    when "HEALTH"
      (state[:vitals]["health"] || 100).to_s
    when "CONCENTRATION"
      (state[:vitals]["concentration"] || 100).to_s
    when "SPIRIT"
      (state[:vitals]["spirit"] || 100).to_s
    when "FATIGUE"
      (state[:vitals]["fatigue"] || 100).to_s

    when "STANDING"
      indicator_value(state, "IconSTANDING")
    when "SITTING"
      indicator_value(state, "IconSITTING")
    when "KNEELING"
      indicator_value(state, "IconKNEELING")
    when "PRONE"
      indicator_value(state, "IconPRONE")
    when "STUNNED"
      indicator_value(state, "IconSTUNNED")
    when "BLEEDING"
      indicator_value(state, "IconBLEEDING")
    when "HIDDEN"
      indicator_value(state, "IconHIDDEN")
    when "INVISIBLE"
      indicator_value(state, "IconINVISIBLE")
    when "WEBBED"
      indicator_value(state, "IconWEBBED")
    when "JOINED"
      indicator_value(state, "IconJOINED")
    when "DEAD"
      indicator_value(state, "IconDEAD")

    when "WIELD_RIGHT"
      state[:hands][:right].to_s
    when "WIELD_LEFT"
      state[:hands][:left].to_s

    when "ROOM_TITLE"
      (state[:room]["title"] || "").to_s
    when "ROOM_DESC"
      (state[:room]["desc"] || "").to_s
    when "ROOM_OBJECTS"
      (state[:room]["objs"] || "").to_s
    when "ROOM_PLAYERS"
      (state[:room]["players"] || "").to_s
    when "ROOM_EXITS"
      (state[:room]["exits"] || "").to_s

    when "EXP_RANK"
      skill = args[0]
      return "" unless skill && state[:exp][skill]
      (state[:exp][skill][:rank] || 0).to_s

    when "EXP_STATE"
      skill = args[0]
      return "" unless skill && state[:exp][skill]
      (state[:exp][skill][:state] || "").to_s

    when "EXP_NAMES"
      state[:exp].keys.join("\n")

    when "EXP_PULSE_DATA"
      skill = args[0]
      return "" unless skill && @pulse_tracker
      char = state[:char_name]
      return "" unless char
      data = @pulse_tracker.snapshot(char)[skill]
      return "" unless data
      data.to_json

    when "EXP_PULSE_ALL"
      return "" unless @pulse_tracker
      char = state[:char_name]
      return "" unless char
      @pulse_tracker.snapshot(char).to_json

    when "ACTIVE_SPELLS"
      state[:active_spells].to_s

    when "RT"
      (state[:roundtime] || 0).to_s
    when "CT"
      (state[:casttime] || 0).to_s

    else
      ""
    end
  end

  def handle_put(command, args)
    case command
    when "COMMAND"
      text = args[0]
      return "0" unless text
      @on_command.call(text)
      "1"

    when "ECHO"
      text = args[0] || ""
      fire_window_event("echo", nil, text: text)
      "1"

    else
      ""
    end
  end

  def indicator_value(state, id)
    state[:indicators][id] ? "1" : "0"
  end

  def fire_window_event(action, name, title: nil, text: nil)
    event = { type: "script_window", action: action }
    event[:name] = name if name
    event[:title] = title if title
    event[:text] = text if text
    @on_window_event.call(event)
  end
end
