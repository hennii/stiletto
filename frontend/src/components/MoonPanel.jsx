import React from "react";

const MOON_NAMES = ["katamba", "yavash", "xibar"];

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
      {MOON_NAMES.map((name) => (
        <div key={name} className="moon-line">
          {moonLine(name, moons?.[name])}
        </div>
      ))}
    </div>
  );
}
