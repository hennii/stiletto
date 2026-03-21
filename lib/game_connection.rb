require "socket"

class GameConnection
  attr_reader :connected

  def initialize(host:, port:, key:, parser:)
    @host = host
    @port = port
    @key = key
    @parser = parser
    @connected = false
    @socket = nil
  end

  def connect
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [game_connection] Connecting to #{@host}:#{@port}"
    @socket = TCPSocket.new(@host, @port)
    @socket.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)
    @socket.setsockopt(Socket::SOL_SOCKET, Socket::SO_KEEPALIVE, 1)

    # Send session key
    @socket.write("<c>#{@key}\r\n")
    # Send client identification
    @socket.write("<c>/FE:STORMFRONT /VERSION:1.0.1.26 /P:WIN_UNKNOWN /XML\r\n")
    @connected = true
    puts "[#\{Time.now.strftime('%H:%M:%S')}] [game_connection] Connected and authenticated"

    start_read_loop
  end

  def send_command(cmd)
    return unless @connected && @socket
    @socket.write("<c>#{cmd}\r\n")
  end

  def close
    @connected = false
    @socket&.close rescue nil
  end

  private

  def start_read_loop
    @read_thread = Thread.new do
      buffer = ""
      while @connected
        begin
          data = @socket.readpartial(8192)
          buffer << data
          while (idx = buffer.index("\n"))
            line = buffer.slice!(0..idx).chomp
            @parser.feed(line) unless line.empty?
          end
        rescue EOFError, IOError, Errno::ECONNRESET => e
          puts "[#\{Time.now.strftime('%H:%M:%S')}] [game_connection] Disconnected: #{e.message}"
          @connected = false
          break
        end
      end
    end
  end
end
