# Script API Reference

Stiletto exposes a TCP server on localhost (default port 5555) that scripts can connect to for reading game state and sending commands. The protocol matches Frostbite's ScriptApiServer so existing kor-scripts work unchanged.

## Protocol

**Request:** `VERB COMMAND?arg1&arg2\n`
**Response:** `result\0` (literal backslash-zero terminator, not a null byte)

Arguments are URL-encoded. Multiple arguments are `&`-separated.

---

## GET — Read game state

### Character

| Command | Response |
|---|---|
| `GET CHAR_NAME` | Current character name |

### Vitals

| Command | Response |
|---|---|
| `GET HEALTH` | Health percentage (0–100) |
| `GET CONCENTRATION` | Concentration percentage (0–100) |
| `GET SPIRIT` | Spirit percentage (0–100) |
| `GET FATIGUE` | Fatigue percentage (0–100) |

### Status indicators

Each returns `1` if active, `0` if not.

| Command |
|---|
| `GET STANDING` |
| `GET SITTING` |
| `GET KNEELING` |
| `GET PRONE` |
| `GET STUNNED` |
| `GET BLEEDING` |
| `GET HIDDEN` |
| `GET INVISIBLE` |
| `GET WEBBED` |
| `GET JOINED` |
| `GET DEAD` |

### Hands

| Command | Response |
|---|---|
| `GET WIELD_RIGHT` | Item in right hand (empty string if empty) |
| `GET WIELD_LEFT` | Item in left hand (empty string if empty) |

### Room

| Command | Response |
|---|---|
| `GET ROOM_TITLE` | Room title |
| `GET ROOM_DESC` | Room description |
| `GET ROOM_OBJECTS` | Objects in room |
| `GET ROOM_PLAYERS` | Players in room |
| `GET ROOM_EXITS` | Available exits |

### Timers

| Command | Response |
|---|---|
| `GET RT` | Roundtime remaining (seconds) |
| `GET CT` | Cast time remaining (seconds) |

### Spells

| Command | Response |
|---|---|
| `GET ACTIVE_SPELLS` | Active spell name |

### Experience

| Command | Args | Response |
|---|---|---|
| `GET EXP_NAMES` | — | Newline-separated list of all tracked skill names |
| `GET EXP_RANK` | `?SkillName` | Current rank (integer) |
| `GET EXP_STATE` | `?SkillName` | Mindstate text (e.g. `focused`, `clear`) |
| `GET EXP_MINDSTATE` | `?SkillName` | Numeric mindstate level (0–34) |
| `GET EXP_DRAIN_FRACTION` | `?SkillName` | Fraction of the mindstate scale drained per pulse (float, requires pulse history) |
| `GET EXP_NEXT_PULSE_AT` | `?SkillName` | Unix timestamp of next expected drain pulse (requires pulse history) |
| `GET EXP_PULSE_DATA` | `?SkillName` | Full pulse summary for one skill as JSON (see below) |
| `GET EXP_PULSE_ALL` | — | Full pulse summary for all skills as JSON |
| `GET EXP_SNAPSHOT` | — | Combined snapshot of all skills as JSON (see below) |

#### EXP_SNAPSHOT response format

The most useful command for scripts that need a complete picture of skill state. Returns a JSON object keyed by skill name:

```json
{
  "Polearms": {
    "mindstate": 12,
    "rank": 114,
    "drain_fraction": 0.041176,
    "next_pulse_at": 1742512345.0
  },
  "Light Armor": {
    "mindstate": 7,
    "rank": 98,
    "drain_fraction": 0.029412,
    "next_pulse_at": 1742512289.0
  }
}
```

`drain_fraction` and `next_pulse_at` are `null` for skills that have fewer than 5 observed pulses.

#### EXP_PULSE_DATA / EXP_PULSE_ALL response format

More detailed pulse tracking data per skill:

```json
{
  "drain_fraction": 0.041176,
  "reliable_pulses": 18,
  "pulses_observed": 22,
  "rank_gain_per_pulse": 0.0023,
  "rank_gain_per_pulse_rexp": 0.0046,
  "rank_gain_pulses": 14,
  "rank_gain_pulses_rexp": 4,
  "last_pulse_at": 1742512145.0,
  "next_pulse_at": 1742512345.0,
  "last_mindstate": 12
}
```

- `drain_fraction` — fraction of the 34-mindstate scale drained per pulse. Multiply by 34 to get mindstate levels per pulse.
- `reliable_pulses` — pulses used for the drain estimate (excludes login drains and favor-orb spikes)
- `rank_gain_per_pulse` — average rank progress per pulse without REXP active
- `rank_gain_per_pulse_rexp` — average rank progress per pulse with REXP active

---

## PUT — Send commands

| Command | Args | Response | Description |
|---|---|---|---|
| `PUT COMMAND` | `?text` | `1` on success | Send a command to the game as if typed |
| `PUT ECHO` | `?text` | `1` | Echo text into the main game window |

---

## CLIENT — Window management

Custom script windows appear as panels in the Stiletto UI.

| Command | Args | Response | Description |
|---|---|---|---|
| `CLIENT WINDOW_LIST` | — | Newline-separated window names | List all registered windows |
| `CLIENT WINDOW_ADD` | `?name&title` | `1` on success | Create a new window |
| `CLIENT WINDOW_REMOVE` | `?name` | `1` on success | Remove a window |
| `CLIENT WINDOW_CLEAR` | `?name` | `1` on success | Clear all lines from a window |
| `CLIENT WINDOW_WRITE` | `?name&text` | `1` on success | Append a line to a window |
| `CLIENT TRAY_WRITE` | `?text` | `1` | Send a notification message |

---

## Notes

- Skill names are case-sensitive and must match exactly as they appear in the game's experience window (e.g. `Light Armor`, `First Aid`, `Polearms`)
- The pulse tracker requires the character to be actively playing — drain fractions and pulse timestamps are derived from observed game events, not preconfigured
- `drain_fraction` values stabilize after ~5 normal pulses per skill; before that, pulse-derived fields return `null`
