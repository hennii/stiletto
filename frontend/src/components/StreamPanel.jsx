import React, { useRef, useEffect } from "react";
import { useHighlights } from "../context/HighlightsContext";
import { applyHighlights } from "../utils/applyHighlights";

// LNet: [Channel]-Game:Player: "message"
const LNET_RE = /^(\[[^\]]+\]-[^:]+:[^:]+:)\s*(.*)/;
// ESP gwethdesuan: [Channel][Player] "message"
const ESP_RE = /^(\[[^\]]+\]\[[^\]]+\])\s*(.*)/;
// ESP Thoughtcast: [Channel] Your mind hears Player thinking, "message"
const ESP_MIND_RE = /^(\[[^\]]+\])\s+Your mind hears (\S+) thinking,\s*(.*)/;

function formatTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m} ${ampm}`;
}

function HighlightedText({ text, highlights }) {
  const parts = applyHighlights(text, highlights);
  if (!parts) return text;
  return parts.map((p, i) =>
    p.color
      ? <span key={i} style={{ color: p.color }}>{p.text}</span>
      : <React.Fragment key={i}>{p.text}</React.Fragment>
  );
}

function ThoughtLine({ text, ts, highlights }) {
  let match;
  const time = formatTime(ts);
  const timestamp = time ? <span className="thought-timestamp"> [{time}]</span> : null;
  if ((match = text.match(LNET_RE))) {
    return (
      <>
        <span className="thought-lnet-prefix"><HighlightedText text={match[1]} highlights={highlights} /></span>{" "}
        <HighlightedText text={match[2]} highlights={highlights} />{timestamp}
      </>
    );
  }
  if ((match = text.match(ESP_RE))) {
    return (
      <>
        <span className="thought-esp-prefix"><HighlightedText text={match[1]} highlights={highlights} /></span>{" "}
        <HighlightedText text={match[2]} highlights={highlights} />{timestamp}
      </>
    );
  }
  if ((match = text.match(ESP_MIND_RE))) {
    const prefix = `${match[1]}[${match[2]}]`;
    return (
      <>
        <span className="thought-esp-prefix"><HighlightedText text={prefix} highlights={highlights} /></span>{" "}
        <HighlightedText text={match[3]} highlights={highlights} />{timestamp}
      </>
    );
  }
  return <><HighlightedText text={text} highlights={highlights} />{timestamp}</>;
}

export default function StreamPanel({ title, lines, colorizeThoughts }) {
  const innerRef = useRef(null);
  const scrollElRef = useRef(null);
  const autoScroll = useRef(true);
  const { highlights } = useHighlights();

  // Find the scroll container (the .sidebar-panel-body parent) and listen for user scrolls
  useEffect(() => {
    const scrollEl = innerRef.current?.closest(".sidebar-panel-body");
    scrollElRef.current = scrollEl;
    if (!scrollEl) return;

    const onScroll = () => {
      autoScroll.current =
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 30;
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, []);

  // When lines change, scroll to bottom if we were already there
  useEffect(() => {
    const el = scrollElRef.current;
    if (autoScroll.current && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="stream-panel" ref={innerRef}>
      <div className="stream-content">
        {(!lines || lines.length === 0) ? (
          <div className="stream-empty">No {title.toLowerCase()} yet</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="stream-line">
              {colorizeThoughts
                ? <ThoughtLine text={line.text} ts={line.ts} highlights={highlights} />
                : <HighlightedText text={line.text} highlights={highlights} />}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
