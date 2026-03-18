# Experience Pulse Tracking — Implementation

## What Was Built

Phase 1 of the experience pulse tracking system: backend data collection and a frontend Drain tab in the ExpTracker panel. Dynamic mindstate targeting (Phase 2/3) is out of scope here.

## Background

DragonRealms drains experience pools every ~200 seconds per skill group. The per-pulse drain rate (driven by Wisdom) is undocumented and varies per character. Tracking it empirically enables future dynamic mindstate targeting in Lich scripts.

## Implementation

### Pulse Detection (`lib/xml_parser.rb`)

Pulses arrive as `<component id='exp Skill'>` tags in the XML stream without a `<preset id='whisper'>` child. THINK command responses wrap exp data in that preset, so the absence of the preset distinguishes an automatic drain pulse from a player-initiated query.

```
pulse = node.at("preset").nil?
emit(type: "exp", skill:, text:, pulse: pulse, timestamp: @prompt_time)
```

Timestamps come from the adjacent `<prompt time="unix_ts">` tag, tracked as `@prompt_time` on the parser.

### Pulse Tracker (`lib/pulse_tracker.rb`)

New Ruby class. Holds three in-memory hashes keyed by `[character, skill]`:

- `@history` — array of pulse records (up to 50 per skill)
- `@last` — last observed pulse for delta computation
- `@data` — computed summary (what gets broadcast to the frontend)

Each history entry: `{ delta:, interval:, mindstate_after:, timestamp:, rexp:, rank_delta: }`.

**Reliable pulses** are those where mindstate decreased (`delta > 0`). Pulses where mindstate held steady or rose are discarded — training was actively filling the pool during the interval, so the observed delta doesn't represent pure drain.

**Drain fraction** = mean(delta) / 34, pooling ALL reliable pulses regardless of REXP state. REXP does not affect drain speed — only rank conversion efficiency — so there is no benefit to splitting drain by REXP state. Mean is used so every pulse contributes proportionally, giving an accurate answer to "how long to drain from mind lock to clear?"

**Rank gain** = mean(rank_delta) per pulse, split by REXP state since REXP doubles rank conversion. `rank_delta` is computed as `rank + percent/100` (fractional rank including decimal) between consecutive observations. Requires at least 5 samples before emitting an estimate.

**REXP detection**: A pulse is tagged `rexp: true` only when both "Rested EXP Stored" AND "Usable This Cycle" fields are meaningfully non-zero (not "none", "0", or "less than a minute"). Checking only "Usable" is insufficient — when stored REXP is nearly depleted ("less than a minute"), the game shows "Not currently using REXP" even if usable time remains.

**Exceptional pulse filtering**: Two classes of anomalous pulses are excluded from drain and rank gain estimates but still stored in history:

- **Login drain** (`interval > 400s`): when logged out 30+ minutes, the game applies a catch-up drain at login proportional to time away. This appears as a single pulse with an interval of hours rather than ~200s.
- **Favor orb / large delta** (`delta >= 3`): rubbing a favor orb absorbs mindstate instantly, producing an abnormally large single-pulse drop. Normal drain is 1–2 levels per pulse; >= 3 is treated as exceptional.

Both constants are defined as `MAX_PULSE_INTERVAL = 400` and `MAX_PULSE_DELTA = 3` in `pulse_tracker.rb`.

**Skipped components**: `rexp`, `tdp`, `favor`, `sleep` are not skills and are excluded from tracking.

**Persistence**: written to `settings/pulse_data_<character>.json` every 10 pulses and on server shutdown. One file per character eliminates race conditions when multiple server instances run simultaneously. Format:

```json
{
  "summary": { "CharName": { "Skill": { ...summary fields } } },
  "history": { "CharName": { "Skill": [ ...pulse records ] } },
  "last":    { "CharName": { "Skill": { ...last observation } } }
}
```

### Summary Fields

| Field | Description |
|---|---|
| `drain_fraction` | Mean mindstate drain per pulse as fraction of pool (all reliable pulses) |
| `reliable_pulses` | Count of pulses where mindstate decreased (used for drain estimate) |
| `pulses_observed` | Total pulse history entries (drain + non-drain) |
| `rank_gain_per_pulse` | Mean rank gained per pulse, non-REXP sessions |
| `rank_gain_per_pulse_rexp` | Mean rank gained per pulse, REXP sessions |
| `rank_gain_pulses` | Count of non-REXP pulses with rank data |
| `rank_gain_pulses_rexp` | Count of REXP pulses with rank data |
| `last_pulse_at` | Unix timestamp of last observed pulse |
| `next_pulse_at` | Estimated next pulse (last + 200s) |
| `last_mindstate` | Numeric mindstate (0–34) at last pulse |

### Server Integration (`server.rb`)

- Instantiates `PulseTracker` at boot with path `settings/pulse_data_<character>.json`
- Sends `pulse_data` snapshot to WebSocket clients on connect
- Broadcasts `{ type: "pulse_data", data: { skill => summary } }` after each recorded pulse
- Passes `rank + percent/100` as rank value (fractional rank)
- Persists on shutdown via `at_exit`
- Passes `pulse_tracker:` to `ScriptApiServer`

### Script API (`lib/script_api.rb`)

Two GET commands for Lich scripts:

- `EXP_PULSE_DATA?skill` — returns JSON summary for one skill
- `EXP_PULSE_ALL` — returns JSON summary for all skills for the active character

### Frontend

**`useGameSocket.js`**: `pulseData: {}` in initial state, handles `snapshot` (full replace) and `pulse_data` (merge) events.

**`ExpTracker.jsx`**: Drain tab alongside Current and Learned. Skills grouped by DR skillset (Guild, Armor, Weapons, Magic, Survival, Lore). Only skills with at least one reliable drain or rank gain sample are shown. Columns:

- **Skill** — skill name
- **Levels/pulse** — mean mindstate levels drained per pulse (3 decimal places); `--` until 5 reliable samples
- **Rank/pulse** — mean rank gained per pulse; shows normal, `0.009r` (REXP-only), or `0.009 | 0.012r` (both); `--` until 5 samples
- **Samples** — count of reliable drain pulses used to compute Levels/pulse

The Current tab also shows a **Time** column (estimated minutes to drain current mindstate to clear) using the drain fraction from pulse data.

**`Sidebar.jsx`**: `LeftSidebar` passes `pulseData` through to `ExpTracker`.

## Files Changed

| File | Change |
|---|---|
| `lib/xml_parser.rb` | Pulse detection, timestamp tracking |
| `lib/pulse_tracker.rb` | New — full tracking, per-character persistence |
| `lib/script_api.rb` | `EXP_PULSE_DATA` and `EXP_PULSE_ALL` commands |
| `server.rb` | Instantiation, broadcast, snapshot, at_exit persist, REXP detection |
| `frontend/src/hooks/useGameSocket.js` | `pulseData` state, snapshot/pulse_data reducers |
| `frontend/src/components/ExpTracker.jsx` | Drain tab UI, Current tab Time column |
| `frontend/src/components/Sidebar.jsx` | Pass `pulseData` prop through LeftSidebar |
| `frontend/src/styles/game.css` | Drain tab table styles |
| `settings/pulse_data_<character>.json` | Runtime data files (not committed) |

## Known Constraints

- Drain and rank gain estimates require 5 reliable pulses to appear; takes ~17 minutes of idle draining after training
- The 200s next-pulse estimate assumes a fixed interval; pulse group assignment is not explicitly tracked
