# kor_moon_watch.rb — Plan

## Goal

Reimplement moonwatch.lic as a self-contained kor script. No dependency on
community dr-scripts. Tracks the three DR moons (katamba, yavash, xibar) by
listening to game text events, maintains timing state, and writes a live
status window via the ScriptApiServer window API.

## Moon Timing

From moonwatch.lic `Settings` values (real-world seconds):

| Moon     | Up duration (RISE → SET) | Down duration (SET → RISE) |
|----------|--------------------------|----------------------------|
| katamba  | 177 min                  | 174 min                    |
| yavash   | 177 min                  | 175 min                    |
| xibar    | 174 min                  | 172 min                    |

## Game Text Triggers

- `"Katamba/Xibar/Yavash sets"` → moon just set
- `"Katamba/Xibar/Yavash slowly rises"` → moon just rose

## Window Display

Single-line compact format matching moonwatch.lic short format:

```
[k]+(42) [y]-(18) [x]+(7)
```

- Letter = first letter of moon name
- `+` = currently up, `-` = currently down
- Number = minutes until next state change
- `?` = state unknown (no event seen yet this session)

## Architecture

Class `KorMoonWatch` including `KorCommon` and `KorFrostbiteClient`.

State per moon:
- `status` — `:rise`, `:set`, or `nil` (unknown)
- `next_event_at` — `Time` of predicted next rise or set

Main loop: `script.gets?` for game lines, process moon events, update
window if display changed (cache to avoid redundant writes).

## Files

- `kor-scripts/kor_moon_watch.rb` — the script
- `dr-client/plans/kor-moon-watch.md` — this plan
