import React, { useState, useCallback, useRef, useMemo, memo } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
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
import MapPanel from "./MapPanel";
import InventoryPanel from "./InventoryPanel";
import MoonPanel from "./MoonPanel";

const LAYOUT_KEY = "dr-client-layout";
const DEFAULT_S1_PANELS = ["room", "map", "moons", "spells", "arrivals", "inventory"];
const DEFAULT_S2_PANELS = [];
const DEFAULT_COLLAPSED = ["spells", "arrivals"];
const DEFAULT_PANEL_SIZES = { map: 300, spells: 200, arrivals: 200, inventory: 300 };
const DEFAULT_S2_WIDTH = 220;
const MIN_COL_WIDTH = 150;
const MAX_COL_WIDTH = 800;

function loadLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { return {}; }
}
function saveLayout(updates) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...loadLayout(), ...updates })); } catch {}
}

// ── Panel content renderers ────────────────────────────────────────────────

function ScriptWindowPanel({ lines }) {
  const containerRef = useRef(null);
  React.useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [lines]);
  return (
    <div className="script-window-panel">
      <div className="script-window-content" ref={containerRef}>
        {lines.length === 0
          ? <div className="stream-empty">Empty</div>
          : lines.map((text, i) => (
            <div key={i} className="script-window-line" dangerouslySetInnerHTML={{ __html: text }} />
          ))
        }
      </div>
    </div>
  );
}

function renderPanelContent(id, props) {
  switch (id) {
    case "room":      return <RoomPanel room={props.room} onInsertText={props.onInsertText} send={props.send} addToHistoryRef={props.addToHistoryRef} />;
    case "map":       return <MapPanel zone={props.mapZone} currentNode={props.mapCurrentNode} level={props.mapLevel} />;
    case "moons":     return <MoonPanel moons={props.moons} skyPeriod={props.skyPeriod} />;
    case "exp":       return <ExpTracker exp={props.exp} send={props.send} />;
    case "thoughts":  return <StreamPanel title="Thoughts" lines={props.streams.thoughts || []} colorizeThoughts />;
    case "arrivals":  return <StreamPanel title="Arrivals" lines={props.streams.logons || []} />;
    case "inventory": return <InventoryPanel inventory={props.inventory} roundtime={props.roundtime} send={props.send} />;
    case "spells":    return (
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
        return win ? <ScriptWindowPanel lines={win.lines} /> : <div className="stream-empty">Window closed</div>;
      }
      return null;
  }
}

function getPanelTitle(id, scriptWindows) {
  switch (id) {
    case "room":      return "Room";
    case "map":       return "Map";
    case "moons":     return "Moons";
    case "exp":       return "Experience";
    case "thoughts":  return "Thoughts";
    case "arrivals":  return "Arrivals";
    case "spells":    return "Active Spells";
    case "inventory": return "Inventory";
    default:
      if (id.startsWith("script:")) {
        const name = id.slice(7);
        return scriptWindows?.[name]?.title || name;
      }
      return id;
  }
}

// ── SortablePanel ──────────────────────────────────────────────────────────

function SortablePanel({ id, title, open, onToggle, maxHeight, onResizeStart, children }) {
  const bodyRef = useRef(null);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
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
          onMouseDown={(e) => { e.stopPropagation(); onResizeStart(e, id, bodyRef.current); }}
        />
      )}
    </div>
  );
}

// ── SidebarColumn ──────────────────────────────────────────────────────────
// A single panel column. Uses useDroppable so items can be dropped onto an
// empty column (when there are no SortableContext items to land on).

function SidebarColumn({ columnId, panelIds, collapsedPanels, panelSizes, onToggle, onResizeStart, contentProps, style }) {
  const { setNodeRef } = useDroppable({ id: columnId });
  return (
    <div ref={setNodeRef} className="sidebar-column" style={style}>
      <SortableContext id={columnId} items={panelIds} strategy={verticalListSortingStrategy}>
        {panelIds.length === 0 ? (
          <div className="sidebar-column-empty">Drop panels here</div>
        ) : (
          panelIds.map((id) => (
            <SortablePanel
              key={id}
              id={id}
              title={getPanelTitle(id, contentProps.scriptWindows)}
              open={!collapsedPanels.has(id)}
              onToggle={() => onToggle(id)}
              maxHeight={panelSizes[id]}
              onResizeStart={onResizeStart}
            >
              {renderPanelContent(id, contentProps)}
            </SortablePanel>
          ))
        )}
      </SortableContext>
    </div>
  );
}

// ── RightSidebars ──────────────────────────────────────────────────────────
// Hosts two sidebar columns with a shared DndContext so panels can be dragged
// between them. s2 is the inner column (left, closer to game text); s1 is the
// outer column (right, the original sidebar). s2 starts empty by default.

const RightSidebars = memo(function RightSidebars({
  room, exp, streams, activeSpells, compass, scriptWindows,
  onMove, mapZone, mapCurrentNode, mapLevel, hiddenPanels = new Set(),
  inventory, roundtime, send, addToHistoryRef, onInsertText, moons, skyPeriod,
}) {
  // s1 = outer (original) sidebar. Reads legacy panelOrder key for back-compat.
  const [s1Panels, setS1Panels] = useState(() => {
    const layout = loadLayout();
    const s2 = layout.sidebar2PanelOrder || DEFAULT_S2_PANELS;
    if (!layout.panelOrder) return DEFAULT_S1_PANELS.filter((id) => !s2.includes(id));
    const saved = [...layout.panelOrder];
    for (const id of DEFAULT_S1_PANELS) {
      // Only re-insert defaults that are missing from both columns.
      if (!saved.includes(id) && !s2.includes(id)) saved.splice(DEFAULT_S1_PANELS.indexOf(id), 0, id);
    }
    return saved;
  });

  // s2 = inner (new) sidebar.
  const [s2Panels, setS2Panels] = useState(() => loadLayout().sidebar2PanelOrder || DEFAULT_S2_PANELS);

  const [collapsedPanels, setCollapsedPanels] = useState(() => {
    return new Set(loadLayout().collapsedPanels || DEFAULT_COLLAPSED);
  });

  const [panelSizes, setPanelSizes] = useState(() => loadLayout().panelSizes || DEFAULT_PANEL_SIZES);

  // Width of the inner (s2) column in pixels. s1 takes remaining flex space.
  const [s2Width, setS2Width] = useState(() => loadLayout().innerSidebarWidth || DEFAULT_S2_WIDTH);

  const containerRef = useRef(null);

  // ── Script window panels ─────────────────────────────────────────────────
  const scriptIds = useMemo(
    () => Object.keys(scriptWindows || {}).map((n) => `script:${n}`),
    [scriptWindows]
  );

  // New script windows (not yet in either column) default to s1.
  const allS1Panels = useMemo(() => {
    const ordered = [...s1Panels];
    for (const sid of scriptIds) {
      if (!ordered.includes(sid) && !s2Panels.includes(sid)) ordered.push(sid);
    }
    return ordered
      .filter((id) => !id.startsWith("script:") || scriptIds.includes(id))
      .filter((id) => !hiddenPanels.has(id));
  }, [s1Panels, s2Panels, scriptIds, hiddenPanels]);

  const allS2Panels = useMemo(() => {
    return s2Panels
      .filter((id) => !id.startsWith("script:") || scriptIds.includes(id))
      .filter((id) => !hiddenPanels.has(id));
  }, [s2Panels, scriptIds, hiddenPanels]);

  // ── DnD ─────────────────────────────────────────────────────────────────
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const [activeId, setActiveId] = useState(null);

  const handleDragStart = useCallback(({ active }) => {
    setActiveId(active.id);
  }, []);

  const handleDragEnd = useCallback(({ active, over }) => {
    setActiveId(null);
    if (!over || active.id === over.id) return;

    // containerId comes from SortableContext when dropping on a panel;
    // falls back to over.id when dropping on the useDroppable container itself.
    const activeContainerId = active.data.current?.sortable?.containerId;
    const overContainerId = over.data.current?.sortable?.containerId ?? over.id;

    if (!activeContainerId || !overContainerId) return;

    if (activeContainerId === overContainerId) {
      // Same column — reorder.
      const panels = activeContainerId === "s1" ? allS1Panels : allS2Panels;
      const oldIdx = panels.indexOf(active.id);
      const newIdx = panels.indexOf(over.id);
      if (oldIdx === -1 || newIdx === -1) return;
      const reordered = arrayMove(panels, oldIdx, newIdx);
      if (activeContainerId === "s1") {
        setS1Panels(reordered); saveLayout({ panelOrder: reordered });
      } else {
        setS2Panels(reordered); saveLayout({ sidebar2PanelOrder: reordered });
      }
    } else {
      // Cross-column — move active panel into the other column.
      const fromS1 = activeContainerId === "s1";
      const srcAll = fromS1 ? allS1Panels : allS2Panels;
      const dstAll = fromS1 ? allS2Panels : allS1Panels;

      const overIdx = dstAll.indexOf(over.id);
      const insertAt = overIdx >= 0 ? overIdx : dstAll.length;
      const newDst = [...dstAll.slice(0, insertAt), active.id, ...dstAll.slice(insertAt)];
      const newSrc = srcAll.filter((id) => id !== active.id);

      if (fromS1) {
        setS1Panels(newSrc); setS2Panels(newDst);
        saveLayout({ panelOrder: newSrc, sidebar2PanelOrder: newDst });
      } else {
        setS2Panels(newSrc); setS1Panels(newDst);
        saveLayout({ sidebar2PanelOrder: newSrc, panelOrder: newDst });
      }
    }
  }, [allS1Panels, allS2Panels]);

  // ── Panel interactions ───────────────────────────────────────────────────
  const togglePanel = useCallback((id) => {
    setCollapsedPanels((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveLayout({ collapsedPanels: [...next] });
      return next;
    });
  }, []);

  const onResizeStart = useCallback((e, panelId, bodyEl) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = bodyEl ? bodyEl.offsetHeight : (panelSizes[panelId] || 200);
    const onMove = (e) => setPanelSizes((prev) => ({ ...prev, [panelId]: Math.max(50, startH + e.clientY - startY) }));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setPanelSizes((prev) => { saveLayout({ panelSizes: prev }); return prev; });
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [panelSizes]);

  // ── Inner divider drag ───────────────────────────────────────────────────
  const onDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    const container = containerRef.current;
    const onMove = (e) => {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setS2Width(Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, e.clientX - rect.left)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setS2Width((w) => { saveLayout({ innerSidebarWidth: w }); return w; });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  const contentProps = { room, exp, streams, activeSpells, compass, scriptWindows, onMove, mapZone, mapCurrentNode, mapLevel, inventory, roundtime, send, addToHistoryRef, onInsertText, moons, skyPeriod };

  return (
    <div ref={containerRef} className="right-sidebars">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <SidebarColumn
          columnId="s2"
          panelIds={allS2Panels}
          collapsedPanels={collapsedPanels}
          panelSizes={panelSizes}
          onToggle={togglePanel}
          onResizeStart={onResizeStart}
          contentProps={contentProps}
          style={{ flex: `0 0 ${s2Width}px` }}
        />
        <div className="inner-sidebar-divider" onMouseDown={onDividerMouseDown} />
        <SidebarColumn
          columnId="s1"
          panelIds={allS1Panels}
          collapsedPanels={collapsedPanels}
          panelSizes={panelSizes}
          onToggle={togglePanel}
          onResizeStart={onResizeStart}
          contentProps={contentProps}
          style={{ flex: "1 1 0", minWidth: MIN_COL_WIDTH }}
        />
        <DragOverlay>
          {activeId ? (
            <div className="sidebar-panel open drag-overlay-panel">
              <div className="sidebar-panel-header">
                <span className="panel-toggle">&#x25BC;</span>
                <span className="panel-title">{getPanelTitle(activeId, contentProps.scriptWindows)}</span>
                <span className="drag-grip">:::</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
});

export default RightSidebars;
