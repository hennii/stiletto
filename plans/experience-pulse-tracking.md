# DragonRealms Experience Pulse Tracking — Design Brief

## Background: How Experience Works

Experience in DragonRealms is stored in a **per-skill pool** measured in "bits." Training fills the pool; the game periodically drains it, converting bits into rank progress. The pool has 34 discrete levels called **mindstates** (0 = clear, 34 = mind lock). Each mindstate represents 1/34th of the pool.

### Pool Size

Pool size is determined by skill placement, ranks, and stats. For a primary skill:

```
base_pool = (15000 × ranks / (ranks + 900)) + 1000
total_pool = ((1000 + intelligence_bonus + discipline_bonus) / 1000) × base_pool
```

Wisdom affects the **drain fraction** (how much drains per pulse) — the exact formula is not publicly documented, which is the core motivation for pulse tracking.

### Drain Pulses

- Skills are organized into **10 groups**, each pulsing every **200 seconds**
- Groups are offset by 20 seconds from each other (so one group pulses every 200s, not 2000s)
- Each pulse drains a **fixed fraction of the total pool** — this fraction is what Wisdom drives
- Published ranges for full pool drain (mind lock → clear):
  - Primary: 40–60 minutes (~12–18 pulses)
  - Secondary: 50–80 minutes
  - Tertiary: 70–100 minutes

---

## The Unknown: Wisdom → Drain Fraction

The exact formula mapping a character's Wisdom stat to their per-pulse drain fraction is not publicly documented. This is the key variable we want to derive. For a given character it is a constant (assuming stable stats), so once derived it can be used predictively.

---

## Pulse Tracking Design

### What to Capture

The game XML stream exposes experience data. For each pulse event, capture:

| Field | Source | Purpose |
|---|---|---|
| `timestamp` | system clock | pulse interval verification |
| `skill_name` | XML | which skill pulsed |
| `mindstate_before` | XML (prior state) | pool level before drain |
| `mindstate_after` | XML (post pulse) | pool level after drain |
| `ranks` | XML | current rank (pool size input) |
| `total_pool` | calculated | `base_pool × stat_multiplier` |

### Deriving the Formula

From each pulse:
```
bits_drained = (mindstate_before - mindstate_after) / 34 × total_pool
drain_fraction = bits_drained / total_pool
```

`drain_fraction` should be consistent across pulses for the same character. Collect 10–20 pulses per skill to get a stable average. Once you have drain fractions for characters with different Wisdom scores, you can fit the Wisdom → drain_fraction curve.

Even with a single character, you get a precise constant for that character's Wisdom — which is all you need for the dynamic targeting system.

### Pulse Group Assignment

Since skills rotate across 10 groups (each pulsing every 200s), you'll also want to identify **which group each skill belongs to** so the client knows when the next pulse for a given skill is expected. This can be inferred from timestamps after a few observed pulses.

---

## Dynamic Mindstate Targeting

### The Goal

Replace fixed mindstate targets (e.g. `mindstate=16`) with a calculated target based on how much experience will drain before the next training session. The pool should reach ~0 right as the next session begins — no overflow waste, no idle drain time.

### Formula

```
time_until_next_session  (in seconds, from taskmaster schedule)
pulses_until_next_session = time_until_next_session / 200
bits_that_will_drain = pulses_until_next_session × drain_fraction × total_pool
optimal_mindstate = round(bits_that_will_drain / total_pool × 34)
```

### Integration Points

**Client side:**
- Track pulses and maintain per-skill `drain_fraction` and `next_pulse_at` timestamp
- Expose these via the existing API (Lich scripts communicate with the client over a port configured in base settings)

**Lich/taskmaster side (`kor_magic_train.rb`):**
- Query the client API for `optimal_mindstate` at script start
- Fall back to the configured static value if the client has insufficient pulse data yet
- Pass the result as the mindstate threshold

**Taskmaster side (`kor_taskmaster.rb`):**
- Optionally: instead of fixed timers, trigger training tasks when the client reports a skill's pool is near 0

### Convergence Period

The system won't have accurate drain fractions immediately. A reasonable bootstrap strategy:
- Use the static configured mindstate for the first N sessions (e.g. 5) while pulse data accumulates
- Once enough pulses are observed to compute a stable `drain_fraction`, switch to dynamic targeting
- Re-derive periodically since ranks increase over time (changing pool size) — though the drain *fraction* itself is stable, the absolute bits per pulse will grow with the pool

---

## Summary of Unknowns Requiring Tracking

| Unknown | How to Derive |
|---|---|
| Per-pulse drain fraction for each skill | Observe mindstate delta across pulses |
| Which pulse group each skill belongs to | Infer from pulse timestamps |
| Wisdom → drain fraction curve | Collect drain fractions across characters with different Wisdom scores |

The first two are derivable from a single character's data stream. The third requires multi-character data but is only needed to generalize the formula — for a specific character, the observed drain fraction is sufficient.
