import React, { useState, useEffect, useRef } from "react";
import katambaImg from "../images/Katamba.png";
import yavashImg from "../images/Yavash.png";
import xibarImg from "../images/Xibar.png";

const MOON_NAMES = ["yavash", "katamba", "xibar"];
const MOON_IMAGES = { katamba: katambaImg, yavash: yavashImg, xibar: xibarImg };

// Minutes from a transition at which a moon is considered "on the horizon"
const HORIZON_THRESHOLD = 30;

// Sky crossfade duration in ms
const SKY_FADE_MS = 45000;

function moonPhase(data) {
  if (!data || data.up === null || data.up === undefined) return "unknown";
  const nearTransition = data.minutes_until !== null && data.minutes_until <= HORIZON_THRESHOLD;
  if (data.up) return nearTransition ? "setting" : "up";
  return nearTransition ? "rising" : "down";
}

function moonLine(name, data) {
  if (!data || data.up === null || data.up === undefined) {
    return `${capitalize(name)} status unknown`;
  }
  const mins = data.minutes_until;
  if (data.up) {
    return `${capitalize(name)} is up for ${mins} minute${mins === 1 ? "" : "s"}`;
  } else {
    return `${capitalize(name)} will rise in ${mins} minute${mins === 1 ? "" : "s"}`;
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Mounts at its initial opacity, then transitions to the target opacity on the next paint.
function SkyLayer({ period, initialOpacity, targetOpacity }) {
  const [opacity, setOpacity] = useState(initialOpacity);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpacity(targetOpacity));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`moon-sky moon-sky--${period}`}
      style={{ opacity, transition: `opacity ${SKY_FADE_MS}ms ease` }}
    />
  );
}

export default function MoonPanel({ moons, skyPeriod }) {
  const period = skyPeriod || "night";
  const [curPeriod, setCurPeriod] = useState(period);
  const [leavingPeriod, setLeavingPeriod] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (period === curPeriod) return;
    setLeavingPeriod(curPeriod);
    setCurPeriod(period);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setLeavingPeriod(null), SKY_FADE_MS + 500);
  }, [period]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div className="moon-panel">
      <div className="moon-images">
        {/* New sky fades in beneath */}
        <SkyLayer key={`${curPeriod}-in`} period={curPeriod} initialOpacity={0} targetOpacity={1} />
        {/* Old sky fades out on top */}
        {leavingPeriod && (
          <SkyLayer key={`${leavingPeriod}-out`} period={leavingPeriod} initialOpacity={1} targetOpacity={0} />
        )}
        {MOON_NAMES.map((name) => {
          const data = moons?.[name];
          const phase = moonPhase(data);
          const mins = data?.minutes_until;

          let horizonStyle;
          if (phase === "rising" && mins != null) {
            const t = mins / HORIZON_THRESHOLD;
            const pct = t * t * t * 100;
            horizonStyle = { transform: `translateX(-50%) translateY(${pct}%)` };
          } else if (phase === "setting" && mins != null) {
            const t = (HORIZON_THRESHOLD - mins) / HORIZON_THRESHOLD;
            const pct = t * t * t * 100;
            horizonStyle = { transform: `translateX(-50%) translateY(${pct}%)` };
          }

          return (
            <div key={name} className="moon-image-slot">
              <img
                src={MOON_IMAGES[name]}
                alt={capitalize(name)}
                className={`moon-image moon-image-${name} moon-image--${phase}`}
                style={horizonStyle}
              />
            </div>
          );
        })}
        {curPeriod === "day" && <div className="moon-clouds" />}
      </div>
      <div className="moon-status">
        {MOON_NAMES.map((name) => (
          <div key={name} className="moon-line">
            {moonLine(name, moons?.[name])}
          </div>
        ))}
      </div>
    </div>
  );
}
