import React from "react";
import katambaImg from "../images/Katamba.png";
import yavashImg from "../images/Yavash.png";
import xibarImg from "../images/Xibar.png";

const MOON_NAMES = ["katamba", "yavash", "xibar"];
const MOON_IMAGES = { katamba: katambaImg, yavash: yavashImg, xibar: xibarImg };

// Minutes from a transition at which a moon is considered "on the horizon"
const HORIZON_THRESHOLD = 30;

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

export default function MoonPanel({ moons }) {
  return (
    <div className="moon-panel">
      <div className="moon-images">
        {MOON_NAMES.map((name) => {
          const phase = moonPhase(moons?.[name]);
          return (
            <div key={name} className="moon-image-slot">
              <img
                src={MOON_IMAGES[name]}
                alt={capitalize(name)}
                className={`moon-image moon-image--${phase}`}
              />
            </div>
          );
        })}
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
