const PRESETS_KEY = "dr-layout-presets";
const LAYOUT_KEY = "dr-client-layout";

export function loadPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY)) || {}; } catch { return {}; }
}

export function savePreset(name) {
  try {
    const layout = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {};
    const presets = loadPresets();
    presets[name] = layout;
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {}
}

export function applyPreset(name) {
  try {
    const presets = loadPresets();
    const layout = presets[name];
    if (!layout) return false;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    window.dispatchEvent(new Event("layout:load"));
    return true;
  } catch { return false; }
}

export function deletePreset(name) {
  try {
    const presets = loadPresets();
    delete presets[name];
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {}
}
