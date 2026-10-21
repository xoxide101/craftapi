# Craft apps: what each needs for craftapi

Written 2026-10-21 for Jeff and Claude. Read-only review of the GitHub copies (xoxide101/<app>, default branch) by seven parallel reviewers, then spot-checked. **Nothing was run** in a browser and nothing in the apps was changed. The local originals on Jeff's disk may differ from GitHub: check against the local copy before acting.

Reference implementation: `3dcraft` (see `../SPEC.md`, `../../browser/craftapi.js`).

## Verification labels

- **Verified**: I read the code myself.
- **Reported**: a reviewer read it and cited file/line; plausible but not re-read by me.
- **Refuted**: a reviewer claimed it and I checked it: wrong.

## At a glance

| App | Engine on window | State is | Undo exists | Headless blockers | Best score candidates | Effort |
|---|---|---|---|---|---|---|
| 3dcraft | `E3` | JSON (`E3.doc`) | in `ui.js` | none (done) | printCheck, fits | done |
| logocraft | `PC` | JSON + Fabric JSON per panel | yes (`core.js`, 40) | pickers, fonts, tainted canvas | contrast, bounds, text fit | M-L |
| presscraft | `PC` | JSON + Fabric JSON per panel | yes (`core.js`, 40) | print dialog, pickers, fonts | overflow, overlap, margins, DPI | M-L |
| labelcraft | none (closures) | Fabric JSON + `label` | yes (in file) | print, pickers | in-bounds, barcode decodes, min module | L |
| imagecraft | `IC`, `ImageCraft`, `CRAFTAI` | private `pics[]` of `ImageData` (not JSON) | yes (24) | AI models need network/WebGPU | bytes, colours, PSNR | M-L |
| sitecraft | `SC` (editor is local) | GrapesJS project data | GrapesJS UndoManager | iframe canvas, pickers | a11y, overflow at widths, weight | M |
| datacraft | `DC` | SQLite in memory (sql.js) | none | storage dialogs, pickers | SQL parses and round-trips | M |
| shiftcraft | none (`let plan`) | JSON (`plan`) | yes, 60, no redo | all inline in one HTML file | coverage, overtime, availability | M, then split |

## Patterns across apps

1. **logocraft and presscraft look like siblings** (`window.PC`, Fabric, `PC.doc`, `PC.snapshot()`, `renderPanel`). One shared Fabric adapter might serve both, and labelcraft. Check how much code is literally shared first.
2. **Fabric apps strip pixel paints from saved JSON and rehydrate later** (logocraft `core.js:264-279`). Snapshot/restore must await rehydration or "same" states differ. Biggest shared risk.
3. **No atomic `apply` with rollback anywhere.** Mutations happen in UI handlers. Each app needs one mutation boundary first (3dcraft's `E3.setValue`/`E3.rebuild` is the model).
4. **Determinism for branching.** shiftcraft `uid()` uses `Math.random()`; datacraft `buildMysql` stamps current time; calendars use local `Date`. Add seed and fixed clock.
5. **Undo is not snapshot/restore.** It is capped (24-60), debounced (250 ms in logocraft/presscraft, so an immediate snapshot can miss the last change) and UI-owned.
6. **Headless friction:** `window.print()`, file pickers, downloads, Google Fonts. Need a headless mode that returns bytes.
7. **Scores must come from outside the agent** (SPEC section 3). Prefer real checks (decode barcode, `php -l`, SQL parse, pixel diff) over invented heuristics.

## Suggested order (my opinion)

1. **shiftcraft**: clearest scored-search target; data is JSON. Split or extract pure functions first.
2. **imagecraft**: pure filters, byte output exists, natural scores. Exclude AI/cloud at first.
3. **datacraft**: pure generators give strong external scores; snapshot via `db.export()`.
4. **logocraft + presscraft (+ labelcraft)**: one Fabric adapter, then per-app ops.
5. **sitecraft**: GrapesJS has most of it; wiring plus a11y/viewport scores.

## Files

`imagecraft.md`, `logocraft.md`, `presscraft.md`, `labelcraft.md`, `sitecraft.md`, `datacraft.md`, `shiftcraft.md`.

Handoff for Claude: pick one app, read its note, then `../SPEC.md` and `browser/craftapi.js`; build `browser/<app>-craftapi.js` plus a smoke test like `server/smoke.mjs`; keep core commands identical.
