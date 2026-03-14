# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Overview

Web-based DragonRealms MUD client. Replaces Frostbite (Qt6 desktop client) with a local browser-based UI. Single-user, runs on localhost.

## Architecture

```
Browser (React/Vite) ↔ WebSocket ↔ Sinatra (Ruby) ↔ TCP ↔ Lich5 ↔ DR game server
```

- **Backend:** Sinatra + faye-websocket. Handles eAuth login, manages TCP connection to Lich/game server, parses the XML game stream, maintains game state, relays events over WebSocket.
- **Frontend:** React (JSX, no TypeScript) with Vite. Receives structured events over WebSocket, renders game UI panels.
- **Script API:** TCP server on localhost matching Frostbite's ScriptApiServer protocol so existing Lich/kor-scripts work unchanged.

## Tech Stack

### Backend (Ruby)
- Sinatra (web framework)
- faye-websocket (WebSocket support)
- thin or puma (Rack server with hijack support)
- nokogiri (lenient XML parsing of game stream)

### Frontend (JavaScript)
- React (JSX, **no TypeScript**)
- Vite (build tool)
- No component library chosen yet — plain CSS/flexbox/grid

## Project Structure

```
stiletto/
├── server.rb              # Sinatra app, WebSocket endpoint, wires components together
├── lib/
│   ├── eauth.rb           # SSL auth to eaccess.play.net
│   ├── game_connection.rb # TCP socket to Lich, read/write game data
│   ├── xml_parser.rb      # Parses DR's XML stream into structured events
│   ├── game_state.rb      # Thread-safe in-memory game state
│   ├── script_api.rb      # ScriptApiServer (TCP, Frostbite-compatible)
│   ├── lich_launcher.rb   # Spawns Lich as child process
│   ├── log_service.rb     # Writes main/raw/thoughts logs per character
│   └── map_service.rb     # Serves map zone/node data to frontend
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   ├── hooks/
│   │   │   └── useGameSocket.js     # WebSocket connection, all game state via useReducer
│   │   ├── context/
│   │   │   └── HighlightsContext.jsx  # Text highlight rules, shared via context
│   │   ├── components/
│   │   │   ├── CommandInput.jsx     # Text input with history and insertAtCursor
│   │   │   ├── Compass.jsx          # Directional exits
│   │   │   ├── ExpTracker.jsx       # Experience panel
│   │   │   ├── GameText.jsx         # Main scrolling game text
│   │   │   ├── HandsDisplay.jsx     # Left/right hand contents
│   │   │   ├── HighlightsModal.jsx  # Highlight rule editor
│   │   │   ├── InventoryPanel.jsx   # Worn items and containers
│   │   │   ├── LogToggle.jsx        # Enable/disable stream logging
│   │   │   ├── MainToolbar.jsx      # Top toolbar (panels, highlights, etc.)
│   │   │   ├── MapPanel.jsx         # Zone map display
│   │   │   ├── RightSidebars.jsx    # Two-column resizable/draggable right sidebar
│   │   │   ├── RoomPanel.jsx        # Room title, objs, players (clickable), exits
│   │   │   ├── Sidebar.jsx          # Left sidebar with draggable panels
│   │   │   ├── SpellDisplay.jsx     # Active spell name
│   │   │   ├── StatusIndicators.jsx # Stance, kneeling, prone, etc.
│   │   │   ├── StreamPanel.jsx      # Generic stream window (thoughts, arrivals, etc.)
│   │   │   ├── Toolbar.jsx          # Vitals bar + hands + compass row
│   │   │   └── VitalsBar.jsx        # Health/mana/stamina/spirit bars
│   │   ├── utils/
│   │   │   └── applyHighlights.js   # Applies highlight rules to game text HTML
│   │   └── styles/
│   │       └── game.css
│   ├── vite.config.js
│   └── package.json
├── settings/
│   └── highlights.json    # Persisted highlight rules and presets
├── logs/                  # Per-character dated log files (main, raw, thoughts)
├── plans/                 # Feature implementation plans (.md files)
├── PLAN.md                # Detailed project plan with build phases
└── CLAUDE.md              # This file
```

## Key Protocols

### eAuth
SSL connection to eaccess.play.net. Challenge-response with XOR password encryption. Returns session key + game host/port. Reference: `~/development/frostbite-qt6/gui/eauthservice.cpp`

### Game Connection
TCP to Lich's local proxy port. Commands sent as `<c>COMMAND\r\n`. Server sends continuous XML stream (not well-formed). Reference: `~/development/frostbite-qt6/gui/tcpclient.cpp`

### XML Stream
Malformed continuous XML. Key tags: `prompt`, `roundTime`, `compass`, `indicator`, `component` (exp/room), `dialogData` (vitals), `pushStream`/`popStream` (stream windows), `preset`/`style` (styled text). Reference: `~/development/frostbite-qt6/gui/xml/xmlparserthread.cpp`

### ScriptApiServer
TCP server, line-based protocol. Request: `COMMAND NAME?arg1&arg2\n`, Response: `result\0`. Used by kor-scripts for custom windows (`WINDOW_ADD`, `WINDOW_WRITE`, etc.). Reference: `~/development/frostbite-qt6/gui/scriptapiserver.cpp`, `~/dragonrealms/kor-scripts/kor_frostbite_client.rb`

## Related Projects

- **kor-scripts** (`~/dragonrealms/kor-scripts`) — Lich5 Ruby scripts for DR automation. 8 scripts use `KorFrostbiteClient` module which connects to the ScriptApiServer.
- **Frostbite** (`~/development/frostbite-qt6`) — The Qt6 client being replaced. Primary reference for protocol implementation.
- **Lich5** (`~/dragonrealms/lich5`) — Ruby scripting engine that proxies between client and game server.

## Development

### Running

1. Start the backend: `bundle exec ruby server.rb`
2. Open `http://localhost:4567`

The backend serves the built frontend from `frontend/dist/`.

### Frontend Development (hot reload)

For live CSS/JS changes without rebuilding:

1. Keep the backend running on port 4567
2. Start Vite dev server: `cd frontend && npm run dev`
3. Open `http://localhost:5174` (not 4567)

Vite proxies `/ws` to the Sinatra backend automatically. Changes to source files hot-reload instantly.

To build for production: `cd frontend && npm run build`

### Plans

Feature implementation plans are saved as `.md` files in `dr-client/plans/`. When planning a new feature, save the plan there before implementing.

### Debugging

When investigating game data issues, unexpected output, or implementing features that depend on the XML stream format, always check the raw logs first. Raw logs capture the exact XML sent by the game server and are the ground truth for understanding what the backend receives.

Raw logs are in `logs/raw-<character>-<date>.log`. Example:

```bash
grep -i "room players\|pushbold" logs/raw-Kesmgurr-2026-02-23.log | head -20
```

### CSS Conventions

- **Mobile-first:** Default rules target the smallest viewport. Use `min-width` media queries to layer in styles for larger screens. Never use `max-width` queries to override defaults.

### Notes

- See `PLAN.md` for the full project plan and phased build order
- The XML parser is the most complex backend component — the game stream has many edge cases
- When implementing ScriptApiServer commands, test against `kor_frostbite_client.rb` to ensure compatibility
- ScriptApiServer uses literal `\0` (backslash + zero) as response terminator, NOT a null byte — matching Frostbite's C++ `tr("\\0")` behavior
- Frontend uses no TypeScript — plain JSX only
- Do NOT use `white-space: pre` (or `pre-wrap`) for mono-mode game lines — mono mode is for preserving internal column spacing (multiple spaces), not for preventing line wrapping
