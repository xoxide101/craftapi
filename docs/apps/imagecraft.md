# imagecraft

Browser image conversion, restoration, filtering, upscaling, tracing, ASCII/ANSI art. No build step, works from `file://`. Source: reviewer reading of GitHub `xoxide101/imagecraft`; not run.

## What exists

- Ordered `<script>` tags (`index.html:97-123`). `js/ui.js` ~352 KB; `filters.js`, `colour.js`, `formats.js`, `restore.js`, `resample.js`, `ascii.js`, `tracer.js`, `craft-ai.js`. Big libs: `lib/craft-esrgan-v3.js` (~6.5 MB), `craft-ai-libs.js`, `craft-rastertrace.js`.
- Globals: `window.IC`, `window.ImageCraft` (`ui.js:2207`), `window.CRAFTAI`. No single engine object.
- State: private `pics[]` in `ui.js:90-104`: steps, current index, metadata, `ImageData`. **Pixels are not JSON** (typed arrays, some `Uint16Array`; `ui.js:131-150`).
- Filters are pure `ImageData -> ImageData` (`filters.js:1-8`).
- Input: `IC.formats.read({name, bytes})` (`formats.js:719-731`). Output: `IC.formats.write(img, format, opts) -> Promise<Blob>` (~102). Already headless-friendly.
- Undo: per-picture `steps[]`, capped at 24, UI-owned (`ui.js:131-186`).

## Changes needed (priority)

1. **S** `CraftAPI` shell: `describe`, `state`, `summary`, `snapshot`, `restore`, `diff`, `score`, `render`, `export`.
2. **M** Extract picture/history state from `ui.js` into a serialisable store. Since filters are pure, store a recipe (source bytes + ordered ops + params) and replay instead of snapshotting full `ImageData`.
3. **M** `apply(ops[])` dispatching filters/colour/format functions with rollback.
4. **M** Load from bytes, return bytes (no picker, no download).
5. **M-L** Parameterise UI-bound tools (masks, marks, dialogs; `applyTool`, `ui.js:1370`).
6. **L** Workers for heavy filters; readiness and timeouts for AI.

## Headless blockers (reported)

- Local AI needs WebGPU/WASM and downloads models from Hugging Face (`craft-ai.js:1-45,137`); cloud AI needs network (`cloudai.js:86`). Keep AI out of v1, or point loaders at the `craft-models` repo for offline use.
- Memory cost of cloning `ImageData` per branch.

## Score candidates

Encoded size (`formats.write(...).size`), dimensions, unique colours (`countColours`), palette error, transparency fraction, edge count, entropy, fidelity to original (MSE/PSNR now; SSIM must be written).

## Issues

- **Refuted:** a reviewer claimed blur border indexing (`filters.js:88-96`) yields negative indexes/NaN. I read it: `Math.min(len - 1, Math.max(0, i))` clamps both ends. No bug.
- History caps steps and drops older deep-precision data (`ui.js:131-150`), so snapshots cannot assume lossless history.
