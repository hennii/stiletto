# Dynamic Taskmaster — Design Plan

## Concept

Replace the static ordered task list + fixed timers with a self-optimizing scheduler. The scheduler derives task order and duration from first principles: drain rates (from pulse tracking), training rates (observed empirically), and task definitions (setup costs, skills trained).

**Efficiency goal:** maximize the number of skills with mindstate > buffer at all times — i.e., keep as many skills actively earning ranks as possible, continuously.

The key shift in behavior: instead of grinding one skill to 16+ mindstate before switching, the scheduler rapid-cycles through tasks, filling each skill just enough to last until its next visit. The original design derived cycle time algorithmically; the actual implementation replaced this with reactive urgency scoring — see Implementation Analysis.

---

## Data Structures

### 1. Task Definition (settings file)

Defined by the user. Order does not matter — the scheduler determines order.

```json
{
  "buffer_mindstates": 2,
  "travel_times": {
    "Crossing": { "Shard": 540, "Riverhaven": 300, "Crossing": 0 },
    "Shard":    { "Crossing": 540, "Riverhaven": 480, "Shard": 0 },
    "Riverhaven": { "Crossing": 300, "Shard": 480, "Riverhaven": 0 }
  },
  "tasks": [
    {
      "id": "sweep_goblins",
      "script": "kor_combat_train",
      "args": { "zone": "goblin_lair" },
      "location": "Crossing",
      "skills_trained": ["Polearms", "Light Armor", "Shield Usage", "Athletics"],
      "local_setup_seconds": 45,
      "min_duration_seconds": 60
    },
    {
      "id": "forge_knife",
      "script": "kor_smith_train",
      "args": { "item": "hunting_knife" },
      "location": "Crossing",
      "skills_trained": ["Forging"],
      "local_setup_seconds": 20,
      "min_duration_seconds": 180
    },
    {
      "id": "herb_shop_shard",
      "script": "kor_herb_restock",
      "args": {},
      "location": "Shard",
      "skills_trained": ["First Aid"],
      "local_setup_seconds": 30,
      "min_duration_seconds": 120
    }
  ]
}
```

**Fields:**
- `buffer_mindstates` — global minimum mindstate to maintain per skill (default 2)
- `travel_times` — lookup table of travel seconds between named locations; user-defined based on observed travel durations
- `id` — unique identifier for this task
- `script` — Lich script to invoke
- `args` — passed to the script at invocation
- `location` — where this task runs; used to calculate travel cost from previous task's location
- `skills_trained` — list of skills this task trains (scheduler uses this to match tasks to skill deficits)
- `local_setup_seconds` — non-travel overhead once arrived (getting into position, prep); combined with travel time for total effective setup cost
- `min_duration_seconds` — minimum run time before switching away is worthwhile

**Effective setup cost** between two tasks is:
```
effective_setup(prev, next) = travel_times[prev.location][next.location] + next.local_setup_seconds
```

If the previous task shares a location with the next, travel cost is 0.

### 2. Training Rate Observations (derived, persisted)

Stored per character, like pulse_data. Observations are time-stamped so recency weighting is possible.

The pulse tracker works in mindstate levels (0–34), not bits — so training rates are measured in **mindstate levels per second**.

```json
{
  "sweep_goblins": {
    "Polearms": [
      { "mindstates_per_second": 0.042, "observed_at": "2026-03-18T10:00:00", "ranks": 112 },
      { "mindstates_per_second": 0.038, "observed_at": "2026-03-19T14:00:00", "ranks": 113 },
      { "mindstates_per_second": 0.031, "observed_at": "2026-03-20T09:00:00", "ranks": 114 }
    ],
    "Light Armor": [
      { "mindstates_per_second": 0.024, "observed_at": "2026-03-20T09:00:00", "ranks": 98 }
    ]
  }
}
```

**How a session is recorded:**
- Note mindstate level (0–34) for each trained skill at task start
- Note mindstate level at task end
- `mindstates_per_second = (mindstate_after - mindstate_before) / elapsed_seconds`

**Notes:**
- Store ranks at observation time — useful for understanding the rate decay curve over time
- A consistent downward trend in mindstates_per_second is a signal: **this task needs a difficulty bump**
- If a skill was already near 34 (mind lock) at task start, the observation is unreliable (can't measure fill rate when the pool is full) — discard or flag

### 3. Scheduler State (in-memory, rebuilt each replan)

```
per skill:
  current_mindstate       from game state (0–34)
  drain_fraction          from pulse_data (fraction of 34 drained per pulse)
  drain_per_pulse         = drain_fraction * 34  (mindstate levels per pulse)
  next_pulse_at           from pulse tracker

per task:
  training_rate[skill]    recency-weighted average from observations
  estimated_duration      calculated by solver
```

---

## The Algorithm

> **Note:** The algorithm below describes the original design. The actual implementation diverged significantly — the cycle time solver was removed, the urgency formula was simplified, and task duration is currently fixed rather than computed. See **Implementation Analysis** at the bottom of this document for what was built and why it changed.

### Phase 1: Cycle Time Solver (run at startup and after each new observation)

The cycle time and task durations are mutually dependent — solve iteratively.

**Goal:** find the stable `cycle_time` and `duration[task]` for each task such that:
- Every skill trained by a task receives enough mindstate to survive one full cycle
- `cycle_time = Σ (setup_cost[task] + duration[task])` for all tasks

**Iteration:**

```
seed:
  # minimum possible cycle time: all setup costs, zero training time
  # use a representative task order (e.g. sorted by location to minimize travel)
  cycle_time = Σ effective_setup(task[i], task[i+1]) for all tasks in order

loop until cycle_time stabilizes:
  for each task:
    pulses_per_cycle = cycle_time / 200
    for each skill in task.skills_trained:
      mindstates_needed = drain_fraction[skill] * 34 * pulses_per_cycle + buffer_mindstates
      time_needed[skill] = mindstates_needed / training_rate[task][skill]  # training_rate in mindstates/second
    duration[task] = max(min_duration[task], max(time_needed[skill] for skill in task))

  new_cycle_time = Σ (effective_setup(task[i], task[i+1]) + duration[task[i]]) for all tasks in order
  if abs(new_cycle_time - cycle_time) < 1.0:
    break
  cycle_time = new_cycle_time
```

Note: the solver uses a fixed task order for cycle time calculation. The actual run order is determined by the greedy scorer (Phase 2), but the solver needs *some* order to sum travel costs. A reasonable default is to group tasks by location to minimize total travel in the estimate.

Typically converges in 3–5 iterations.

**Diagnostics the solver can surface:**
- A task whose `setup_cost >> duration` is overhead-dominated — worth flagging
- A skill where `mindstates_needed / training_rate` diverges or exceeds a threshold — training rate too low, difficulty bump needed
- Cycle time > some threshold (e.g. 60 min) — too many tasks or too slow training rates

### Phase 2: Task Selection (run after each task completes)

At replan time, pick the next task greedily based on current skill state.

```
for each task:
  travel = travel_times[prev_task.location][task.location]
  total_overhead = travel + task.local_setup_seconds + task.estimated_duration
  training_value = Σ urgency[skill] * training_rate[task][skill]
                     for skill in task.skills_trained
  score[task] = training_value / total_overhead

where:
  urgency[skill] = max(0, target_mindstate[skill] - current_mindstate[skill])
  target_mindstate = buffer + expected drain during one cycle
```

Pick the highest-scoring task. This naturally:
- Prioritizes skills that are most depleted relative to target
- Prefers tasks that address multiple urgent skills simultaneously
- Penalizes expensive travel — a distant task must offer proportionally more training value to win over a local task
- Defers long-travel tasks (Shard, Riverhaven) until enough of their skills are urgent to justify the trip

### Phase 3: Observation Recording (run during each task)

**Training rate** — while a task runs:
- Record mindstate level (0–34) for each trained skill at task start
- Record mindstate level at task end
- If mindstate_before >= 32 (near mind lock), discard — can't measure fill rate when pool was nearly full
- `mindstates_per_second = (mindstate_after - mindstate_before) / elapsed_seconds`
- Append timestamped observation to training_rate data

**Travel time** — across task transitions:
- Record `task_end_time` when a task script exits
- When the next task's first training event fires (first mindstate change observed), record `first_training_time`
- `observed_travel = first_training_time - task_end_time`
- Update `travel_times[prev.location][next.location]` using a running average with the new observation
- Only record if both tasks completed normally (no interruptions)

---

## Integration Points

### Stiletto client exposes (via ScriptApiServer)

The scheduler runs inside a Lich script and queries the client for:

| Command | Response |
|---|---|
| `GET EXP_MINDSTATE?SkillName` | current mindstate integer (0–34) |
| `GET EXP_DRAIN_FRACTION?SkillName` | drain fraction float (fraction of 34 drained per pulse) |
| `GET EXP_NEXT_PULSE_AT?SkillName` | unix timestamp of next pulse |
| `GET EXP_SNAPSHOT` | full skill snapshot as JSON (mindstate + drain_fraction + next_pulse_at for all skills) |

These are straightforward extensions of the pulse tracking work. No pool size — everything stays in mindstate units (0–34).

### Taskmaster script structure

```
startup:
  load task definitions from settings
  load training_rate observations from file
  run cycle time solver → get estimated_duration per task

main loop:
  select next task (greedy scorer)
  record start mindstate for all skills task trains
  invoke task script with args and duration limit
  wait for task script to complete
  record end mindstate, compute training rate observation, append to file
  re-run cycle time solver with updated observations
  replan → select next task
```

### Task scripts interface

Task scripts need to accept a `--max-duration` argument (seconds) so the taskmaster can hand off control with a time budget. When the budget expires, the task script exits cleanly.

---

## Bootstrap / Cold Start

The scheduler has no training rate data initially. Bootstrap strategy:

1. **First N runs** of each task: use `min_duration_seconds` as the duration (conservative)
2. After each run, record the observation
3. Once each task has ≥ 3 observations, the solver uses them; until then it skips that task from cycle time calculation and treats it as fixed-duration
4. The cycle time solver excludes tasks with insufficient data from its cycle time estimate until they're calibrated

---

## Signals / Alerts

The scheduler should emit detectable signals for:

- **Training rate declining:** rolling average dropped > 20% from peak for a task+skill → difficulty bump needed
- **Cycle time creeping:** cycle time increased > 15% over 7 days (skills growing out of tasks across the board)
- **Solver divergence:** a skill's required duration grows unboundedly → training rate is too low to keep up with drain

These can be simple log lines or ScriptApiServer events the frontend could surface.

---

## Decisions

1. **Travel time:** Initial values are user-defined estimates. Taskmaster observes actual travel time (time between task end and first training event of the next task) and updates the table over time. Only recorded when the next task completes normally (not interrupted).

2. **Interrupted tasks:** If a task exits early (death, disconnect, manual stop), neither the training rate observation nor the travel time observation is recorded. Clean completions only.

3. **Multi-skill task duration:** The solver uses `max(time_needed per skill)` — the slowest skill drives duration. Fast-training skills overshoot their target, which is fine (extra buffer, not wasted time).

4. **Skills only one task trains:** Scheduler has no choice — must run that task when the skill is urgent. Anchors the schedule; distant single-task skills will force travel regardless of cost.

5. **Task batching for distant locations:** Greedy scoring naturally defers distant tasks until skills are urgent enough to justify travel. No look-ahead needed for v1.

---

## Implementation Analysis — What Happened and What Changed

### Domain context

A few DragonRealms-specific terms used throughout this section:

- **Mindstate** — a 0–34 integer representing how much experience a skill has absorbed but not yet converted to ranks. 0 = fully drained, 34 = mindlocked (can absorb no more). Training a skill fills it; a background drain process empties it over time. Skills only earn ranks while above 0.
- **Drain** — the rate at which mindstate is automatically removed by pulses (every ~200s). Expressed as `drain_fraction`: the fraction of 34 drained per pulse. High-drain skills empty faster and need more frequent training.
- **Buffer** — a configurable minimum mindstate floor (default 2). The scheduler's goal is to keep every skill at or above buffer, ensuring continuous rank gains.
- **Exp window** — the game only reports mindstate for skills actively gaining experience. Skills that have fully drained to 0 disappear from the snapshot entirely.

### What was built

The plan was implemented as `kor_mastermind.rb` (renamed from "taskmaster" to "mastermind"). The core architecture matched the plan closely: task definitions in JSON, greedy scorer, iterative cycle time solver, observation recording, signals. The Stiletto `EXP_SNAPSHOT` API was used for all skill state.

### Where the fill model broke down

The cycle time solver — Phase 1 — turned out to be the central failure point. The plan assumed it would "typically converge in 3–5 iterations." In practice it frequently diverged or converged to wildly impractical values.

**The feedback loop problem:**

The solver iterates: `duration[task]` depends on `cycle_time`, and `cycle_time` depends on `duration[task]`. For fast-training skills this is stable. For slow-training skills it is not:

```
mindstates_needed = drain_fraction * 34 * (cycle_time / 200) + buffer
duration = mindstates_needed / training_rate
```

If `training_rate` is small (slow-training skill) and `cycle_time` grows even slightly, `mindstates_needed` grows, which makes `duration` larger, which makes `cycle_time` larger — a runaway feedback loop. In a 9-hour overnight run, cycle time grew to 7 trillion seconds.

**Capping at 34 mindstates didn't fully solve it.** Even with the cap applied, slow-training skills like Backstab produced solver outputs of 3600s+ — mathematically correct (34 mindstates / 0.009 ms/s ≈ 3778s) but completely impractical. The scheduler would assign Backstab a 60-minute session every cycle, which is not what "rapid cycling" means.

**The design assumption that broke it:** The plan assumed training rates would be high enough relative to drain that durations would stay reasonable. For a character at ~circle 162 with many skills at high rank, some skills train slowly enough that no fixed cycle time produces a stable fill solution. The fill model is fundamentally incompatible with slow-training/high-drain skills.

### What was tried before the redesign

Several intermediate fixes were attempted before abandoning the fill model:

- **Capping `mindstates_needed` at 34** — prevented runaway divergence but left impractical durations
- **Removing slow-training skills from `skills_trained`** — worked around the symptom by excluding skills from the solver, but felt like papering over the design flaw
- **Adjusting `min_duration_seconds`** — helped individual tasks but didn't address the underlying instability

### The redesign: reactive model

The fill model (Phase 1 solver) was replaced with a **reactive model**:

- Every task always runs for exactly `min_duration_seconds`. There is no computed duration.
- The greedy scorer (Phase 2) is unchanged and now does all the work. It determines *which* task runs next and *how often* each task runs — which is exactly what "rapid cycling" requires.

**Why this works better for the stated goal:** "Rapid cycling with just enough mindstate to keep learning between task sessions" is a reactive property, not a fill property. You don't need to compute how long to run a task — you run it for a fixed minimum and check again. Skills that are below buffer are urgent; skills that are full are not. Fast-draining skills hit zero more often and therefore appear below buffer more frequently, naturally resulting in more frequent selection. The system finds a rhythm without any explicit duration calculation.

**What was lost:** The fill model did have one genuine advantage: it would give longer sessions to tasks that needed more time to meaningfully train a skill. In the reactive model, a 20-minute fight session and a 3-minute foraging session are both fixed — the scheduler can't say "fight for 45 minutes because weapons are badly drained." This is an acceptable tradeoff given the stability problems, and the fight session's `min_duration_seconds` can be set by the user to reflect the appropriate time investment.

### Observation recording bugs discovered during implementation

Two bugs prevented fight_weapons_armor from ever accumulating training rate observations, which caused it to score zero and get starved by the greedy scorer:

1. **`start_snap` requirement:** `record_observation` originally required the skill to be present in the exp snapshot at *task start*. Weapon skills that were fully drained (not in the exp window) were skipped entirely. After a fight session they'd appear in the end snapshot but not the start snapshot — so no observation was recorded even after 11+ runs.

2. **Bootstrap counted runs, not observations:** The bootstrap guard used `run_count < MIN_OBSERVATIONS` to force task selection. fight_weapons_armor had 11 runs but 0 observations. Since `run_count >= 3`, it was treated as graduated and competed on score — where it always lost because training rates were nil.

Both bugs were fixed: `record_observation` now treats a missing start snapshot entry as mindstate=0, and bootstrap now uses `obs_count` (minimum observations recorded per skill) rather than run count.

### Additional issues found during live testing

- **Skill name mismatch:** `burgle_tm` had `"Lockpicking"` in `skills_trained` but the Lich global uses `"Locksmithing"`. The skill was never in the snapshot, so 0 observations were ever recorded — permanently holding burgle in bootstrap and blocking normal scoring.

- **`dynamic_skills` removed:** The original implementation passed a filtered `skills=` argument to the fight script based on which weapons were urgently needed. This was removed because: (a) the fight script's own cycle mode already handles weapon rotation efficiently over a full session, and (b) the urgency-based filtering could exclude fully-drained weapons (not in snapshot) that arguably needed training most.

- **Signal baseline:** The original signal threshold compared recent average to the all-time *peak* rate. Peak rates occur early when skills are at low mindstate and gain fast — any subsequent session looks like a decline. Changed to compare recent average against overall average, with threshold raised from 20% to 25%.

### Urgency formula simplified — cycle_time removed from scoring

The original urgency formula was:

```
urgency[skill] = max(0, buffer + drain_fraction * 34 * (cycle_time / 200) - current_mindstate)
```

The drain term was intended to ensure each task runs long enough for the skill to survive a full cycle without falling below buffer. In the fill model this made sense: cycle_time was meaningful and known. In the reactive model it does not — there is no "one cycle," the scheduler runs continuously picking whatever is most urgent. `cycle_time` has no causal relationship to the actual scheduling rhythm.

In practice the drain term compounded the instability. A `@drain_cache` had been added so fully-drained skills (absent from the snapshot) would retain their last-known drain fraction and produce non-zero urgency. But this added complexity without fundamentally improving scheduling quality — a skill with high drain and zero mindstate should look exactly as urgent as a skill with low drain and zero mindstate, because the fix is the same: run the task that trains it.

The formula was simplified to:

```
urgency[skill] = max(0, buffer - current_mindstate)
```

If the skill is below buffer, it's urgent (urgency = how far below). If it's at or above buffer, urgency is zero. Skills absent from the snapshot (fully drained, mindstate=0) get urgency=buffer. The drain cache was removed entirely.

**What this loses:** The original formula would pre-emptively boost urgency for fast-draining skills, selecting their task *before* they fell below buffer. The simplified formula only responds to the current deficit. In practice, skills that drain quickly will naturally cycle back below buffer frequently and get selected frequently — the reactive rhythm emerges from observed deficits rather than predictions.

**What was gained:** The scoring and selection logic is now simpler and more debuggable. There is no hidden amplification from drain rates and cycle estimates. The greedy scorer still rewards tasks proportional to how depleted their skills are, just without the prediction layer.

### Cycle time removed entirely

With drain removed from urgency, `cycle_time` had no remaining role in scheduling. It had been kept for a window display ("Cycle: Xs"), but displaying it implied it drove task selection when it no longer did. It was removed entirely — the computation, the window line, and the `@cycle_time` field. `estimated_durations` is now populated once at startup by `init_estimated_durations` (a direct copy of each task's `min_duration_seconds`) and never recomputed.

### Starvation escalation added

The simplified urgency formula introduced a new failure mode: a task whose skills were consistently outscored could be permanently starved. Urgency is capped at `buffer` (2) regardless of how long a skill has been depleted, so a highly efficient competitor can always win.

The fix: track when each skill first drops below buffer (`@skill_starved_since`). Urgency grows linearly with starvation duration:

```
urgency[skill] = base + (Time.now - skill_starved_since[skill]) * STARVATION_RATE
```

where `STARVATION_RATE = 1/300` (1 urgency point per 5 minutes). A skill starved for an hour gets urgency=14 instead of 2, which will eventually beat any competitor regardless of their training rate advantage. The timer resets when the skill recovers above buffer. The window surfaces the worst-starved skill per task so it's visible before it becomes a problem.

### Does the current implementation meet the stated goals?

**Stated goal:** maximize skills above buffer at all times — rapid cycling, filling each skill with *just enough* mindstate to last until next visit.

The current implementation is self-optimizing in task *order* but not in task *duration*. Every task runs for a user-configured fixed `min_duration_seconds`, making it structurally similar to the original static timer system with a smart ordering layer on top. The user must manually tune `min_duration_seconds` per task — exactly what the plan aimed to eliminate.

This creates two failure modes:
- **Too short:** the task doesn't push the skill above buffer during its session. Urgency accumulates, the task runs more frequently (starvation escalation), but each session still fails to make meaningful progress. The skill oscillates near 0.
- **Too long:** the task overshoots buffer by a large margin — skill reaches 20 when it only needed 4. Other skills languish while time is spent on a skill that was already healthy enough.

The plan's fill model was trying to solve this correctly, but the instability came from a specific architectural choice: `cycle_time` in the duration formula created a feedback loop. Remove that dependency and dynamic duration becomes stable.

### A more direct path that was missed

The fill model's instability was not inherent to the idea of dynamic duration — it came from `cycle_time`. The target mindstate in the original formula was:

```
target = buffer + drain * 34 * (cycle_time / 200)
```

The `cycle_time` term is what diverged. But `cycle_time` was only there to predict drain during the gap between visits. In the reactive model, where we no longer predict — we respond to current state — the target can simply be `buffer`. Which means the duration to reach it is:

```
estimated_duration = max(min_duration, (buffer - current_mindstate) / training_rate)
```

This is deterministic, requires no iteration, and has no feedback loop. The only inputs are fixed constants and current observed state. For a fully-drained skill (current=0, buffer=2, rate=0.02 ms/s): duration = 100s. For a partially filled skill (current=1): duration = 50s. For a skill already at buffer: duration = min_duration (floor).

**Multi-skill tasks:** a task trains multiple skills simultaneously. The computed duration should be `max(min_duration, max over all skills of (base_urgency[skill] / training_rate[task][skill]))` — the slowest skill to reach buffer drives the session length, same logic as the original fill model's `max(time_needed per skill)`.

**Starvation escalation:** the urgency formula includes a time-based starvation bonus on top of the base deficit. The duration formula should use only the base component `(buffer - current_mindstate)`, not the escalated urgency. Starvation escalation belongs in the *scorer* — it determines which task gets picked. Using the escalated value in the duration formula would cause unnecessarily long sessions for badly-neglected skills (e.g. a skill starved for 2 hours could compute a 10x longer session than needed). The selection and the session length are separate concerns.

This interaction is still correct: a starved skill gets selected more often (via urgency escalation in scoring) AND gets an appropriately-length session when run (via base urgency in duration). Together they guarantee both recovery frequency and sufficient session depth.

The current implementation is a pragmatic working system. This duration formula is the missing piece between the unstable fill model and the purely manual fixed timers. **It has not yet been implemented** — task duration remains fixed at `min_duration_seconds`.

### Current implementation summary

| Concern | Original Plan | Current Implementation |
|---|---|---|
| Task duration | Iterative fill-model solver | Fixed `min_duration_seconds` per task (manual) |
| Cycle time | Derived from solver, drives urgency | Removed entirely |
| Task selection | Greedy urgency×rate/overhead | Same, unchanged |
| Urgency formula | `buffer + drain * 34 * pulses_per_cycle - current` | `max(0, buffer - current) + starvation_escalation` |
| Starvation prevention | None | Time-based urgency escalation + window display |
| Bootstrap | Run count ≥ 3 | Observation count ≥ 3 per skill |
| Observation recording | Requires skill in start snapshot | Treats missing start as mindstate=0 |
| Signal baseline | Rate vs. all-time peak | Rate vs. historical average |
| Skill filtering | Dynamic per urgency (dynamic_skills) | Removed; fight script cycles all weapons |
| Duration self-optimization | Derived from drain + training rate | Not implemented — manual tuning only |

---

### Lookahead urgency — drain re-introduced with a fixed horizon (2026-03-23)

#### The observed problem

After an 8-hour overnight run, fight_weapons_armor ran every ~92 minutes. fight_tactics and backstab_fa_skinning had similar gaps (71–120 minutes). These tasks never won on score — they only got selected when enough other tasks simultaneously hit score=0.0, briefly vacating the queue. Starvation escalation at `STARVATION_RATE=1/300` wasn't aggressive enough to force selection within a reasonable window.

The "reactive rhythm emerges naturally" prediction from the simplified urgency redesign turned out to be wrong in practice. With 14 weapon skills draining at individually modest rates, they don't all reach zero simultaneously — they trickle back below buffer across a 20-minute window. By the time most are urgent, several short-overhead tasks (foraging, remedying, shaping) have each cycled through and reset their urgency, perpetually beating fight_weapons_armor in the scorer. The fight task has to wait for starvation escalation to build enough bonus to overcome the overhead penalty, which takes 40+ minutes at 1/300.

#### What was changed

Two changes were made:

**1. `STARVATION_RATE`: 1/300 → 1/150** (1 urgency point per 2.5 min instead of 5 min). Direct acceleration of the existing backstop mechanism.

**2. Lookahead urgency using `drain_fraction`:**

```ruby
URGENCY_LOOKAHEAD_SECONDS = 1800  # 30 minutes

def urgency(skill, snapshot)
  data           = snapshot[skill]
  current        = data ? (data["mindstate"] || 0) : 0
  drain_fraction = data ? (data["drain_fraction"] || 0) : 0

  lookahead_pulses    = URGENCY_LOOKAHEAD_SECONDS / 200.0
  projected_mindstate = [current - drain_fraction * 34.0 * lookahead_pulses, 0].max

  base = [0.0, @buffer - projected_mindstate].max
  return 0.0 if base == 0.0
  # starvation escalation...
end
```

Rather than responding only to current deficit, urgency now asks: *will this skill be below buffer within the next 30 minutes?* Skills projected to drain below buffer generate pre-urgency before actually hitting zero. Fast-draining skills (weapons) accumulate urgency between sessions; slow-draining skills (Outdoorsmanship, Alchemy) stay at zero longer after being filled.

#### Why this is different from the previously-removed drain term

The prior drain-in-urgency formula was:

```
urgency = max(0, buffer + drain_fraction * 34 * (cycle_time / 200) - current)
```

It was removed for two reasons:
1. **`cycle_time` feedback loop**: `cycle_time` depended on `duration`, which depended on urgency, which depended on `cycle_time`. For slow-training skills this diverged to 7 trillion seconds overnight.
2. **`@drain_cache` complexity**: skills absent from the snapshot (fully drained) needed their last-known drain_fraction cached to produce non-zero urgency, adding statefulness and complexity.

The new formula replaces `cycle_time / 200` with a fixed constant `URGENCY_LOOKAHEAD_SECONDS / 200`. No computed quantity feeds back into the urgency formula — the lookahead window is a tuning parameter, not a derived value. No feedback loop; no cache.

The "same urgency at zero regardless of drain rate" property is preserved: when `current=0` (absent from snapshot → `drain_fraction=0`), projected mindstate is 0 and urgency is `buffer` regardless of actual drain rate. The prior concern about `@drain_cache` amplifying high-drain depleted skills does not apply.

#### What this changes in the scorer

A weapon skill at mindstate=10 with `drain_fraction=0.05` projects to:
```
10 - (0.05 × 34 × 9) = 10 - 15.3 = -5.3 → clamped to 0
urgency = buffer = 2
```

The same skill in the old formula: `max(0, 2 - 10) = 0`. No urgency.

A slow-draining skill (Outdoorsmanship) at mindstate=10 with `drain_fraction=0.01` projects to:
```
10 - (0.01 × 34 × 9) = 10 - 3.06 = 6.94
urgency = max(0, 2 - 6.94) = 0
```

Correctly shows no urgency — it won't drain out within the window.

The net effect: fight_weapons_armor maintains non-zero value in the scorer for most of the inter-session gap (because partially-filled weapon skills show lookahead urgency), rather than only generating value after they fully deplete. It should compete for selection proactively rather than waiting on starvation escalation.

#### Risk to watch for

Weapon skills train very slowly at Kesmgurr's rank (~0.001–0.003 ms/s observed). A 1200s fight session raises each weapon by only 1–4ms. If drain is fast enough (drain_fraction ≥ ~0.011), a session doesn't fill weapons high enough to escape the lookahead window — they show urgency=2 immediately after the session ends. This means fight_weapons_armor could appear perpetually urgent and run back-to-back.

This is not necessarily wrong — if training rate genuinely can't keep pace with drain, the scheduler should run the task more frequently. But if it causes fight_weapons_armor to crowd out other tasks, the fix is to reduce `URGENCY_LOOKAHEAD_SECONDS` or increase the target mob difficulty (raises training rate). Watch the starvation window on other tasks after this change deploys.
