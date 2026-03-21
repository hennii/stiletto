# Stiletto

Web-based DragonRealms MUD client. Replaces Frostbite (Qt6 desktop client) with a local browser-based UI. Single-user, runs on localhost.

## Architecture

```
Browser (React/Vite) ↔ WebSocket ↔ Sinatra (Ruby) ↔ TCP ↔ Lich5 ↔ DR game server
```

- **Backend:** Sinatra + faye-websocket. Handles eAuth login, manages TCP connection to Lich/game server, parses the XML game stream, maintains game state, relays events over WebSocket.
- **Frontend:** React (JSX) with Vite. Receives structured events over WebSocket, renders game UI panels.
- **Script API:** TCP server on localhost matching Frostbite's ScriptApiServer protocol so existing Lich/kor-scripts work unchanged.

## Setup

### Prerequisites

- Ruby (with Bundler)
- Node.js (with npm)
- Lich5

### Install dependencies

```bash
bundle install
cd frontend && npm install
```

### Build the frontend

```bash
cd frontend && npm run build
```

## Running

Multiple characters are supported, each as an independent server process. The `dr` command manages them (symlink it to somewhere on your PATH, e.g. `~/.local/bin/dr`).

```
dr start [character]   Start all servers, or a single character
dr stop [character]    Stop all servers, or a single character
dr status              Show running servers
dr logs <character>    Tail the log for a character
```

Each character needs a `.env.<character>` file (see `.env.example`).

The backend serves the built frontend from `frontend/dist/`.

## Development (hot reload)

For live CSS/JS changes without rebuilding:

1. Keep the backend running on port 4567
2. Start Vite dev server: `cd frontend && npm run dev`
3. Open `http://localhost:5174` (not 4567)

Vite proxies `/ws` to the Sinatra backend automatically. Changes to source files hot-reload instantly.

## Project Structure

```
stiletto/
├── server.rb              # Sinatra app, WebSocket endpoint
├── dr                     # CLI entry point (symlink to ~/.local/bin/dr)
├── start.sh               # Start one or all character servers
├── stop.sh                # Stop one or all character servers
├── .env.example           # Template for per-character env files
├── .env.<character>       # Per-character config (gitignored)
├── lib/
│   ├── eauth.rb           # SSL auth to eaccess.play.net
│   ├── game_connection.rb # TCP socket to Lich
│   ├── xml_parser.rb      # Parses DR's XML stream into structured events
│   ├── game_state.rb      # Thread-safe in-memory game state
│   ├── script_api.rb      # ScriptApiServer (TCP, Frostbite-compatible)
│   ├── lich_launcher.rb   # Spawns Lich as child process
│   ├── log_service.rb     # Per-character log files (main, raw, thoughts)
│   └── map_service.rb     # Serves map zone/node data
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── hooks/
│   │   │   └── useGameSocket.js         # WebSocket + all game state
│   │   ├── context/
│   │   │   ├── HighlightsContext.jsx    # Text highlight rules
│   │   │   └── PlayerServicesContext.jsx
│   │   ├── components/
│   │   │   ├── CommandInput.jsx         # Text input with history
│   │   │   ├── Compass.jsx
│   │   │   ├── ExpTracker.jsx
│   │   │   ├── GameText.jsx             # Main scrolling game text
│   │   │   ├── HandsDisplay.jsx
│   │   │   ├── HighlightsModal.jsx
│   │   │   ├── InventoryPanel.jsx
│   │   │   ├── LogToggle.jsx
│   │   │   ├── MainToolbar.jsx
│   │   │   ├── MapPanel.jsx
│   │   │   ├── PlayerServicesModal.jsx  # PC right-click actions
│   │   │   ├── RightSidebars.jsx        # Two-column draggable sidebar
│   │   │   ├── RoomPanel.jsx            # Room info with clickable player names
│   │   │   ├── Sidebar.jsx              # Left sidebar
│   │   │   ├── SpellDisplay.jsx
│   │   │   ├── StatusIndicators.jsx
│   │   │   ├── StreamPanel.jsx          # Thoughts, arrivals, etc.
│   │   │   ├── Toolbar.jsx
│   │   │   └── VitalsBar.jsx
│   │   ├── utils/
│   │   │   └── applyHighlights.js
│   │   └── styles/
│   │       └── game.css
│   ├── vite.config.js
│   └── package.json
├── settings/
│   ├── highlights.json      # Persisted highlight rules
│   └── player-services.json # PC context menu actions
├── maps/                    # Zone map XML files
├── plans/                   # Feature implementation plans
└── logs/
    ├── main/<character>/    # Main game text logs
    ├── raw/<character>/     # Raw XML stream logs
    ├── thoughts/<character>/ # Thoughts stream logs
    └── server/              # Server PIDs and server logs
```
