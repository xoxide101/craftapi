# craftapi spec (v0.2, matches the code)

Target app: 3dcraft (`window.E3`, plain scripts, scene = JSON `E3.doc`). Other Craft apps should be able to implement the same core.
Status: sections 1-4 are implemented and tested; 5 is not built; 6-7 are for review.

## 1. Core contract (every app)

All calls take and return JSON. Errors: `{ ok:false, error:{ code, message } }`.

| Command | Purpose |
|---|---|
| `describe()` | App name, API version, list of commands with input schemas, list of score functions |
| `newScene(opts?)` | Open a fresh empty scene (3dcraft: `E3.newDoc` + the UI's open sequence: `applyCamera`, `applyScene`, `await rebuild`). The app starts with no scene, so agents must call this first |
| `state()` | Whole document as JSON (3dcraft: `E3.doc`) |
| `summary()` | Compact structured view for an agent: objects, sizes, positions, problems. No pixels needed |
| `apply(ops[])` | Run a batch of operations atomically; on failure roll back to the state before the batch |
| `snapshot(label?)` -> `{ id }` | Store the current state (deep copy of the doc) |
| `restore(id)` | Go back to a snapshot |
| `diff(idA, idB)` | What changed between two snapshots (added/removed/changed objects and props) |
| `score(name, args?)` | Run a named score function, returns `{ value, detail }` |
| `render(opts)` | Image (PNG data URL) from a given view: `{ view, w, h, quality }` |
| `export(fmt, opts)` | File bytes (3dcraft: glb, obj, stl) |

## 2. 3dcraft operations (for `apply`)

Each op is `{ op, ...args }`. Ids are strings from `E3.uid()`.

| op | Args | Maps to |
|---|---|---|
| `add` | `{ kind:'shape', shape:{ type, ...params }, name?, pos?, rot?, scale?, color? }` | push to `E3.doc.objects` + `E3.rebuild()` (see gap 1) |
| `remove` | `{ id }` | remove from doc + rebuild |
| `set` | `{ id, prop, value }` (`pos`, `rot`, `scale`, `color`, `opacity`, ...) | `E3.setValue(m, prop, v)` |
| `setMaterial` | `{ id, material }` (see `E3.MATERIALS`) | material fields on `m.mat` |
| `group` / `ungroup` | `{ ids[] }` / `{ id }` | parent links |
| `modifier` | `{ id, type, params }` (array, mirror, twist, bend, taper, displace, smooth, decimate) | `window.MODS` |
| `boolean` | `{ id, other, mode: 'cut'|'join'|'overlap' }` | CSG layer |
| `physics` | `{ ids[], solid?, onHit?, bake? }` | `window.PHYS` |
| `camera` | `{ pos, target, fov }` | `E3.doc.camera`, `E3.applyCamera` |
| `scene` | `{ bg?, ground?, light?, ... }` | `E3.doc.scene`, `E3.applyScene` |
| `animate` | `{ id, prop, keys:[{t,v,ease}] }` | `E3.setKey` |
| `time` | `{ t }` | `E3.evalAt(t, true)` |
| `rename` | `{ id, name }` | name field |
| `bake` / `clearPhysics` | `{ length?, gravity? }` / none | `PHYS.bake` / `PHYS.clear` (puts the motion on the timeline) |

Extras in the API beyond the core table: `loadState(doc)`, `rate(id, value, note)`, `snapshots()`. Modifier `action` is `add | set | remove | move | toggle`; `modifier` types are the keys of `MODS.LIST` (also includes `boolean`).

Shape types come from `E3.SHAPES` (box, cylinder, torus, star, palm, table, rocket, ...). `describe()` must list them.

## 3. Scores (the outside signal)

Branching without a score is just variation. Each score is `name -> { value (0..1 or raw), detail }`.

| Score | Source | Status |
|---|---|---|
| `printCheck` | `E3.printCheck`: 1 minus 0.5 if not watertight, minus up to 0.5 for thin-wall share. Detail has size, `closed`, `open` edges, `minWall` | done |
| `fits` | `{ box:[x,y,z] }`: 1 if the model fits, lower the more it overshoots | done |
| `triangles` | `{ target }`: lower as the triangle count passes the target | done |
| `human` | `{ snapshot }`: the 0..1 rating the person gave via `rate` (weighted most) | done |
| `refDiff` | Rendered image vs a reference image | not built |

## 4. Branch explorer

```
explore({ start: snapshotId, mutations: [...], score: 'printCheck', beam: 5, depth: 4 })
```

1. From each kept state, apply each mutation to make children (`snapshot` each).
2. Score every child with an external score.
3. Keep the top `beam` states; repeat to `depth`.
4. Return the tree: `{ id, parent, op, scores, kept }` so a human can walk it.

Beam search keeps it from exploding combinatorially. Every node keeps the op that created it, so a perspective is a path through the tree.

## 5. Perspective memory (later)

Per agent: what it has read/seen, in what order, links it made, its past judgments with outcomes, and corrections from the person (weighted heavily). Stored beside the tree as JSON.

## 6. Engine gaps found in 3dcraft (read-only look, 2026-10-21)

1. **Object creation lives in `ui.js`** (`addObject`: assigns id, parent, defaults, colour, then `E3.rebuild()`), not in the engine. The API needs its own `add` or the logic should move into `E3`.
2. **Selection is stateful** (`E3.select`, `E3.selectedId`); `printCheck(onlySelected)` depends on it. The API should address by id, not by current selection.
3. **`rebuild()` is async** (returns a promise): `apply` must await it.
4. **No structured scene summary** exists; `describe.js` may overlap (to check).
5. **Rendering needs a browser context** (WebGL): headless means Chrome via CDP/Playwright, which the notes say is already used for tests.
6. **Undo history is in `ui.js`**, not the engine; `snapshot`/`restore` should be independent of it.

## 7. Open questions for Friday

- Should the in-page API live inside each app's repo (`js/craftapi.js`) or as a separate package loaded by the page?
- Move `addObject` into the engine, or duplicate it in the API?
- Which scores matter first for 3dcraft: print check only, or also a reference-image difference?
- Do other Craft apps (logocraft, labelcraft, sitecraft) have an engine object like `E3`, or do they need one first?
- Where does human rating get entered: the GUI, or the API only?

## 8. craft-api gateway (identity broker + key vault + proxy)

Code: `server/gateway/` (`npm run gateway`), tests: `test/gateway.test.mjs` (`npm run test:gateway`). Only `node:` built-ins, no new dependencies.

**Env**: `CRAFT_MASTER_KEY` (required; 32 bytes base64 or hex; never committed, never stored), `CRAFT_GATEWAY_MODE` (`single` default | `multi`), `CRAFT_ALLOW_SIGNUP=1` (multi: open signup), `CRAFT_GATEWAY_PORT` (8787), `CRAFT_GATEWAY_HOST` (127.0.0.1), `CRAFT_GATEWAY_DATA` (`data/gateway.json`, git-ignored, mode 0600).

**Modes**: `single` = the first registered account becomes admin, then registration and `/users` are closed. `multi` = first account is admin; later users are created by an admin (`POST /users`) or by open signup if enabled. Every key/token is private to its owner.

**Security**: passwords hashed with scrypt (N=16384, per-user salt), never stored plain; login throttled (5 failures -> 60 s). Vault: AES-256-GCM, random 12-byte IV per record, AAD = `ownerId:keyId`; keys derived from the master key via HKDF (separate vault and JWT keys). Secrets are decrypted in memory only while proxying; the API returns only a mask (`AIz…1234`). Session tokens are HS256 JWTs (1 h). API tokens (`cg_...`) are shown once, stored as SHA-256, revocable, optionally expiring, and limited to a subset of the creator's scopes. Scopes: `keys:read`, `keys:write`, `proxy:use`, `tokens:manage`, `admin`.

**Endpoints** (`/api/v1`, JSON, errors as in section 1):

| Route | Auth/scope | Purpose |
|---|---|---|
| `GET /health`, `GET /providers` | none | status, provider list |
| `POST /auth/register` `{userId,password}` | per mode | create account (password 10+ chars) |
| `POST /auth/login` `{userId,password,scopes?}` | none | -> `{token,expiresIn,scopes}` |
| `GET /auth/me` | any | user + scopes |
| `GET/POST /users` | admin | list / create users (multi mode) |
| `GET/POST /tokens`, `DELETE /tokens/:id` | tokens:manage | scoped API tokens |
| `GET/POST /keys`, `DELETE /keys/:id` | keys:read / keys:write | vault; POST `{provider,label,secret,baseUrl?}` |
| `ANY /proxy/:provider/*` | proxy:use | forwards upstream with the stored key attached |

**Proxy**: providers are `ollama`, `gemini`, `openai`, `anthropic`, `custom`. The key is chosen by provider (first one, or label in header `X-Craft-Key`). Client `Authorization`/`x-api-key`/`x-goog-api-key`/cookie headers are dropped and the right upstream header is added server-side. `baseUrl` is only accepted for `ollama`/`custom`; path traversal is rejected; redirects are not followed; responses stream through.

Not done: key rotation of the master key, per-key quotas/usage logs, TLS (run behind a reverse proxy; bind to localhost by default).
