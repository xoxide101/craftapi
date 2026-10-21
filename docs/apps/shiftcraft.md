# shiftcraft

Employee scheduler (day/week/month labor planning). Offline, no build step. Source: reviewer reading of GitHub `xoxide101/shiftcraft`; not run.

## What exists (reported)

- One file: `index.html`, ~314 KB, one inline `<script>` (lines ~316-3812). Also `README.md`, `NOTES.md`.
- State: global lexical `let plan` (~425): staff, date-keyed shifts, forecasts, settings, positions, availability, training, tasks. Persisted in `localStorage['shiftcraft-v1']`. JSON import/export validates and normalises (~1775-1850).
- Mutations go through `change()` (snapshot, mutate, persist, render) (~442-449), called from inline UI handlers. No auto-scheduler.
- Undo: 60-entry JSON stack, not persisted, no redo.
- Reusable: `len`, date helpers, `forecastOf`, `targetHours`, `varianceHours`, `personWeekHours`, `availIssue` (~374-547); weekly max-hours and manager-coverage checks (~2035-2078).
- Output: JSON, text/CSV, emailable HTML, canvas/SVG/PDF/image sheets (~2199-2863), print.

## Changes needed (priority)

1. **S** Expose `window.ShiftCraft`: `describe`, `state` (clone of `plan`), `summary`.
2. **M** `snapshot/restore/diff` on `plan`; `apply(ops[])` with rollback. Route the UI through the same op functions (add/remove/move shift, copy day/week, staff and availability edits).
3. **M** `score(name)` returning `{value, detail}`: headcount coverage per hour (to add; only manager coverage exists), overtime/max weekly hours (exists; add daily max and minimum rest), availability (exists via `availIssue`), consecutive days, fairness, labor cost vs budget (needs wage/budget fields), role/certification coverage (shifts have no position assignment to check).
4. **S** Headless JSON export/import and render wrappers.
5. **L (recommended first)** Split into data model, operations, scoring, persistence, UI, with a single-file build like sitecraft's `build.py`.

## Issues spotted (reported, not verified)

- Local `Date` arithmetic (~374-377, 468): DST boundary risk.
- Shifts cannot cross midnight (`len()` = end minus start): night shifts.
- `uid()` uses `Math.random()` (~366): add a seedable id source.
- `new Date(text)` parsing is browser-dependent (~997-1000).
- Coverage loop samples every 15 minutes with boundary-sensitive comparisons.

## Why start here

Plain JSON state plus an objective score: the best first demo of snapshot, mutate, score, keep best outside 3D.
