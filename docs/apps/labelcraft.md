# labelcraft

Label/barcode designer. Fabric 5.3.1, JsBarcode, qrcode-generator, bwip-js. `labelcraft.src.html` is built into `index.html` by `build.py`. Source: reviewer reading of GitHub `xoxide101/labelcraft`; not run.

## What exists (reported)

- No engine global: state is closure-local in one large script. Saved JSON `{app, version, label, canvas}` (`canvasJSON()` ~2139). Pixel fills are omitted from JSON/history and rehydrated (`NOTES.md:36-45`).
- History ~3431-3468. `renderCanvas(dpi, ...)` ~3552-3569. `window.print()` ~3650-3657.

## Changes needed (priority)

1. **L (first)** Edit the `.src.html` (not the built `index.html`) to expose `window.LC` with a stable API over the closures; rebuild with `build.py`.
2. **M** `snapshot/restore/diff` over `canvasJSON()` and load; await rehydration.
3. **M** `apply(ops[])` (add text/barcode/QR/shape, set props, label size) with rollback.
4. **S** Headless render at a given DPI returning bytes; avoid print dialog.
5. **M** Scores.

## Headless blockers (reported)

`window.print()`, pickers, downloads.

## Score candidates (strong external checks)

Everything in bounds, text overflow, barcode/QR **decodes back to the encoded value** (use a decoder on the render), module width vs printer DPI, quiet zones.

## Notes

Fabric rehydration risk is shared with logocraft/presscraft. Do not hand-edit the built `index.html`.
