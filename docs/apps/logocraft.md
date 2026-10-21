# logocraft

Logo/branding designer on Fabric.js. Source: reviewer reading of GitHub `xoxide101/logocraft`; not run. Architecture is near-identical to presscraft: see `presscraft.md` and consider one shared adapter.

## What exists (reported)

- Global `window.PC`. `PC.doc = {app, version, kind, board, name, panels[]}` with Fabric JSON per panel. Pixel paints are stripped from JSON and rehydrated asynchronously (`core.js:264-279`).
- `PC.snapshot()` (`core.js:858`); history of 40 entries with 250 ms debounce (`core.js:861-869`).
- Render/export: `PC.renderPanel`, `PC.renderPanelSVG` (`core.js:883-925`); `PC.exportFile(fmt, width, opt)` returns a Blob (`export.js:197`).
- The UI mutates Fabric objects directly, then calls `PC.changed()`.

## Changes needed (priority)

1. **S** `window.craftAPI`: `describe`, `state`, `summary`, `snapshot`, `restore`, `diff`, `render`, `export`.
2. **M** Make snapshot/restore async and wait for pixel-paint rehydration. Bypass the 250 ms history debounce for API snapshots.
3. **M** One mutation boundary: ops (add/remove/set object props, panel ops, board settings) that change Fabric objects and call `PC.changed()`; atomic with rollback via restore.
4. **S** Headless export returning bytes; no downloads.
5. **M** Scores (below).

## Headless blockers (reported)

File pickers, downloads, Google Fonts/network fonts (wait for fonts before render), possible tainted canvas from cross-origin images.

## Score candidates

Contrast of text on background, objects within board bounds, text fit, colour count/palette, minimum legible size, rendered difference to a reference image.

## Issues spotted (reported, not verified)

- `renderPanel` temporarily mutates `PC.doc` (`export.js:99-105`): concurrent exports could interfere. Serialise API calls.
- `region()` depends on `PC.canvas` (`export.js:81-91`).
- Immediate snapshot/apply sequences can miss changes because of the debounce.
