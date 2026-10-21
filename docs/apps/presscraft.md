# presscraft

Publishing/layout/calendar tool on Fabric.js. Source: reviewer reading of GitHub `xoxide101/presscraft`; not run. Same `PC` architecture as logocraft: share an adapter where possible.

## What exists (reported)

- `window.PC`. `PC.doc` = metadata + stories + panels. `PC.snapshot()` and 40-entry history (`core.js:831-855`).
- `PC.layout()`, `PC.renderPanel`, `PC.renderPanelSVG`.
- Calendar generation with date math (`core.js:404-405`).

## Changes needed (priority)

1. **S** craftAPI shell as in logocraft (`describe`, `state`, `summary`, `snapshot`, `restore`, `diff`, `render`, `export`).
2. **M** Async-safe snapshot/restore (pixel-paint and font rehydration); bypass history debounce.
3. **M** Mutation boundary for story/panel/frame ops, with rollback; run `PC.layout()` after ops.
4. **S** Headless render/export returning bytes (replace `window.print()` path).
5. **M** Scores (below).

## Headless blockers (reported)

`window.print()`, file pickers, downloads, Google Fonts "More fonts" needs network.

## Score candidates

Text overflow, frame overlap, margins/safe area, effective DPI of images, contrast, widows/orphans.

## Issues spotted (reported, not verified)

- Calendar date math uses local `Date` (`core.js:404-405`): test across DST and timezones; use a fixed clock for determinism.
- `ui.js:1087` inserts help HTML directly (fine for static text; keep agent input out of it).
