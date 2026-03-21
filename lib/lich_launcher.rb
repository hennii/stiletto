require "tempfile"

module LichLauncher
  LICH_PATH = File.expand_path("../../Lich5/lich.rbw", __dir__)

  def self.launch(host:, port:, key:, game_code: "DR")
    # Write a .sal file with launch data so Lich connects to the game server
    # and opens a local listener for us to connect to as the "client"
    @sal_file = Tempfile.new(["lich", ".sal"])
    @sal_file.puts "GAMECODE=DR"
    @sal_file.puts "GAMEHOST=#{host}"
    @sal_file.puts "GAMEPORT=#{port}"
    @sal_file.puts "GAME=STORM"
    @sal_file.puts "KEY=#{key}"
    @sal_file.puts "CUSTOMLAUNCH=echo LICH_READY port=%port%"
    @sal_file.close

    cmd = [
      "ruby", "-r", "resolv-replace", LICH_PATH,
      "--dragonrealms",
      "--frostbite",
      @sal_file.path,
    ]

    puts "[#\{Time.now.strftime('%H:%M:%S')}] [lich_launcher] Starting: #{cmd.join(' ')}"

    # Clear Bundler env so Lich runs with its own gem context
    stdin, stdout_and_err, wait_thread = Bundler.with_unbundled_env do
      Open3.popen2e(*cmd)
    end
    @pid = wait_thread.pid
    @stdin = stdin

    listen_port = nil
    deadline = Time.now + 30

    while Time.now < deadline
      ready = IO.select([stdout_and_err], nil, nil, 1)
      next unless ready

      line = stdout_and_err.gets
      break unless line

      puts "[#\{Time.now.strftime('%H:%M:%S')}] [lich] #{line.chomp}"

      if line =~ /LICH_READY port=(\d+)/
        listen_port = $1.to_i
        break
      end
    end

    raise "Lich did not start listening within 30 seconds" unless listen_port

    # Keep reading lich output in background
    Thread.new do
      while (line = stdout_and_err.gets)
        puts "[#\{Time.now.strftime('%H:%M:%S')}] [lich] #{line.chomp}"
      end
    end

    puts "[#\{Time.now.strftime('%H:%M:%S')}] [lich_launcher] Lich listening on port #{listen_port}"
    listen_port
  end

  def self.shutdown
    if @pid
      puts "[#\{Time.now.strftime('%H:%M:%S')}] [lich_launcher] Killing Lich (PID #{@pid})"
      Process.kill("KILL", @pid) rescue nil
      Process.wait(@pid) rescue nil
      @pid = nil
    end
    @sal_file&.unlink rescue nil
  end
end
