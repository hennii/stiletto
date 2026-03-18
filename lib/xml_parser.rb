require "nokogiri"

class XmlParser
  attr_accessor :on_event, :on_raw_line

  def initialize
    @on_event = nil
    @on_raw_line = nil
    @in_push_stream = nil
    @push_buffer = []
    @text_buffer = ""
    @bold = false
    @mono = false
    @current_style = nil
    @left_hand = ""
    @right_hand = ""
    @prompt_time = nil
  end

  def feed(line)
    @on_raw_line&.call(line)

    # Preprocess: fix unescaped ampersands
    line = line.gsub(/&(?!#?[a-z0-9]+;)/i, "&amp;")

    # Convert self-closing pushStream to opening tag;
    # convert popStream to a recognizable element (not a closing tag,
    # since Nokogiri discards orphan closing tags across line boundaries)
    line = line.gsub(/<pushStream([^>]*)\/>/, '<pushStream\1>')
    line = line.gsub(/<popStream[^>]*\/>/, '<popstream/>')

    # Rename <style> to <gamestyle> to prevent Nokogiri HTML mode from
    # treating it as a CSS <style> element (which swallows sibling text)
    line = line.gsub(/<style\b/, "<gamestyle")
    line = line.gsub(/<\/style>/, "</gamestyle>")

    parse_line(line)

    # Each feed() call is one \r\n-delimited line from the game server.
    if @in_push_stream
      # Flush this line's push buffer content as its own stream event so that
      # multi-line push streams (e.g. combat) don't concatenate into one blob.
      flush_push_stream_line
    else
      flush_text
      emit(type: "line_break")
    end
  end

  private

  def parse_line(line)
    begin
      doc = Nokogiri::HTML.fragment("<root>#{line}</root>")
    rescue => e
      escaped = "<root><![CDATA[#{line}]]></root>"
      begin
        doc = Nokogiri::HTML.fragment(escaped)
      rescue
        emit(type: "text", text: line)
        return
      end
    end

    root = doc.at("root") || doc
    process_nodes(root.children)
  end

  def process_nodes(nodes)
    nodes.each { |node| process_node(node) }
  end

  def process_node(node)
    case node.name
    when "text"
      handle_text(node.text)

    when "pushstream"
      id = node["id"]
      if @in_push_stream.nil?
        flush_text unless @text_buffer.empty?
        @in_push_stream = id
        @push_buffer = []
      end
      process_nodes(node.children)

    when "streamwindow"
      # Metadata tag for stream windows; content comes via pushStream
      return

    when "clearstream"
      # Emit a clear signal so the frontend can reset accumulated stream content
      # (e.g. percWindow spells list) before the new content arrives.
      emit(type: "stream_clear", id: node["id"])
      # clearstream is often on the same line as pushstream. In Nokogiri's HTML
      # mode, the self-closing clearstream tag (`/>` ignored for non-void elements)
      # stays open and pushstream becomes its child. Process children so the
      # nested pushstream is still handled correctly.
      process_nodes(node.children)

    when "popstream"
      flush_push_stream

    when "prompt"
      flush_text
      emit(type: "prompt_spacer")
      time = node["time"]&.to_i
      @prompt_time = time
      emit(type: "prompt", time: time)

    when "gamestyle"
      id = node["id"]
      # Flush any text accumulated under the previous style
      flush_text unless @text_buffer.empty?
      if id == "roomName"
        @current_style = "room_name"
      elsif id.nil? || id.empty?
        @current_style = nil
      else
        @current_style = nil
      end
      process_nodes(node.children)

    when "preset"
      id = node["id"]
      style = case id
              when "speech" then "speech"
              when "thought" then "thought"
              when "whisper" then "whisper"
              when "roomDesc" then "room_desc"
              else id
              end
      old_style = @current_style
      @current_style = style
      process_nodes(node.children)
      flush_text
      @current_style = old_style

    when "dialogdata"
      process_vitals(node) if node["id"] == "minivitals"

    when "progressbar"
      return

    when "compass"
      dirs = node.css("dir").map { |d| d["value"] }
      emit(type: "compass", dirs: dirs)

    when "roundtime"
      emit(type: "roundtime", value: node["value"]&.to_i)
      process_nodes(node.children)

    when "casttime"
      emit(type: "casttime", value: node["value"]&.to_i)
      process_nodes(node.children)

    when "indicator"
      emit(type: "indicator", id: node["id"], visible: node["visible"] == "y")
      process_nodes(node.children)

    when "left"
      @left_hand = node.text.strip
      emit(type: "hands", left: @left_hand, right: @right_hand)

    when "right"
      @right_hand = node.text.strip
      emit(type: "hands", left: @left_hand, right: @right_hand)

    when "spell"
      emit(type: "spell", name: node.text.strip)

    when "component"
      handle_component(node)

    when "pushbold"
      flush_text unless @text_buffer.empty?
      @bold = true
      process_nodes(node.children)

    when "popbold"
      flush_text unless @text_buffer.empty?
      @bold = false
      process_nodes(node.children)

    when "b"
      flush_text unless @text_buffer.empty?
      old_bold = @bold
      @bold = true
      process_nodes(node.children)
      flush_text unless @text_buffer.empty?
      @bold = old_bold

    when "d"
      process_nodes(node.children) if node.children.any?
      handle_text(node.text) if node.children.empty?

    when "output"
      @mono = (node["class"] == "mono")
      emit(type: "output_mode", mono: @mono)
      process_nodes(node.children)

    when "app"
      name = node["char"]
      emit(type: "char_name", name: name) if name
      process_nodes(node.children)

    when "inv", "clearcontainer"
      # Inventory container update tags — silently ignore, not displayed in main window
      return

    when "root"
      process_nodes(node.children)

    else
      # Unknown tag — process children for any text content
      process_nodes(node.children)
    end
  end

  def handle_text(text)
    return if text.nil? || text.empty?

    if @in_push_stream
      @push_buffer << text
    else
      @text_buffer << text
    end
  end

  def flush_text(prompt: false)
    return if @text_buffer.empty?

    @text_buffer = fix_spacing(@text_buffer, mono: @mono)
    event = { type: "text", text: @text_buffer }
    event[:bold] = true if @bold
    event[:mono] = true if @mono
    if @current_style
      event[:style] = @current_style
    elsif @text_buffer.strip.start_with?("Also here:")
      event[:style] = "room_players"
    elsif @text_buffer.strip.start_with?("You also see")
      event[:style] = "room_objs"
    end
    event[:prompt] = true if prompt
    emit(event)
    @text_buffer = ""
  end

  def flush_push_stream_line
    return if @push_buffer.empty?

    text = fix_spacing(@push_buffer.join)
    emit(type: "stream", id: @in_push_stream, text: text) unless text.strip.empty?
    @push_buffer = []
  end

  def flush_push_stream
    flush_push_stream_line
    @in_push_stream = nil
    @push_buffer = []
  end

  def fix_spacing(text, mono: false)
    text = text.gsub(/  +/, ' ') unless mono  # collapse double-spaces (not in mono — preserves column alignment)
    text.gsub(/([.!?])([A-Z])/, '\1 \2')      # insert space after punctuation run-together
  end

  def process_vitals(node)
    node.css("progressbar").each do |bar|
      emit(type: "vitals", id: bar["id"], value: bar["value"]&.to_i)
    end
  end

  def handle_component(node)
    id = node["id"]
    return unless id

    if id =~ /^exp (.+)$/i
      skill = $1.strip
      text = node.text.strip
      # Pulse events are automatic 200s drain updates (no <preset> child).
      # THINK responses wrap content in <preset id='whisper'> — not a pulse.
      pulse = node.at("preset").nil?
      emit(type: "exp", skill: skill, text: text, pulse: pulse, timestamp: @prompt_time)
    elsif id =~ /^room (desc|objs|players|exits)$/i
      field = $1.downcase
      html = node.inner_html.strip
        .gsub(/<pushbold\s*\/?>/i, "<b>")
        .gsub(/<popbold\s*\/?>/i, "</b>")
      emit(type: "room", field: field, value: html)
    else
      emit(type: "component", id: id, value: node.text.strip)
    end
  end

  def emit(event)
    flush_text if event[:type] != "text" && !@text_buffer.empty?
    @on_event&.call(event)
  end
end
