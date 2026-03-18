import React, { useState, useCallback, useRef, useEffect, memo } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import RoomPanel from "./RoomPanel";
import ExpTracker from "./ExpTracker";
import StreamPanel from "./StreamPanel";
import Compass from "./Compass";
import MapPanel from "./MapPanel";
import MoonPanel from "./MoonPanel";

const LAYOUT_KEY = "dr-client-layout";

const DEFAULT_PANEL_ORDER = ["room", "map", "moons", "spells", "arrivals"];
const DEFAULT_COLLAPSED = ["spells", "arrivals"];
const DEFAULT_PANEL_SIZES = {
  exp: 300,
  thoughts: 200,
  spells: 200,
  arrivals: 200,
  map: 300,
};

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

function SortablePanel({ id, title, open, onToggle, maxHeight, onResizeStart, children }) {
  const bodyRef = useRef(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className={`sidebar-panel ${open ? "open" : "collapsed"}`}>
      <div className="sidebar-panel-header" {...attributes} {...listeners} onClick={onToggle}>
        <span className="panel-toggle">{open ? "\u25BC" : "\u25B6"}</span>
        <span className="panel-title">{title}</span>
        <span className="drag-grip">:::</span>
      </div>
      {open && (
        <div
          ref={bodyRef}
          className="sidebar-panel-body"
          style={maxHeight ? { height: maxHeight, overflow: "auto" } : undefined}
        >
          {children}
        </div>
      )}
      {open && (
        <div
          className="panel-resize-handle"
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeStart(e, id, bodyRef.current);
          }}
        />
      )}
    </div>
  );
}

function ScriptWindowPanel({ lines }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="script-window-panel">
      <div className="script-window-content" ref={containerRef}>
        {lines.length === 0 ? (
          <div className="stream-empty">Empty</div>
        ) : (
          lines.map((text, i) => (
            <div
              key={i}
              className="script-window-line"
              dangerouslySetInnerHTML={{ __html: text }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function renderPanelContent(id, props) {
  switch (id) {
    case "room":
      return <RoomPanel room={props.room} />;
    case "compass":
      return <Compass compass={props.compass} onMove={props.onMove} />;
    case "map":
      return <MapPanel zone={props.mapZone} currentNode={props.mapCurrentNode} level={props.mapLevel} />;
    case "moons":
      return <MoonPanel moons={props.moons} />;
    case "exp":
      return <ExpTracker exp={props.exp} pulseData={props.pulseData} send={props.send} />;
    case "thoughts":
      return <StreamPanel title="Thoughts" lines={props.streams.thoughts || []} colorizeThoughts />;
    case "arrivals":
      return <StreamPanel title="Arrivals" lines={props.streams.logons || []} />;
    case "spells":
      return (
        <div className="active-spells-text">
          {props.activeSpells
            ? props.activeSpells.split("\n").map((line, i) => <div key={i}>{line}</div>)
            : "No active spells"}
        </div>
      );
    default:
      if (id.startsWith("script:")) {
        const name = id.slice(7);
        const win = props.scriptWindows?.[name];
        if (win) return <ScriptWindowPanel lines={win.lines} />;
        return <div className="stream-empty">Window closed</div>;
      }
      return null;
  }
}

function getPanelTitle(id, scriptWindows) {
  switch (id) {
    case "room": return "Room";
    case "compass": return "Compass";
    case "map": return "Map";
    case "moons": return "Moons";
    case "exp": return "Experience";
    case "thoughts": return "Thoughts";
    case "arrivals": return "Arrivals";
    case "spells": return "Active Spells";
    default:
      if (id.startsWith("script:")) {
        const name = id.slice(7);
        const win = scriptWindows?.[name];
        return win?.title || name;
      }
      return id;
  }
}

const LEFT_DEFAULT_PANEL_ORDER = ["exp", "thoughts"];
const LEFT_DEFAULT_COLLAPSED = ["thoughts"];
const LEFT_DEFAULT_PANEL_SIZES = {
  exp: 300,
  thoughts: 200,
};

export const LeftSidebar = memo(function LeftSidebar({ exp, streams, pulseData, send }) {
  const [panelOrder, setPanelOrder] = useState(() => {
    const layout = loadLayout();
    return layout.leftPanelOrder || LEFT_DEFAULT_PANEL_ORDER;
  });

  const [collapsedPanels, setCollapsedPanels] = useState(() => {
    const layout = loadLayout();
    return new Set(layout.leftCollapsedPanels || LEFT_DEFAULT_COLLAPSED);
  });

  const [panelSizes, setPanelSizes] = useState(() => {
    const layout = loadLayout();
    return layout.leftPanelSizes || LEFT_DEFAULT_PANEL_SIZES;
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = panelOrder.indexOf(active.id);
    const newIndex = panelOrder.indexOf(over.id);
    const newOrder = arrayMove(panelOrder, oldIndex, newIndex);
    setPanelOrder(newOrder);
    saveLayout({ leftPanelOrder: newOrder });
  }, [panelOrder]);

  const togglePanel = useCallback((id) => {
    setCollapsedPanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveLayout({ leftCollapsedPanels: [...next] });
      return next;
    });
  }, []);

  const onResizeStart = useCallback((e, panelId, bodyEl) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = bodyEl ? bodyEl.offsetHeight : (panelSizes[panelId] || 200);

    const onMouseMove = (e) => {
      const delta = e.clientY - startY;
      const newHeight = Math.max(50, startHeight + delta);
      setPanelSizes((prev) => ({ ...prev, [panelId]: newHeight }));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setPanelSizes((prev) => {
        saveLayout({ leftPanelSizes: prev });
        return prev;
      });
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [panelSizes]);

  const contentProps = { exp, streams, pulseData, send };

  return (
    <div className="left-sidebar">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={panelOrder} strategy={verticalListSortingStrategy}>
          {panelOrder.map((id) => (
            <SortablePanel
              key={id}
              id={id}
              title={getPanelTitle(id)}
              open={!collapsedPanels.has(id)}
              onToggle={() => togglePanel(id)}
              maxHeight={panelSizes[id]}
              onResizeStart={onResizeStart}
            >
              {renderPanelContent(id, contentProps)}
            </SortablePanel>
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
});

const Sidebar = memo(function Sidebar({ room, exp, streams, activeSpells, compass, scriptWindows, onMove, mapZone, mapCurrentNode, mapLevel, moons }) {
  const [panelOrder, setPanelOrder] = useState(() => {
    const layout = loadLayout();
    if (!layout.panelOrder) return DEFAULT_PANEL_ORDER;
    // Ensure new built-in panels are present in saved order
    const saved = [...layout.panelOrder];
    for (const id of DEFAULT_PANEL_ORDER) {
      if (!saved.includes(id)) {
        const idx = DEFAULT_PANEL_ORDER.indexOf(id);
        saved.splice(idx, 0, id);
      }
    }
    return saved;
  });

  const [collapsedPanels, setCollapsedPanels] = useState(() => {
    const layout = loadLayout();
    return new Set(layout.collapsedPanels || DEFAULT_COLLAPSED);
  });

  const [panelSizes, setPanelSizes] = useState(() => {
    const layout = loadLayout();
    return layout.panelSizes || DEFAULT_PANEL_SIZES;
  });

  // Integrate script windows into panel order
  const scriptIds = Object.keys(scriptWindows || {}).map((n) => `script:${n}`);
  const allPanelIds = React.useMemo(() => {
    const ordered = [...panelOrder];
    // Add any script windows not already in the order
    for (const sid of scriptIds) {
      if (!ordered.includes(sid)) ordered.push(sid);
    }
    // Remove script panels whose windows no longer exist
    return ordered.filter(
      (id) => !id.startsWith("script:") || scriptIds.includes(id)
    );
  }, [panelOrder, scriptIds.join(",")]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = allPanelIds.indexOf(active.id);
    const newIndex = allPanelIds.indexOf(over.id);
    const newOrder = arrayMove(allPanelIds, oldIndex, newIndex);
    setPanelOrder(newOrder);
    saveLayout({ panelOrder: newOrder });
  }, [allPanelIds]);

  const togglePanel = useCallback((id) => {
    setCollapsedPanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveLayout({ collapsedPanels: [...next] });
      return next;
    });
  }, []);

  const onResizeStart = useCallback((e, panelId, bodyEl) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = bodyEl ? bodyEl.offsetHeight : (panelSizes[panelId] || 200);

    const onMouseMove = (e) => {
      const delta = e.clientY - startY;
      const newHeight = Math.max(50, startHeight + delta);
      setPanelSizes((prev) => ({ ...prev, [panelId]: newHeight }));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setPanelSizes((prev) => {
        saveLayout({ panelSizes: prev });
        return prev;
      });
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [panelSizes]);

  const contentProps = { room, exp, streams, activeSpells, compass, scriptWindows, onMove, mapZone, mapCurrentNode, mapLevel, moons };

  return (
    <div className="sidebar">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={allPanelIds} strategy={verticalListSortingStrategy}>
          {allPanelIds.map((id) => (
            <SortablePanel
              key={id}
              id={id}
              title={getPanelTitle(id, scriptWindows)}
              open={!collapsedPanels.has(id)}
              onToggle={() => togglePanel(id)}
              maxHeight={panelSizes[id] || (id.startsWith("script:") ? 200 : undefined)}
              onResizeStart={onResizeStart}
            >
              {renderPanelContent(id, contentProps)}
            </SortablePanel>
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
});

export default Sidebar;
