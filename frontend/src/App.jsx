import React, { useRef, useCallback, useState, useEffect } from "react";
import { useGameSocket } from "./hooks/useGameSocket";
import Toolbar from "./components/Toolbar";
import MainToolbar from "./components/MainToolbar";
import GameText from "./components/GameText";
import CommandInput from "./components/CommandInput";
import { LeftSidebar } from "./components/Sidebar";
import RightSidebars from "./components/RightSidebars";
import { HighlightsProvider } from "./context/HighlightsContext";
import HighlightsModal from "./components/HighlightsModal";
import { PlayerServicesProvider } from "./context/PlayerServicesContext";
import PlayerServicesModal from "./components/PlayerServicesModal";

const LAYOUT_KEY = "dr-client-layout";
const DEFAULT_SIDEBAR_WIDTH = 280;
const DEFAULT_LEFT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 1200;

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function saveLayout(updates) {
  try {
    const current = loadLayout();
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...current, ...updates }));
  } catch {}
}

export default function App() {
  const {
    gameLines, vitals, room, compass, hands, spell, indicators,
    connected, exp, activeSpells, streams, scriptWindows, roundtime, casttime,
    logStreams, mapZone, mapCurrentNode, mapLevel, inventory, charName, moons, skyPeriod,
    pulseData, send, sendMessage,
  } = useGameSocket();

  useEffect(() => {
    document.title = charName ? `${charName} - DR` : "DragonRealms";
  }, [charName]);

  const [highlightsOpen, setHighlightsOpen] = useState(false);
  const [playerServicesOpen, setPlayerServicesOpen] = useState(false);

  const [hiddenPanels, setHiddenPanels] = useState(() => {
    return new Set(loadLayout().hiddenPanels || []);
  });

  const toggleHiddenPanel = useCallback((id) => {
    setHiddenPanels((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveLayout({ hiddenPanels: [...next] });
      return next;
    });
  }, []);

  const inputRef = useRef(null);
  const insertTextRef = useRef(null);
  const addToHistoryRef = useRef(null);
  const navigateHistoryRef = useRef(null);

  const NUMPAD_DIRECTIONS = {
    Numpad7: "northwest",
    Numpad8: "north",
    Numpad9: "northeast",
    Numpad4: "west",
    Numpad6: "east",
    Numpad1: "southwest",
    Numpad2: "south",
    Numpad3: "southeast",
    Numpad0: "down",
    NumpadDecimal: "up",
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.code in NUMPAD_DIRECTIONS) {
        e.preventDefault();
        send(NUMPAD_DIRECTIONS[e.code]);
        return;
      }

      const active = document.activeElement;
      if (active === inputRef.current) return;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        inputRef.current?.focus();
        navigateHistoryRef.current?.(e.key === "ArrowUp" ? "up" : "down");
        return;
      }

      if (e.key.length !== 1) return;

      e.preventDefault();
      inputRef.current?.focus();
      insertTextRef.current?.(e.key);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);
  const handleInsertText = useCallback((text) => {
    insertTextRef.current?.(text);
  }, []);

  const [rightSidebarEmpty, setRightSidebarEmpty] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const layout = loadLayout();
    return layout.sidebarWidth || DEFAULT_SIDEBAR_WIDTH;
  });

  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() => {
    const layout = loadLayout();
    return layout.leftSidebarWidth || DEFAULT_LEFT_SIDEBAR_WIDTH;
  });

  useEffect(() => {
    const handler = () => {
      const layout = loadLayout();
      setSidebarWidth(layout.sidebarWidth || DEFAULT_SIDEBAR_WIDTH);
      setLeftSidebarWidth(layout.leftSidebarWidth || DEFAULT_LEFT_SIDEBAR_WIDTH);
      setHiddenPanels(new Set(layout.hiddenPanels || []));
    };
    window.addEventListener("layout:load", handler);
    return () => window.removeEventListener("layout:load", handler);
  }, []);

  const dragging = useRef(false);

  const onDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e) => {
      if (!dragging.current) return;
      const newWidth = window.innerWidth - e.clientX;
      const clamped = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, newWidth));
      setSidebarWidth(clamped);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      setSidebarWidth((w) => {
        saveLayout({ sidebarWidth: w });
        return w;
      });
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const leftDragging = useRef(false);

  const onLeftDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    leftDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e) => {
      if (!leftDragging.current) return;
      const newWidth = e.clientX;
      const clamped = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, newWidth));
      setLeftSidebarWidth(clamped);
    };

    const onMouseUp = () => {
      leftDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      setLeftSidebarWidth((w) => {
        saveLayout({ leftSidebarWidth: w });
        return w;
      });
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <HighlightsProvider>
    <PlayerServicesProvider>
    <div
      className="app"
      style={{ gridTemplateColumns: rightSidebarEmpty ? `${leftSidebarWidth}px 4px 1fr` : `${leftSidebarWidth}px 4px 1fr 4px ${sidebarWidth}px` }}
    >
      <LeftSidebar exp={exp} streams={streams} pulseData={pulseData} send={send} />
      <div className="left-sidebar-divider" onMouseDown={onLeftDividerMouseDown} />
      <MainToolbar
        logStreams={logStreams}
        sendMessage={sendMessage}
        hiddenPanels={hiddenPanels}
        onTogglePanel={toggleHiddenPanel}
        scriptWindows={scriptWindows}
        onOpenHighlights={() => setHighlightsOpen(true)}
        onOpenPlayerServices={() => setPlayerServicesOpen(true)}
      />
      <GameText lines={gameLines} onClick={focusInput} />
      <Toolbar
        vitals={vitals}
        hands={hands}
        spell={spell}
        indicators={indicators}
        roundtime={roundtime}
        casttime={casttime}
        compass={compass}
        onMove={send}
      />
      <CommandInput onSend={send} inputRef={inputRef} insertTextRef={insertTextRef} addToHistoryRef={addToHistoryRef} navigateHistoryRef={navigateHistoryRef} />
      {!rightSidebarEmpty && <div className="sidebar-divider" onMouseDown={onDividerMouseDown} />}
      <RightSidebars
        room={room}
        exp={exp}
        streams={streams}
        activeSpells={activeSpells}
        compass={compass}
        scriptWindows={scriptWindows}
        onMove={send}
        mapZone={mapZone}
        mapCurrentNode={mapCurrentNode}
        mapLevel={mapLevel}
        hiddenPanels={hiddenPanels}
        inventory={inventory}
        roundtime={roundtime}
        send={send}
        addToHistoryRef={addToHistoryRef}
        onInsertText={handleInsertText}
        moons={moons}
        skyPeriod={skyPeriod}
        onEmptyChange={setRightSidebarEmpty}
      />
    </div>
    {highlightsOpen && <HighlightsModal onClose={() => setHighlightsOpen(false)} />}
    {playerServicesOpen && <PlayerServicesModal onClose={() => setPlayerServicesOpen(false)} />}
    </PlayerServicesProvider>
    </HighlightsProvider>
  );
}
