require "json"

class PulseTracker
  # Ordered list of DR mindstate names, index = numeric level (0=clear, 34=mind lock)
  MINDSTATE_ORDER = [
    "clear", "dabbling", "perusing", "learning", "thoughtful", "thinking",
    "considering", "pondering", "ruminating", "concentrating", "attentive",
    "deliberative", "interested", "examining", "understanding", "absorbing",
    "intrigued", "scrutinizing", "analyzing", "studious", "focused",
    "very focused", "engaged", "very engaged", "cogitating", "fascinated",
    "captivated", "engrossed", "riveted", "very riveted", "rapt",
    "very rapt", "enthralled", "nearly locked", "mind lock",
  ].freeze

  MINDSTATE_NUM = MINDSTATE_ORDER.each_with_index.to_h.freeze
  MINDSTATE_MAX = MINDSTATE_ORDER.length - 1  # 34

  # Non-skill exp components — metadata, not trainable skills
  SKIP_SKILLS = %w[rexp tdp favor sleep].freeze

  MIN_PULSES_FOR_ESTIMATE = 5
  MAX_HISTORY = 50
  PERSIST_EVERY = 10  # persist after this many pulses recorded

  # Pulses outside these bounds are treated as exceptional (login drain, favor orb, etc.)
  # and excluded from drain/rank gain estimates but still stored in history.
  MAX_PULSE_INTERVAL = 400  # seconds — login drains have intervals of hours
  MAX_PULSE_DELTA    = 3    # mindstate levels — normal drain is 1-2; >= 3 indicates exceptional event

  def initialize(settings_path)
    @settings_path = settings_path
    # In-memory pulse history: [character, skill] => array of pulse records
    @history = {}
    # Last observed pulse: [character, skill] => { mindstate_num:, rank:, timestamp: }
    @last = {}
    # Persisted summary: character => { skill => summary_hash }
    @data = {}
    @pulse_count = 0
    load_persisted
  end

  # Record a drain pulse for a skill. Returns the updated summary hash for this skill.
  def record(character, skill, rank, mindstate_text, timestamp, rexp_active: false)
    return unless character && skill
    return if SKIP_SKILLS.include?(skill)

    mindstate_num = MINDSTATE_NUM[mindstate_text&.downcase&.strip] || 0
    key = [character, skill]

    prev = @last[key]
    if prev && timestamp && prev[:timestamp]
      delta      = prev[:mindstate_num] - mindstate_num  # positive = net drain
      interval   = timestamp - prev[:timestamp]
      rank_delta = (prev[:rank] && rank) ? rank.to_f - prev[:rank].to_f : nil

      @history[key] ||= []
      @history[key] << { delta: delta, interval: interval, mindstate_after: mindstate_num, timestamp: timestamp, rexp: rexp_active, rank_delta: rank_delta }
      @history[key].shift if @history[key].length > MAX_HISTORY
    end

    @last[key] = { mindstate_num: mindstate_num, rank: rank, timestamp: timestamp }

    update_summary(character, skill)

    @pulse_count += 1
    persist if (@pulse_count % PERSIST_EVERY).zero?

    @data.dig(character, skill)
  end

  # Returns { skill => summary_hash } for the given character
  def snapshot(character)
    (@data[character] || {}).dup
  end

  def persist
    history_out = {}
    @history.each do |(char, skill), records|
      history_out[char] ||= {}
      history_out[char][skill] = records
    end

    last_out = {}
    @last.each do |(char, skill), record|
      last_out[char] ||= {}
      last_out[char][skill] = record
    end

    File.write(@settings_path, JSON.generate({
      "summary" => @data,
      "history" => history_out,
      "last"    => last_out,
    }))
  rescue => e
    puts "[pulse_tracker] Save error: #{e.message}"
  end

  private

  def update_summary(character, skill)
    key = [character, skill]
    history = @history[key] || []
    last = @last[key]

    # Exclude exceptional pulses: login drains (long interval) and favor orbs (large delta)
    normal = history.select { |p| p[:delta] > 0 && p[:delta] < MAX_PULSE_DELTA && p[:interval] <= MAX_PULSE_INTERVAL }

    # Drain: pool all normal pulses regardless of REXP — drain rate is the same either way
    drain_pulses  = normal
    drain_fraction = mean_drain(drain_pulses)

    # Rank gain: split by REXP since REXP doubles rank conversion efficiency
    rank_pulses      = normal.select { |p| !p[:rexp] && !p[:rank_delta].nil? }
    rank_pulses_rexp = normal.select { |p|  p[:rexp] && !p[:rank_delta].nil? }
    rank_gain_per_pulse      = mean_rank_gain(rank_pulses)
    rank_gain_per_pulse_rexp = mean_rank_gain(rank_pulses_rexp)

    # Estimate next pulse at last_pulse_at + 200s (one full pulse interval)
    next_pulse_at = last && last[:timestamp] ? last[:timestamp] + 200 : nil

    @data[character] ||= {}
    @data[character][skill] = {
      "drain_fraction"          => drain_fraction,
      "reliable_pulses"         => drain_pulses.length,
      "pulses_observed"         => history.length,
      "rank_gain_per_pulse"     => rank_gain_per_pulse,
      "rank_gain_per_pulse_rexp" => rank_gain_per_pulse_rexp,
      "rank_gain_pulses"        => rank_pulses.length,
      "rank_gain_pulses_rexp"   => rank_pulses_rexp.length,
      "last_pulse_at"           => last&.dig(:timestamp),
      "next_pulse_at"           => next_pulse_at,
      "last_mindstate"          => last&.dig(:mindstate_num),
    }
  end

  def mean_drain(pulses)
    return nil if pulses.length < MIN_PULSES_FOR_ESTIMATE
    mean = pulses.sum { |p| p[:delta] }.to_f / pulses.length
    (mean / MINDSTATE_MAX).round(6)
  end

  def mean_rank_gain(pulses)
    return nil if pulses.length < MIN_PULSES_FOR_ESTIMATE
    (pulses.sum { |p| p[:rank_delta] }.to_f / pulses.length).round(4)
  end

  def load_persisted
    return unless File.exist?(@settings_path)
    raw = JSON.parse(File.read(@settings_path))

    @data = raw["summary"] || {}

    (raw["history"] || {}).each do |char, skills|
      skills.each do |skill, records|
        @history[[char, skill]] = records.map { |r| r.transform_keys(&:to_sym) }
      end
    end

    (raw["last"] || {}).each do |char, skills|
      skills.each do |skill, record|
        @last[[char, skill]] = record.transform_keys(&:to_sym)
      end
    end
  rescue => e
    puts "[pulse_tracker] Load error: #{e.message}"
  end
end
