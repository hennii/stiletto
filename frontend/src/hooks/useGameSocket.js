import { useReducer, useEffect, useRef, useCallback } from "react";

const MAX_LINES = 2000;
const MAX_STREAM_LINES = 200;
const MAX_SCRIPT_LINES = 500;

const SCRIPT_WINDOWS_KEY = "dr-client-script-windows";

function loadScriptWindows() {
  try { return JSON.parse(localStorage.getItem(SCRIPT_WINDOWS_KEY)) || {}; } catch { return {}; }
}
function saveScriptWindows(sw) {
  try { localStorage.setItem(SCRIPT_WINDOWS_KEY, JSON.stringify(sw)); } catch {}
}

// Module-level counter for stable line IDs. Never resets, so React keys are
// always unique and never collide between old and new lines.
let _nextLineId = 0;
function nextLineId() { return ++_nextLineId; }

const initialState = {
  gameLines: [],
  vitals: {},
  room: {},
  compass: [],
  hands: { left: "Empty", right: "Empty" },
  spell: null,
  indicators: {},
  connected: false,
  exp: {},
  activeSpells: "",
  pendingSpells: "",
  streams: {},
  scriptWindows: {},
  roundtime: null,
  casttime: null,
  charName: null,
  mono: false,
  logStreams: [],
  mapZone: null,
  mapCurrentNode: null,
  mapLevel: 0,
  inventory: { worn: [], lastFullRefresh: null },
  moons: null,
};

function appendLines(existing, newLine, max) {
  const lineWithId = { ...newLine, id: nextLineId() };
  const updated = [...existing, lineWithId];
  return updated.length > max ? updated.slice(-max) : updated;
}

// Insert space after sentence-ending punctuation directly followed by a letter
function fixSpacing(text, mono = false) {
  let result = mono ? text : text.replace(/  +/g, ' '); // preserve spaces in mono (column alignment)
  return result.replace(/([.!?])([A-Za-z])/g, '$1 $2'); // insert space after punctuation run-together
}

const DAMAGE_RE = /The \S+ lands .+?\(\d+\/\d+\).+?\./;

function splitCombatDamage(text) {
  const match = text.match(DAMAGE_RE);
  if (!match) return [{ text }];
  const idx = match.index;
  const segments = [];
  if (idx > 0) segments.push({ text: text.slice(0, idx) });
  segments.push({ text: match[0], style: "combat_damage" });
  const after = text.slice(idx + match[0].length);
  if (after) segments.push({ text: after });
  return segments;
}

function reducer(state, action) {
  switch (action.type) {
    case "connected":
      return {
        ...state,
        connected: true,
        gameLines: state.gameLines.length > 0
          ? appendLines(
              state.gameLines,
              { segments: [{ text: "*** Reconnected ***", style: "reconnect", bold: true }] },
              MAX_LINES
            )
          : state.gameLines,
      };
    case "disconnected":
      return {
        ...state,
        connected: false,
        gameLines: appendLines(
          state.gameLines,
          { segments: [{ text: "*** Connection lost ***", style: "disconnect", bold: true }] },
          MAX_LINES
        ),
      };
    case "snapshot":
      return {
        ...state,
        vitals: action.state.vitals || {},
        room: action.state.room || {},
        compass: action.state.compass || [],
        hands: action.state.hands || { left: "Empty", right: "Empty" },
        spell: action.state.spell,
        indicators: action.state.indicators || {},
        charName: action.state.char_name || null,
        roundtime: action.state.roundtime || null,
        casttime: action.state.casttime || null,
        exp: action.state.exp || {},
        activeSpells: action.state.active_spells || "",
        inventory: {
          worn: action.state.inventory?.worn || [],
          lastFullRefresh: action.state.inventory?.last_full_refresh || null,
        },
      };
    case "text": {
      const seg = {
        text: fixSpacing(action.text, action.mono),
        style: action.style || null,
        bold: action.bold || false,
        mono: action.mono || false,
      };
      // Update room title when we see a room_name styled text
      const newRoom = action.style === "room_name"
        ? { ...state.room, title: (action.text || "").trim() }
        : state.room;
      if (action.prompt) {
        // Legacy handling — prompt flag no longer set by backend
        return state;
      }
      // Merge with previous line if it hasn't been ended by a line_break
      const prev = state.gameLines[state.gameLines.length - 1];
      if (prev && !prev.prompt && !prev.ended && prev.segments) {
        // Track line-level style when room_objs/room_players appears mid-line
        let newLineStyle = prev.lineStyle;
        if (seg.style === "room_objs" || seg.style === "room_players") {
          newLineStyle = seg.style;
        }
        // Inherit line-level style for unstyled segments
        if (!seg.style && newLineStyle) {
          seg.style = newLineStyle;
        }
        const merged = [...state.gameLines];
        merged[merged.length - 1] = {
          ...prev,
          lineStyle: newLineStyle,
          segments: [...prev.segments, seg],
        };
        return { ...state, room: newRoom, gameLines: merged };
      }
      const lineStyle = (seg.style === "room_objs" || seg.style === "room_players") ? seg.style : null;
      return {
        ...state,
        room: newRoom,
        gameLines: appendLines(
          state.gameLines,
          { segments: [seg], prompt: false, lineStyle },
          MAX_LINES
        ),
      };
    }
    case "stream": {
      const fixedText = fixSpacing(action.text);
      const streamLine = { text: fixedText, ts: Date.now() };
      const streamId = action.id;

      // Update per-stream buffer
      const streamLines = state.streams[streamId] || [];
      const newStreamLines = appendLines(streamLines, streamLine, MAX_STREAM_LINES);
      const newStreams = { ...state.streams, [streamId]: newStreamLines };

      // Also add combat/thoughts/deaths/arrivals to main game text
      const showInMain = ["combat", "death", "atmospherics", "logons", "assess", "familiar"].includes(streamId);
      let newGameLines = state.gameLines;
      if (showInMain) {
        if (streamId === "combat") {
          // Split combat text so bracketed status/roundtime appear on their own lines
          const parts = fixedText.split(/\s*(\[[^\]]*\])\s*/g).filter(Boolean);
          for (const part of parts) {
            let segments;
            if (part.startsWith("[")) {
              segments = [{ text: part, style: "combat_status" }];
            } else {
              // Highlight the damage sentence (e.g. "The sword lands a heavy hit (5/23)...")
              segments = splitCombatDamage(part);
            }
            const gameLine = { segments, streamId };
            newGameLines = appendLines(newGameLines, gameLine, MAX_LINES);
          }
        } else {
          const gameLine = {
            segments: [{ text: fixedText, style: "stream" }],
            streamId: streamId,
            ended: true,
          };
          newGameLines = appendLines(newGameLines, gameLine, MAX_LINES);
        }
      }

      // Accumulate percWindow lines into pendingSpells. The panel only swaps to
      // the new list on prompt, so the displayed spells never flash blank mid-update.
      const newPendingSpells = streamId === "percWindow"
        ? (state.pendingSpells ? state.pendingSpells + "\n" + action.text : action.text)
        : state.pendingSpells;

      return {
        ...state,
        streams: newStreams,
        gameLines: newGameLines,
        pendingSpells: newPendingSpells,
      };
    }
    case "line_break": {
      const last = state.gameLines[state.gameLines.length - 1];
      if (last && !last.ended && last.segments) {
        const updated = [...state.gameLines];
        updated[updated.length - 1] = { ...last, ended: true };
        return { ...state, gameLines: updated };
      }
      return state;
    }
    case "vitals":
      return {
        ...state,
        vitals: { ...state.vitals, [action.id]: action.value },
      };
    case "room":
      return {
        ...state,
        room: { ...state.room, [action.field]: action.value },
      };
    case "compass":
      return { ...state, compass: action.dirs };
    case "hands":
      return { ...state, hands: { left: action.left, right: action.right } };
    case "spell":
      return { ...state, spell: action.name };
    case "indicator":
      return {
        ...state,
        indicators: { ...state.indicators, [action.id]: action.visible },
      };
    case "command_echo":
      return {
        ...state,
        gameLines: appendLines(state.gameLines, { segments: [{ text: action.text, style: "command_echo" }], ended: true }, MAX_LINES),
      };
    case "prompt":
      return {
        ...state,
        promptTime: action.time,
        activeSpells: state.pendingSpells,
      };
    case "prompt_spacer": {
      const lastLine = state.gameLines[state.gameLines.length - 1];
      if (lastLine && lastLine.prompt) return state;
      return {
        ...state,
        gameLines: appendLines(state.gameLines, { prompt: true }, MAX_LINES),
      };
    }
    case "exp":
      return {
        ...state,
        exp: {
          ...state.exp,
          [action.skill]: parseExp(action.skill, action.text),
        },
      };
    case "stream_clear":
      if (action.id === "percWindow") return { ...state, pendingSpells: "" };
      return state;
    case "roundtime":
      return { ...state, roundtime: action.value };
    case "casttime":
      return { ...state, casttime: action.value };
    case "char_name":
      return { ...state, charName: action.name };
    case "output_mode":
      return { ...state, mono: action.mono };
    case "script_window": {
      const sw = { ...state.scriptWindows };
      switch (action.action) {
        case "add":
          sw[action.name] = { title: action.title || action.name, lines: [] };
          break;
        case "write":
          if (sw[action.name]) {
            const prev = sw[action.name].lines;
            const next = prev.length >= MAX_SCRIPT_LINES
              ? [...prev.slice(-(MAX_SCRIPT_LINES - 1)), action.text]
              : [...prev, action.text];
            sw[action.name] = { ...sw[action.name], lines: next };
          }
          break;
        case "clear":
          if (sw[action.name]) {
            sw[action.name] = { ...sw[action.name], lines: [] };
          }
          break;
        case "remove":
          delete sw[action.name];
          break;
        default:
          break;
      }
      return { ...state, scriptWindows: sw };
    }
    case "stream_history": {
      const historyLines = (action.lines || []).map((l) => ({
        text: l.text,
        ts: l.ts,
      }));
      if (historyLines.length === 0) return state;
      const existing = state.streams[action.id] || [];
      const merged = [...historyLines, ...existing].slice(-MAX_STREAM_LINES);
      return {
        ...state,
        streams: { ...state.streams, [action.id]: merged },
      };
    }
    case "log_status":
      return { ...state, logStreams: action.streams || [] };
    case "map_zone":
      return {
        ...state,
        mapZone: action.zone,
        mapCurrentNode: action.current_node,
        mapLevel: action.level,
      };
    case "map_update":
      return {
        ...state,
        mapCurrentNode: action.current_node,
        mapLevel: action.level,
      };
    case "moon_state":
      return { ...state, moons: action.moons };
    case "inventory_worn": {
      // Rebuild worn list from names, preserving known container contents for matching items.
      const existingMap = new Map(state.inventory.worn.map((i) => [i.name, i]));
      const newWorn = (action.items || []).map((name) => existingMap.get(name) || { name, items: null });
      return { ...state, inventory: { ...state.inventory, worn: newWorn } };
    }
    case "inventory_full":
      return {
        ...state,
        inventory: {
          worn: action.tree || [],
          lastFullRefresh: action.last_full_refresh || null,
        },
      };
    case "inventory_container": {
      const stripArticle = (name) => name.replace(/^(a|an|some|the) /i, "");
      function updateContainer(items, target, newItems) {
        return items.map((item) => {
          if (stripArticle(item.name) === target) {
            return { ...item, items: newItems.map((n) => ({ name: n, items: null })) };
          }
          if (item.items && item.items.length > 0) {
            return { ...item, items: updateContainer(item.items, target, newItems) };
          }
          return item;
        });
      }
      const newWorn = updateContainer(state.inventory.worn, action.container, action.items || []);
      return { ...state, inventory: { ...state.inventory, worn: newWorn } };
    }
    case "batch":
      return action.events.reduce(reducer, state);
    default:
      return state;
  }
}

function parseExp(skill, text) {
  const match = text.match(/(\d+)\s+(\d+)%\s*(.*)$/);
  if (match) {
    return {
      text,
      rank: parseInt(match[1], 10),
      percent: parseInt(match[2], 10),
      state: match[3].trim() || null,
    };
  }
  return { text, rank: null, percent: null, state: null };
}

export function useGameSocket() {
  const [state, dispatch] = useReducer(reducer, initialState, (base) => ({
    ...base,
    scriptWindows: loadScriptWindows(),
  }));
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const intentionalClose = useRef(false);

  useEffect(() => {
    saveScriptWindows(state.scriptWindows);
  }, [state.scriptWindows]);

  useEffect(() => {
    let closed = false;
    let retryDelay = 2000;
    const MAX_RETRY_DELAY = 10000;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        console.error("[ws] Failed to create WebSocket:", e);
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      let settled = false;

      // If the connection doesn't open within 5s, give up and retry.
      // Vite's proxy can hang when the backend is down.
      const connectTimeout = setTimeout(() => {
        if (!settled) {
          console.log("[ws] Connection timeout");
          settled = true;
          ws.onopen = null;
          ws.onclose = null;
          ws.onerror = null;
          ws.close();
          scheduleReconnect();
        }
      }, 5000);

      ws.onopen = () => {
        settled = true;
        clearTimeout(connectTimeout);
        console.log("[ws] Connected");
        retryDelay = 2000;
        dispatch({ type: "connected" });
        ws.send(JSON.stringify({ type: "log_status" }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (Array.isArray(data)) {
            dispatch({ type: "batch", events: data });
          } else {
            dispatch(data);
          }
        } catch (e) {
          console.error("[ws] Parse error:", e);
        }
      };

      ws.onclose = (event) => {
        if (settled && event.code === 1000) return; // clean close from timeout
        clearTimeout(connectTimeout);
        if (!settled) settled = true;
        console.log(`[ws] Disconnected (code=${event.code})`);
        dispatch({ type: "disconnected" });
        scheduleReconnect();
      };

      ws.onerror = () => {};
    }

    function scheduleReconnect() {
      if (closed) return;
      clearTimeout(reconnectTimer.current);
      console.log(`[ws] Reconnecting in ${retryDelay / 1000}s...`);
      reconnectTimer.current = setTimeout(() => {
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "command", text }));
      dispatch({ type: "command_echo", text });
    }
  }, []);

  const sendMessage = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return {
    gameLines: state.gameLines,
    vitals: state.vitals,
    room: state.room,
    compass: state.compass,
    hands: state.hands,
    spell: state.spell,
    indicators: state.indicators,
    connected: state.connected,
    exp: state.exp,
    activeSpells: state.activeSpells,
    streams: state.streams,
    scriptWindows: state.scriptWindows,
    roundtime: state.roundtime,
    casttime: state.casttime,
    charName: state.charName,
    logStreams: state.logStreams,
    mapZone: state.mapZone,
    mapCurrentNode: state.mapCurrentNode,
    mapLevel: state.mapLevel,
    inventory: state.inventory,
    moons: state.moons,
    send,
    sendMessage,
  };
}
