require "nokogiri"
require "digest/md5"

class MapService
  BRIEF_DIRS = {
    "north" => "n", "south" => "s", "east" => "e", "west" => "w",
    "northwest" => "nw", "southwest" => "sw", "northeast" => "ne", "southeast" => "se",
    "up" => "up", "down" => "down", "out" => "out",
  }.freeze

  attr_reader :current_zone_id, :current_node_id, :current_level

  def initialize(maps_dir)
    @mutex = Mutex.new
    @zones = {}        # zone_id => zone_data hash
    @hash_index = {}   # md5 => {zone_id:, node_id:, level:}
    @connections = {}  # filename => zone_id
    @ids = []          # track duplicate zone ids

    @current_zone_id = nil
    @current_node_id = nil
    @current_level = nil

    load_maps(maps_dir)
  end

  def update(snapshot)
    room_title = snapshot[:room]["title"]
    room_desc = snapshot[:room]["desc"]
    compass = snapshot[:compass]

    return nil unless room_title && room_desc && compass

    hash = compute_game_hash(room_title, room_desc, compass)
    match = @hash_index[hash]
    return nil unless match

    @mutex.synchronize do
      if match[:zone_id] != @current_zone_id
        @current_zone_id = match[:zone_id]
        @current_node_id = match[:node_id]
        @current_level = match[:level]
        return { type: "map_zone", zone: zone_data(match[:zone_id]), current_node: match[:node_id], level: match[:level] }
      elsif match[:node_id] != @current_node_id || match[:level] != @current_level
        @current_node_id = match[:node_id]
        @current_level = match[:level]
        return { type: "map_update", current_node: match[:node_id], level: match[:level] }
      end
    end

    nil
  end

  def zone_data(zone_id)
    @zones[zone_id]
  end

  def current_map_state
    @mutex.synchronize do
      return nil unless @current_zone_id
      { type: "map_zone", zone: zone_data(@current_zone_id), current_node: @current_node_id, level: @current_level }
    end
  end

  private

  def load_maps(maps_dir)
    Dir.glob(File.join(maps_dir, "*.xml")).sort.each do |file|
      parse_zone_file(file)
    end
    puts "[#\{Time.now.strftime('%H:%M:%S')}]   [map] Loaded #{@zones.size} zones, #{@hash_index.size} room hashes"
  end

  def parse_zone_file(file)
    filename = File.basename(file)
    doc = Nokogiri::XML(File.read(file))
    zone_el = doc.at_css("zone")
    return unless zone_el

    raw_id = zone_el["id"]
    @ids << raw_id
    count = @ids.count(raw_id)
    zone_id = count > 1 ? "#{raw_id}#{(count + 96).chr}" : raw_id
    @connections[filename] = zone_id

    zone_name = zone_el["name"] || ""

    nodes = {}
    labels = []
    x_min = 0; x_max = 0; y_min = 0; y_max = 0
    levels = []

    zone_el.css("node").each do |node_el|
      node_id = node_el["id"].to_i
      node_name = node_el["name"] || ""
      node_color = node_el["color"]
      note = node_el["note"]
      notes = note ? note.split("|") : []

      pos_el = node_el.at_css("position")
      next unless pos_el
      x = pos_el["x"].to_i
      y = pos_el["y"].to_i
      z = pos_el["z"].to_i

      x_max = x if x > x_max
      x_min = x if x < x_min
      y_max = y if y > y_max
      y_min = y if y < y_min
      levels << z unless levels.include?(z)

      arcs = []
      arc_exits = []
      node_el.css("arc").each do |arc_el|
        dest = arc_el["destination"]
        exit_dir = arc_el["exit"] || ""
        hidden = arc_el["hidden"]&.downcase == "true"
        arcs << { destination: dest&.to_i, exit: exit_dir, move: arc_el["move"], hidden: hidden }
        arc_exits << exit_dir
      end

      cross_zone = notes.any? { |n| n.end_with?(".xml") }

      nodes[node_id] = {
        id: node_id, name: node_name, x: x, y: y, z: z,
        color: node_color, arcs: arcs, cross_zone: cross_zone, notes: notes,
      }

      # Build hash index
      brief_exits = arc_exits.map { |e| BRIEF_DIRS[e] || "" }.reject(&:empty?).sort
      descriptions = node_el.css("description").map(&:text)
      descriptions = [""] if descriptions.empty?

      descriptions.each do |desc|
        escaped_desc = plain_to_html(desc)
        hash_str = "[#{node_name}]#{escaped_desc}#{brief_exits.join("")}"
        hash = Digest::MD5.hexdigest(hash_str)
        @hash_index[hash] = { zone_id: zone_id, node_id: node_id, level: z }
      end
    end

    zone_el.css("label").each do |label_el|
      pos_el = label_el.at_css("position")
      next unless pos_el
      labels << {
        text: label_el["text"] || "",
        x: pos_el["x"].to_i,
        y: pos_el["y"].to_i,
        z: pos_el["z"].to_i,
      }
    end

    levels.sort!

    @zones[zone_id] = {
      id: zone_id, name: zone_name, nodes: nodes, labels: labels,
      x_min: x_min, x_max: x_max, y_min: y_min, y_max: y_max,
      levels: levels,
    }
  end

  def compute_game_hash(room_title, room_desc, compass_dirs)
    title = extract_title(room_title)
    escaped_desc = plain_to_html(room_desc)
    sorted_dirs = compass_dirs.sort
    Digest::MD5.hexdigest("#{title}#{escaped_desc}#{sorted_dirs.join("")}")
  end

  def extract_title(title)
    idx = title.index("]")
    idx ? title[0..idx] : title
  end

  def plain_to_html(text)
    text.gsub('"', "&quot;").gsub("'", "&apos;").gsub("<", "&lt;").gsub(">", "&gt;")
  end
end
