require "fileutils"
require "json"

class LogService
  STREAM_MAP = {
    "thoughts" => "thoughts",
    "combat" => "combat",
    "logons" => "arrivals",
    "death" => "deaths",
  }

  # Streams that also appear in the main log (mirrors frontend showInMain)
  MAIN_STREAMS = %w[combat death logons atmospherics assess]

  KNOWN_STREAMS = %w[main thoughts combat arrivals deaths raw]

  def initialize(base_dir, char_name)
    @base_dir = base_dir
    @char_name = char_name
    @settings_path = File.join(@base_dir, "settings.json")
    @enabled = load_settings
    @files = {}
    @file_dates = {}
    @main_buffer = ""
    @mutex = Mutex.new
    FileUtils.mkdir_p(@base_dir)
  end

  def log_event(event)
    @mutex.synchronize do
      case event[:type]
      when "text"
        @main_buffer << (event[:text] || "") if @enabled["main"]
      when "line_break"
        flush_main_line
      when "prompt"
        flush_main_line
      when "stream"
        text = (event[:text] || "").strip
        next if text.empty?
        if (stream = STREAM_MAP[event[:id]]) && @enabled[stream]
          write_line(stream, text)
        end
        if MAIN_STREAMS.include?(event[:id]) && @enabled["main"]
          write_line("main", text)
        end
      end
    end
  end

  def log_command(text)
    @mutex.synchronize do
      return unless @enabled["main"]
      flush_main_line unless @main_buffer.empty?
      write_line("main", "> #{text}")
    end
  end

  def log_raw(line)
    @mutex.synchronize do
      return unless @enabled["raw"]
      write_raw("raw", line)
    end
  end

  def log_raw_command(text)
    @mutex.synchronize do
      return unless @enabled["raw"]
      write_raw("raw", "<c>#{text}")
    end
  end

  def enable(stream)
    @mutex.synchronize do
      @enabled[stream] = true
      save_settings
    end
  end

  def disable(stream)
    @mutex.synchronize do
      @enabled.delete(stream)
      save_settings
    end
  end

  def enabled?(stream)
    @mutex.synchronize { !!@enabled[stream] }
  end

  def enabled_streams
    @mutex.synchronize { @enabled.keys }
  end

  def read_recent(stream, hours: 24)
    cutoff = Time.now - (hours * 3600)
    today = Date.today
    yesterday = today - 1
    lines = []

    [yesterday, today].each do |date|
      path = File.join(@base_dir, stream, @char_name, "#{stream}-#{@char_name}-#{date}.log")
      next unless File.exist?(path)

      File.foreach(path) do |line|
        line.chomp!
        next if line.empty?
        if line =~ /^\[(\d{2}):(\d{2})\] (.*)$/
          h, m, text = $1.to_i, $2.to_i, $3
          line_time = Time.new(date.year, date.month, date.day, h, m)
          lines << { text: text, ts: line_time.to_i * 1000 } if line_time >= cutoff
        end
      end
    end

    lines
  end

  def close
    @mutex.synchronize do
      @files.each_value { |f| f.close rescue nil }
      @files.clear
      @file_dates.clear
    end
  end

  private

  def flush_main_line
    return if @main_buffer.empty?
    return unless @enabled["main"]
    text = @main_buffer.rstrip
    @main_buffer = ""
    write_line("main", text) unless text.empty?
  end

  def write_line(stream, text)
    file = file_for(stream)
    timestamp = Time.now.strftime("%H:%M")
    file.puts("[#{timestamp}] #{text}")
    file.flush
  end

  def write_raw(stream, text)
    file = file_for(stream)
    file.puts(text)
    file.flush
  end

  def load_settings
    return { "main" => true, "thoughts" => true } unless File.exist?(@settings_path)
    data = JSON.parse(File.read(@settings_path))
    streams = data["enabled_streams"] || []
    streams.each_with_object({}) { |s, h| h[s] = true }
  rescue
    { "main" => true, "thoughts" => true }
  end

  def save_settings
    FileUtils.mkdir_p(@base_dir)
    File.write(@settings_path, JSON.pretty_generate({ enabled_streams: @enabled.keys }))
  rescue => e
    $stderr.puts "[#{Time.now.strftime('%H:%M:%S')}] [log_service] Failed to save settings: #{e.message}"
  end

  def file_for(stream)
    today = Date.today.to_s
    if @file_dates[stream] != today
      @files[stream]&.close rescue nil
      @files.delete(stream)
      @file_dates[stream] = today
    end

    @files[stream] ||= begin
      dir = File.join(@base_dir, stream, @char_name)
      FileUtils.mkdir_p(dir)
      path = File.join(dir, "#{stream}-#{@char_name}-#{today}.log")
      File.open(path, "a")
    end
  end
end
