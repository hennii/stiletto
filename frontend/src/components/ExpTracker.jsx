import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";

const LEARNING_COLORS = {
  "clear": "#666666",        //  0 - gray
  "dabbling": "#777768",     //  1
  "perusing": "#88886a",     //  2
  "learning": "#99996c",     //  3
  "thoughtful": "#aaaa6e",   //  4
  "thinking": "#bbbb70",     //  5
  "considering": "#c4bc60",  //  6
  "pondering": "#ccbc50",    //  7
  "ruminating": "#d4bc40",   //  8
  "concentrating": "#dcbc30",//  9
  "attentive": "#e4c020",    // 10
  "deliberative": "#e8c410", // 11
  "interested": "#ecc800",   // 12 - peak yellow
  "examining": "#e4c800",    // 13
  "understanding": "#dcca00",// 14
  "absorbing": "#d0cc00",    // 15
  "intrigued": "#c4ce00",    // 16
  "scrutinizing": "#b4d000", // 17
  "analyzing": "#a4d200",    // 18
  "studious": "#94d400",     // 19
  "focused": "#84d800",      // 20
  "very focused": "#78dc00", // 21
  "engaged": "#6ce000",      // 22
  "very engaged": "#60e400", // 23
  "cogitating": "#54e800",   // 24
  "fascinated": "#4cec00",   // 25
  "captivated": "#44f000",   // 26
  "engrossed": "#40f200",    // 27
  "riveted": "#3cf400",      // 28
  "very riveted": "#38f600", // 29
  "rapt": "#34f800",         // 30
  "very rapt": "#32fa00",    // 31
  "enthralled": "#31fc00",   // 32
  "nearly locked": "#30fe00",// 33
  "mind lock": "#2fff00",    // 34 - bright green
};

const fullyAsleepMsg = "Asleep and storing rested experience."

const MINDSTATE_NUM = Object.fromEntries(
  Object.keys(LEARNING_COLORS).map((key, i) => [key, i])
);
const MINDSTATE_MAX = Object.keys(LEARNING_COLORS).length - 1;

function learningColor(state) {
  if (!state) return "#666666";
  return LEARNING_COLORS[state.toLowerCase()] || "#999999";
}

function mindstateLabel(state) {
  if (!state) return "-";
  const num = MINDSTATE_NUM[state.toLowerCase()];
  return num != null ? `${num}/${MINDSTATE_MAX}` : state;
}

function parseRestedExp(str) {
  const match = str.match(
    /Rested EXP Stored:\s*(.+?)\s+Usable This Cycle:\s*(.+?)\s+Cycle Refreshes:\s*(.+)$/
  );

  if (!match) return null;

  return {
    rexp: match[1],
    usable: match[2],
    refreshes: match[3]
  };
}

function parseSleep(str) {
  if (/You are relaxed/.test(str)) {
    return "Asleep and draining experience."
  } else if (/You are fully relaxed/.test(str)) {
    return fullyAsleepMsg;
  } else {
    return "Awake and earning experience."
  }
}

function toMinutes(str) {
  str = str.toLowerCase().trim();

  // Format like "4:33 hour"
  const hourColonMatch = str.match(/^(\d+):(\d+)\s*hour/);
  if (hourColonMatch) {
    const hours = parseInt(hourColonMatch[1], 10);
    const minutes = parseInt(hourColonMatch[2], 10);
    return hours * 60 + minutes;
  }

  // Format like "22 minute"
  const minutesMatch = str.match(/^(\d+)\s*minute/);
  if (minutesMatch) {
    return parseInt(minutesMatch[1], 10);
  }

  // Format like "4 hours"
  const hoursMatch = str.match(/^(\d+)\s*hour/);
  if (hoursMatch) {
    return parseInt(hoursMatch[1], 10) * 60;
  }

  if (/less than a minute/.test(str)) return 0;
  if (/none/.test(str)) return 0;

  throw new Error("Invalid time format");
}

function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')} hours`;
  }

  return `${minutes} minutes`;
}

function formatFutureTime(minutesToAdd) {
  const now = new Date();
  const future = new Date(now);
  future.setMinutes(future.getMinutes() + minutesToAdd);

  const timeString = future.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  const isTomorrow =
    future.getDate() !== now.getDate() ||
    future.getMonth() !== now.getMonth() ||
    future.getFullYear() !== now.getFullYear();

  return `${timeString} ${isTomorrow ? "tomorrow" : "today"}`;
}

const BASELINE_KEY = 'dr-exp-baseline';
const LAST_KNOWN_KEY = 'dr-exp-last-known';

function loadBaseline() {
  try { return JSON.parse(localStorage.getItem(BASELINE_KEY)); } catch { return null; }
}

function saveBaseline(b) {
  try { localStorage.setItem(BASELINE_KEY, JSON.stringify(b)); } catch {}
}

function loadLastKnown() {
  try { return JSON.parse(localStorage.getItem(LAST_KNOWN_KEY)) || {}; } catch { return {}; }
}

function saveLastKnown(lk) {
  try { localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify(lk)); } catch {}
}

function formatLearningTime(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

const SKILLSETS = {
  "Guild":    ["Astrology", "Bardic Lore", "Backstab", "Butcher's Eye", "Conviction", "Empathy", "Expertise", "Inner Magic", "Lunar Magic", "Scouting", "Summoning", "Thanatology", "Theurgy"],
  "Armor":    ["Shield Usage", "Light Armor", "Chain Armor", "Brigandine", "Plate Armor", "Defending"],
  "Weapons":  ["Parry Ability", "Small Edged", "Large Edged", "Twohanded Edged", "Small Blunt", "Large Blunt", "Twohanded Blunt", "Polearms", "Staves", "Bows", "Crossbows", "Slings", "Light Thrown", "Heavy Thrown", "Brawling", "Offhand Weapon", "Melee Mastery", "Missile Mastery"],
  "Magic":    ["Primary Magic", "Arcana", "Attunement", "Augmentation", "Debilitation", "Targeted Magic", "Utility", "Warding", "Sorcery"],
  "Survival": ["Evasion", "Athletics", "Perception", "Stealth", "Locksmithing", "Thievery", "First Aid", "Outdoorsmanship", "Skinning"],
  "Lore":     ["Alchemy", "Appraisal", "Enchanting", "Engineering", "Forging", "Outfitting", "Performance", "Scholarship", "Tactics"],
};

const SKILL_TO_SKILLSET = Object.fromEntries(
  Object.entries(SKILLSETS).flatMap(([set, skills]) => skills.map(s => [s, set]))
);

function groupBySkillset(entries) {
  const groups = {};
  for (const [skill, data] of entries) {
    const set = SKILL_TO_SKILLSET[skill] || "Other";
    (groups[set] ||= []).push([skill, data]);
  }
  // Return in canonical order, Other last
  const order = [...Object.keys(SKILLSETS), "Other"];
  return order.filter(s => groups[s]).map(s => [s, groups[s]]);
}

function formatTimeToClear(lastMindstate, drainFraction) {
  if (lastMindstate == null || !drainFraction) return '--';
  if (lastMindstate === 0) return '-';
  const levelsPerPulse = drainFraction * 34;
  const seconds = Math.ceil(lastMindstate / levelsPerPulse) * 200;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m`;
}


export default function ExpTracker({ exp, pulseData = {}, send }) {
  const [activeTab, setActiveTab] = useState('current');
  const [baseline, setBaseline] = useState(() => loadBaseline());
  const [resetting, setResetting] = useState(false);
  const didAutoInit = useRef(false);
  const learningHoursRef = useRef(0);
  const lastLearningHoursUpdate = useRef(0);
  const resetTimerRef = useRef(null);
  const skillsRef = useRef(null);
  const lastKnownRef = useRef(null);

  const skills = useMemo(() => {
    return Object.entries(exp)
      .filter(([, data]) => data.rank != null)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [exp]);
  skillsRef.current = skills;
  if (lastKnownRef.current === null) lastKnownRef.current = loadLastKnown();
  let lkDirty = false;
  skills.forEach(([name, data]) => {
    const existing = lastKnownRef.current[name];
    if (!existing || existing.rank !== data.rank || existing.percent !== data.percent) {
      lastKnownRef.current[name] = data;
      lkDirty = true;
    }
  });
  if (lkDirty) saveLastKnown(lastKnownRef.current);

  const summaryData = useMemo(() => {
    return exp.rexp ? parseRestedExp(exp.rexp.text) : null;
  }, [exp.rexp]);

  const rexpCalc = useMemo(() => {
    if (!summaryData) return null;
    const rexpMinutes = toMinutes(summaryData.rexp);
    const usableMinutes = toMinutes(summaryData.usable);
    const duration = rexpMinutes > 0 && usableMinutes > 0
      ? Math.min(rexpMinutes, usableMinutes)
      : 0;
    return {
      duration,
      durationMsg: formatMinutes(duration),
      endTime: duration > 0 ? formatFutureTime(duration) : null,
      storedAndWaiting: rexpMinutes > 0 && usableMinutes === 0,
    };
  }, [summaryData]);

  const sleepMsg = exp.sleep ? parseSleep(exp.sleep.text) : null;
  const isAsleep = sleepMsg === fullyAsleepMsg;

  useEffect(() => {
    if (!didAutoInit.current && !baseline && skills.length > 0) {
      didAutoInit.current = true;
      const b = {
        time: Date.now(),
        skills: Object.fromEntries(skills.map(([n, d]) => [n, { rank: d.rank, percent: d.percent || 0 }]))
      };
      saveBaseline(b);
      setBaseline(b);
    }
  }, [baseline, skills]);

  // Patch baseline when skills arrive that weren't present at init time
  useEffect(() => {
    if (!baseline) return;
    const newSkills = skills.filter(([name]) => !baseline.skills[name]);
    if (newSkills.length === 0) return;
    const updated = {
      ...baseline,
      skills: {
        ...baseline.skills,
        ...Object.fromEntries(newSkills.map(([n, d]) => [n, { rank: d.rank, percent: d.percent || 0 }]))
      }
    };
    saveBaseline(updated);
    setBaseline(updated);
  }, [skills, baseline]);

  const now = Date.now();
  if (!baseline) {
    learningHoursRef.current = 0;
    lastLearningHoursUpdate.current = 0;
  } else if (now - lastLearningHoursUpdate.current >= 15000) {
    learningHoursRef.current = Math.max((now - baseline.time) / 3600000, 1 / 60);
    lastLearningHoursUpdate.current = now;
  }
  const learningHours = learningHoursRef.current;

  const learnedSkills = useMemo(() => {
    if (!baseline) return [];
    return Object.keys(baseline.skills)
      .map((name) => {
        const base = baseline.skills[name];
        const data = lastKnownRef.current[name];
        if (!data || data.rank == null) return null;
        const gained = (data.rank + (data.percent || 0) / 100) - (base.rank + base.percent / 100);
        if (gained <= 0) return null;
        return { name, gained, currentRank: data.rank };
      })
      .filter(Boolean)
      .sort((a, b) => b.gained - a.gained);
  }, [skills, baseline]);

  const learnedTotals = useMemo(() => {
    const totalGained = learnedSkills.reduce((s, k) => s + k.gained, 0);
    const totalTdps   = learnedSkills.reduce((s, k) => s + (k.gained * k.currentRank / 200), 0);
    return {
      gained:      totalGained,
      perHour:     learningHours > 0 ? totalGained / learningHours : 0,
      perDay:      learningHours > 0 ? totalGained / learningHours * 24 : 0,
      tdps:        totalTdps,
      tdpsPerHour: learningHours > 0 ? totalTdps / learningHours : 0,
      tdpsPerDay:  learningHours > 0 ? totalTdps / learningHours * 24 : 0,
    };
  }, [learnedSkills, learningHours]);

  useEffect(() => {
    return () => clearTimeout(resetTimerRef.current);
  }, []);

  // Tick every second to refresh pulse countdown timers
  const [, setTick] = useState(0);
  useEffect(() => {
    if (activeTab !== 'drain') return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [activeTab]);

  function handleReset() {
    // Immediately baseline current skills so gains clear right away (no "appear then drop" flash)
    const snapSkills = (s) => Object.fromEntries(s.map(([n, d]) => [n, { rank: d.rank, percent: d.percent || 0 }]));
    const immediate = { time: Date.now(), skills: snapSkills(skillsRef.current) };
    saveBaseline(immediate);
    setBaseline(immediate);

    // Send exp to flush all skill data, then add any skills that weren't in the immediate snapshot
    if (send) send('exp');
    setResetting(true);
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setBaseline((current) => {
        const newSkills = skillsRef.current.filter(([name]) => !current.skills[name]);
        if (newSkills.length === 0) {
          setResetting(false);
          return current;
        }
        const b = {
          ...current,
          skills: { ...current.skills, ...snapSkills(newSkills) },
        };
        saveBaseline(b);
        setResetting(false);
        return b;
      });
    }, 1500);
  }

  if (skills.length === 0) {
    return <div className="exp-tracker exp-empty">No skills tracked yet</div>;
  }

  return (
    <div className={`exp-tracker ${isAsleep ? 'asleep' : ''}`}>
      <div className="exp-tabs">
        <button
          className={`exp-tab-btn${activeTab === 'current' ? ' active' : ''}`}
          onClick={() => setActiveTab('current')}
        >Current</button>
        <button
          className={`exp-tab-btn${activeTab === 'learned' ? ' active' : ''}`}
          onClick={() => setActiveTab('learned')}
        >Learned</button>
        <button
          className={`exp-tab-btn${activeTab === 'drain' ? ' active' : ''}`}
          onClick={() => setActiveTab('drain')}
        >Drain</button>
      </div>

      {activeTab === 'current' && (
        <>
          <table className="exp-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th className="text-align-center">Rank</th>
                <th>Mindstate</th>
                <th></th>
                <th title="Estimated time to drain current mindstate to clear">Time</th>
              </tr>
            </thead>
            <tbody>
              {skills.map(([name, data]) => (
                <tr key={name}>
                  <td className="exp-skill">{name}</td>
                  <td className="exp-rank">
                    <div className="exp-whole">{data.rank}</div>
                    <div className="exp-pct">{data.percent}%</div>
                  </td>
                  <td
                    className="exp-state"
                    style={{ color: learningColor(data.state) }}
                  >
                    {data.state || "-"}
                  </td>
                  <td className="exp-mindstate" style={{ color: learningColor(data.state) }}>{mindstateLabel(data.state)}</td>
                  <td className="exp-to-clear">{formatTimeToClear(pulseData[name]?.last_mindstate, pulseData[name]?.drain_fraction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="exp-summary">
            <div className="exp-total">Total skills: {skills.length}</div>
            <div className="exp-rexp">
              <div className="exp-rexp-title">Rested Experience</div>
              {!isAsleep && rexpCalc && (
                <div>
                  {rexpCalc.duration > 0 ? (
                    <div className="exp-rexp-summary on">
                      Using REXP for the next {rexpCalc.durationMsg}
                      {rexpCalc.endTime && <div>(ending at {rexpCalc.endTime})</div>}
                    </div>
                  ) : (
                    <div className="exp-rexp-summary off">
                      Not currently using REXP
                      {rexpCalc.storedAndWaiting && (
                        <span> (restarting at {formatFutureTime(toMinutes(summaryData.refreshes))})</span>
                      )}
                    </div>
                  )}
                  <div className="exp-stored">Stored: &nbsp;&nbsp;&nbsp;{summaryData.rexp}</div>
                  <div className="exp-usable">Usable: &nbsp;&nbsp;&nbsp;{summaryData.usable}</div>
                  <div className="exp-refreshes">Refreshes: {summaryData.refreshes}</div>
                </div>
              )}
              {isAsleep && summaryData && (
                <div className="exp-rexp-stored-asleep">Stored REXP: {summaryData.rexp}</div>
              )}
              {sleepMsg && <div className="exp-sleep">{sleepMsg}</div>}
            </div>
          </div>
        </>
      )}

      {activeTab === 'drain' && (
        <div className="drain-view">
          {Object.values(pulseData).every(d => d.last_pulse_at == null) ? (
            <div className="drain-empty">No pulse data yet — waiting for exp drain events.</div>
          ) : (
            <table className="drain-table">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th title="Mindstate levels drained per pulse (requires 5+ samples)">Levels/pulse</th>
                  <th title="Ranks gained per pulse: normal / REXP (requires 5+ samples each)">Rank/pulse</th>
                  <th title="Pulses where mindstate decreased, used to calculate Levels/pulse">Samples</th>
                </tr>
              </thead>
              <tbody>
                {groupBySkillset(
                  Object.entries(pulseData)
                    .filter(([, data]) => data.reliable_pulses > 0 || (data.rank_gain_pulses ?? 0) > 0 || (data.rank_gain_pulses_rexp ?? 0) > 0)
                    .sort(([a], [b]) => a.localeCompare(b))
                ).flatMap(([skillset, entries]) => [
                  <tr key={`header-${skillset}`} className="drain-skillset-header">
                    <td colSpan={4}>{skillset}</td>
                  </tr>,
                  ...entries.map(([skill, data]) => (
                    <tr key={skill}>
                      <td className="drain-skill">{skill}</td>
                      <td className="drain-fraction">
                        {data.drain_fraction != null
                          ? (data.drain_fraction * 34).toFixed(3)
                          : '--'}
                      </td>
                      <td className="drain-rank-gain">
                        {data.rank_gain_per_pulse != null && data.rank_gain_per_pulse_rexp != null ? (
                          `${data.rank_gain_per_pulse.toFixed(3)} | ${data.rank_gain_per_pulse_rexp.toFixed(3)}r`
                        ) : data.rank_gain_per_pulse != null ? (
                          data.rank_gain_per_pulse.toFixed(3)
                        ) : data.rank_gain_per_pulse_rexp != null ? (
                          `${data.rank_gain_per_pulse_rexp.toFixed(3)}r`
                        ) : '--'}
                      </td>
                      <td className="drain-samples">
                        {data.reliable_pulses}
                      </td>
                    </tr>
                  ))
                ])}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'learned' && (
        <div className="learned-view">
          {!baseline && <div className="learned-empty">Waiting for skill data...</div>}
          {baseline && learnedSkills.length === 0 && (
            <div className="learned-empty">No exp gained yet since tracking started.</div>
          )}
          {learnedSkills.length > 0 && (
            <table className="learned-table">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Gained</th>
                  <th>/hr</th>
                  <th>/day</th>
                </tr>
              </thead>
              <tbody>
                {learnedSkills.map(({ name, gained, currentRank }) => (
                  <tr key={name}>
                    <td className="learned-skill">{name}</td>
                    <td className="learned-val">{gained.toFixed(2)}</td>
                    <td className="learned-val">{(gained / learningHours).toFixed(2)}</td>
                    <td className="learned-val">{(gained / learningHours * 24).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {learnedSkills.length > 0 && (
            <div className="learned-totals">
              <div>Skills count: {learnedSkills.length}</div>
              <div>Total Ranks: {learnedTotals.gained.toFixed(2)}  /hr: {learnedTotals.perHour.toFixed(2)}  /day: {learnedTotals.perDay.toFixed(2)}</div>
              <div>Total TDPs:  {learnedTotals.tdps.toFixed(2)}  /hr: {learnedTotals.tdpsPerHour.toFixed(2)}  /day: {learnedTotals.tdpsPerDay.toFixed(2)}</div>
            </div>
          )}
          <div className="learned-footer">
            <span className="learned-time-label">
              Learning For: {formatLearningTime(learningHours)}
            </span>
            <button className="learned-btn" onClick={handleReset} disabled={resetting}>
              {resetting ? 'Refreshing...' : 'Reset'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
