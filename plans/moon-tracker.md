# Moon Tracker — Client Integration Plan

## Goal

Move moon tracking out of `kor_moon_watch.rb` and into the dr-client
backend. Moons are game-world state, not character-specific, so they
belong in the client infrastructure alongside vitals, room, etc.

## Architecture

```
Game stream text → XmlParser → MoonTracker → WebSocket → MoonPanel (React)
                                    ↕
                              Firebase REST API
                                    ↕
                            dr-client/data/moon_state.json
```

## Backend: `lib/moon_tracker.rb`

New class, owned by `server.rb` alongside `GameState`. Responsibilities:

- **Moon cycle math** — same timing constants from moonwatch.lic:
  - Up durations: katamba 177m, yavash 177m, xibar 174m
  - Down durations: katamba 174m, yavash 175m, xibar 172m
- **State per moon**: `{ up:, next_event_at:, last_event_t: }`
- **Startup**: fetch Firebase → fall back to local JSON file → unknown
- **Periodic re-fetch**: 80% of nearest upcoming event, min 60s
  (same schedule as dependency.lic)
- **On moon event**: update state, save local file, push Firebase PUT
- **Push WebSocket event**: `{ type: "moon_state", moons: {...} }` to
  all connected clients whenever state changes
- **Snapshot inclusion**: add moon state to the `snapshot` event sent
  on WebSocket connect so the frontend has data immediately

### Interface

```ruby
tracker = MoonTracker.new(on_update: ->(state) { broadcast(state) })
tracker.start          # spawns background thread for periodic re-fetch
tracker.moon_event(moon, is_up)   # called by XmlParser on game text
tracker.state          # returns current moon state hash for snapshot
```

## Backend: `xml_parser.rb`

Add text pattern matching for moon rise/set messages. These arrive as
plain text lines in the main game stream (outside any stream window):

```
/^(Katamba|Xibar|Yavash) sets/
/^(Katamba|Xibar|Yavash) slowly rises/
```

Emit a new event type `moon_event` with `moon:` and `up:` fields,
handled by `server.rb` which forwards to `MoonTracker`.

## Backend: `server.rb`

- Instantiate `MoonTracker` at startup alongside `GameState`
- Wire `moon_event` from XmlParser → `MoonTracker#moon_event`
- Include `moon_tracker.state` in the `snapshot` sent on WebSocket open
- `MoonTracker`'s `on_update` callback calls the existing `broadcast`
  helper to push `moon_state` events to all clients

## Frontend: `useGameSocket.js`

Add `moon_state` event handling to the reducer:

```js
case "moon_state":
  return { ...state, moons: action.moons }
case "snapshot":
  return { ...state, moons: action.state.moons ?? state.moons, ... }
```

Initial state: `moons: { katamba: null, yavash: null, xibar: null }`

Each moon entry: `{ up: bool, minutesUntil: number }` — computed
server-side before sending so the frontend just renders, no math needed.
Re-send on every tick where minutes change (i.e. once per minute per
moon in practice).

## Frontend: `MoonPanel.jsx`

New component. Renders one line per moon:

```
Katamba will rise in 117 minutes
Yavash is up for 23 minutes
Xibar is up for 56 minutes
```

Unknown state: `Katamba status unknown`

Registered as a draggable panel in `Sidebar.jsx` like other panels.

## Data Flow on Startup

1. `server.rb` starts, creates `MoonTracker`
2. `MoonTracker` fetches Firebase (or loads local file), stores state
3. Spawns background thread for periodic re-fetch
4. Frontend connects, receives `snapshot` including moon state
5. `MoonPanel` renders immediately with accurate data

## Data Flow on Moon Event

1. Game server sends `"Katamba slowly rises"` in the text stream
2. `XmlParser` emits `{ type: "moon_event", moon: "katamba", up: true }`
3. `server.rb` calls `moon_tracker.moon_event("katamba", true)`
4. `MoonTracker` updates state, saves local JSON, pushes Firebase PUT
5. `MoonTracker` calls `on_update` → `server.rb` broadcasts
   `{ type: "moon_state", moons: { katamba: { up: true, minutesUntil: 177 }, ... } }`
6. All connected frontend tabs update `MoonPanel` instantly

## Migration

`kor_moon_watch.rb` can be retired once this is working. The local
state file lives at `dr-client/data/moon_state.json` — owned entirely
by the client, no dependency on kor-settings. The Firebase keys and
format stay identical so community data remains compatible.

## Files

- `lib/moon_tracker.rb` — new
- `lib/xml_parser.rb` — add moon event detection
- `server.rb` — wire MoonTracker
- `frontend/src/hooks/useGameSocket.js` — handle moon_state event
- `frontend/src/components/MoonPanel.jsx` — new
- `frontend/src/App.jsx` or `Sidebar.jsx` — register MoonPanel
- `plans/moon-tracker.md` — this file
