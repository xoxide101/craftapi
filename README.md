# craftapi

One command layer for the Craft apps, so a person (GUI) and an agent (headless) drive the same things.
Started Wed 2026-10-21 for review with Claude on Friday. First target: **3dcraft**.

## Layout

| Folder | What it is | Status |
|---|---|---|
| `docs/SPEC.md` | Commands, JSON shapes, scoring, branching: the thing to review | updated to match the code |
| `docs/apps/` | Per-app notes for the other 7 Craft apps (what to change, scores, risks) | read-only review, nothing run |
| `browser/craftapi.js` | In-page layer (`window.craftAPI`) wrapping the engine (`window.E3`) | working (v0.2) |
| `server/session.mjs` | Launches headless Chrome, opens 3dcraft from disk, injects the API | working |
| `server/mcp.mjs` | MCP server (stdio): 15 tools over the API | working |
| `server/gateway/` | craft-api gateway: login, encrypted key vault, upstream proxy (SPEC section 8) | working, `npm run test:gateway` |
| `client/` | Client SDK (browser + Node), secure stores, `craftgw` CLI for multiple gateway connections (SPEC section 9) | working |
| `explorer/explore.mjs` | Branch explorer (beam search over snapshots) | working |
| `server/smoke.mjs`, `server/mcp-smoke.mjs` | End-to-end tests (50+ checks against the real 3dcraft) | passing |

## Use

```
npm install
npm test            # API + explorer, then the MCP server through a real MCP client
npm run mcp         # start the MCP server (stdio)
```

Env: `CRAFT3D_INDEX` (path to 3dcraft `index.html`, default `C:/Users/raver/3dcraft/index.html`), `CRAFTAPI_OUT` (export folder), `CRAFTAPI_HEADFUL=1` (show the browser), `CHROME_PATH`.

MCP client config:

```json
{ "mcpServers": { "craftapi-3dcraft": { "command": "node", "args": ["C:/Users/raver/craftapi/server/mcp.mjs"] } } }
```

It only reads 3dcraft; nothing in the 3dcraft folder is changed. The browser profile is temporary.

## Not done yet

- Perspective memory (SPEC section 5).
- Ops for text, traced pictures, imported models, letter animation, camera keys, backdrops.
- A `refDiff` score (render vs reference image).
- Moving `addObject` into the engine (SPEC section 6, gap 1).
- The same layer for the other Craft apps.

## Principles

1. GUI and agent are equal: the API sits beside the UI, not above it, and both go through the same engine calls (`E3.setValue` etc.).
2. Every app exposes the same small core (`describe`, `get`, `apply`, `snapshot`, `restore`, `score`, `render`); app-specific commands sit on top.
3. State is JSON and cheap to fork. Branching is snapshots, not magic.
4. Scores must come from something outside the agent (print check, render vs reference, a human rating).
5. Self-hosted and local-first. No cloud dependency.

## Open questions for Friday

See the end of `docs/SPEC.md`.
