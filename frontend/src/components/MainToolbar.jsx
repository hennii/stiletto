import React, { useState, useEffect, useRef, useCallback } from "react";
import LogToggle from "./LogToggle";
import { loadPresets, savePreset, applyPreset, deletePreset } from "../utils/layoutPresets";

const STATIC_PANELS = [
  { id: "room",    label: "Room" },
  { id: "map",     label: "Map" },
  { id: "exp",     label: "Experience" },
  { id: "thoughts",label: "Thoughts" },
  { id: "arrivals",label: "Arrivals" },
  { id: "spells",  label: "Active Spells" },
];

function PanelToggle({ hiddenPanels, onTogglePanel, scriptWindows }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const scriptPanels = Object.entries(scriptWindows || {}).map(([name, win]) => ({
    id: `script:${name}`,
    label: win.title || name,
  }));

  const allPanels = [...STATIC_PANELS, ...scriptPanels];

  return (
    <div className="toolbar-dropdown" ref={ref}>
      <button className="toolbar-dropdown-btn" onClick={() => setOpen(!open)} title="Toggle panels">
        Panels
      </button>
      {open && (
        <div className="toolbar-dropdown-menu">
          {allPanels.map(({ id, label }) => (
            <label key={id} className="toolbar-dropdown-item">
              <input
                type="checkbox"
                checked={!hiddenPanels.has(id)}
                onChange={() => onTogglePanel(id)}
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function SaveLayoutModal({ onSave, onClose }) {
  const [name, setName] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") onClose();
  };

  const submit = () => {
    if (!name.trim()) return;
    onSave(name.trim());
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal layout-save-modal">
        <div className="modal-header">
          <span className="modal-title">Save Layout</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="layout-save-form">
          <input
            ref={inputRef}
            className="highlights-add-input"
            placeholder="Layout name (e.g. Desktop, Laptop)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="highlights-add-btn" onClick={submit} disabled={!name.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function LayoutsDropdown() {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [presets, setPresets] = useState(() => loadPresets());
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSaveClick = () => {
    setOpen(false);
    setSaving(true);
  };

  const handleSaveConfirm = useCallback((name) => {
    savePreset(name);
    setPresets(loadPresets());
    setSaving(false);
  }, []);

  const handleLoad = (name) => {
    applyPreset(name);
    setOpen(false);
  };

  const handleDelete = (name) => {
    deletePreset(name);
    setPresets(loadPresets());
  };

  const names = Object.keys(presets);

  return (
    <>
      <div className="toolbar-dropdown" ref={ref}>
        <button className="toolbar-dropdown-btn" onClick={() => setOpen(!open)} title="Save and load layouts">
          Layouts
        </button>
        {open && (
          <div className="toolbar-dropdown-menu">
            <button className="toolbar-dropdown-item layout-save-btn" onClick={handleSaveClick}>
              Save current as...
            </button>
            {names.length > 0 && <div className="toolbar-dropdown-separator" />}
            {names.map((name) => (
              <div key={name} className="toolbar-dropdown-item layout-preset-row">
                <span className="layout-preset-name">{name}</span>
                <div className="layout-preset-actions">
                  <button className="layout-preset-btn" onClick={() => handleLoad(name)}>Load</button>
                  <button className="layout-preset-btn layout-preset-delete" onClick={() => handleDelete(name)}>×</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {saving && <SaveLayoutModal onSave={handleSaveConfirm} onClose={() => setSaving(false)} />}
    </>
  );
}

export default function MainToolbar({ logStreams, sendMessage, hiddenPanels, onTogglePanel, scriptWindows, onOpenHighlights, onOpenPlayerServices }) {
  return (
    <div className="main-toolbar">
      <PanelToggle hiddenPanels={hiddenPanels} onTogglePanel={onTogglePanel} scriptWindows={scriptWindows} />
      <LayoutsDropdown />
      <LogToggle logStreams={logStreams} sendMessage={sendMessage} />
      <button className="toolbar-dropdown-btn" onClick={onOpenHighlights} title="Text highlights">
        Highlights
      </button>
      <button className="toolbar-dropdown-btn" onClick={onOpenPlayerServices} title="Configure player context menu actions">
        PC Actions
      </button>
    </div>
  );
}
