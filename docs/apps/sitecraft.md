# sitecraft

Visual website builder on GrapesJS 0.21.13. `sitecraft.src.html` is built into `index.html` by `build.py`. Source: reviewer reading of GitHub `xoxide101/sitecraft`; not run.

## What exists (reported)

- `const editor` is local, exposed through `window.SC` (`exposeApi()`, per `NOTES.md`). Custom storage via `onStore/onLoad`.
- Mutations mostly via the GrapesJS API; text editing uses iframe `execCommand`. Built-in `UndoManager`.
- `fullHtml(page)` (`index.html:~1175`), `getHtml()/getCss()`.

## Changes needed (priority)

1. **S** Extend `window.SC` to the common core: `describe`, `state` (project data), `summary`, `snapshot/restore` (`editor.getProjectData()` / `loadProjectData()`), `diff`.
2. **M** `apply(ops[])` over the GrapesJS component API, with rollback via snapshot.
3. **S** `render`/`export`: `fullHtml` plus Playwright screenshot after `canvas:frame:load`.
4. **M** Sanitise imported HTML for agent inputs.
5. **M** Scores.

## Headless blockers (reported)

Iframe canvas readiness, file pickers, downloads. Edit `sitecraft.src.html`, then run `build.py`.

## Score candidates

Accessibility (alt text, form labels, heading order, contrast), broken links, page weight, responsive overflow at device widths, HTML validity.

## Notes

The README referenced in NOTES was missing from the repo. `execCommand` text edits bypass the component API, so ops should set content through components, not the iframe.
