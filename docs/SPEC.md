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

**Env**: `CRAFT_MASTER_KEY` (required; 32 bytes base64 or hex; never committed, never stored), `CRAFT_GATEWAY_MODE` (`single` default | `multi`), `CRAFT_ALLOW_SIGNUP=1` (multi: open signup), `CRAFT_GATEWAY_PORT` (8787), `CRAFT_GATEWAY_HOST` (127.0.0.1), `CRAFT_GATEWAY_ID` (stable gateway id; generated and persisted if unset), `CRAFT_GATEWAY_NAME`, `CRAFT_CORS_ORIGINS` (comma list of exact browser origins; none by default), `CRAFT_UPSTREAM_ALLOW` (operator allow-list for private upstreams, see SSRF defences), `CRAFT_GATEWAY_DATA` (`data/gateway.json`, git-ignored, mode 0600).

**Modes**: `single` = the first registered account becomes admin, then registration and `/users` are closed. `multi` = first account is admin; later users are created by an admin (`POST /users`) or by open signup if enabled. Every key/token is private to its owner.

**Security**: passwords hashed with scrypt (N=16384, per-user salt), never stored plain; login throttled (5 failures -> 60 s). Vault: AES-256-GCM, random 12-byte IV per record, AAD = `ownerId:keyId`; keys derived from the master key via HKDF (separate vault and JWT keys). Secrets are decrypted in memory only while proxying; the API returns only a mask (`AIz…1234`). Session tokens are HS256 JWTs (1 h). API tokens (`cg_...`) are shown once, stored as SHA-256, revocable, optionally expiring, and limited to a subset of the creator's scopes. Scopes: `keys:read`, `keys:write`, `proxy:use`, `tokens:manage`, `data:read`, `data:write`, `admin`. Tokens carry grants per app (section 9.2).

**Endpoints** (`/api/v1`, JSON, errors as in section 1):

| Route | Auth/scope | Purpose |
|---|---|---|
| `GET /health`, `GET /providers` | none | status, provider list |
| `POST /auth/register` `{userId,password}` | per mode | create account (password 10+ chars) |
| `POST /auth/login` `{userId,password,scopes?}` | none | -> `{token,expiresIn,scopes}` |
| `GET /auth/me` | any | user + scopes |
| `GET/POST /users` | admin | list / create users (multi mode) |
| `GET/POST /tokens`, `DELETE /tokens/:id` | tokens:manage | API tokens with grants (section 9.2) |
| `POST /auth/logout`, `POST /auth/revoke-all` | any | revoke this session/token; revoke every session and token of the user |
| `PUT /users/:id/roles` | admin | set a user's custom roles (`everyone` and `admin` are reserved) |
| `GET/POST /resources`, `GET/DELETE /resources/:id`, `GET/PUT /resources/:id/content`, `GET/PUT /resources/:id/acl`, `GET /resources/:id/access`, `GET /admin/resources`, `GET /resource-types`, `GET /public/resources/:id/content` | see section 9.4 | server data with ACLs |
| `GET/POST /keys`, `DELETE /keys/:id` | keys:read / keys:write | vault; POST `{provider,label,secret,baseUrl?,apps?}` (`apps` = app ids allowed to use the key, default the creating app, `['*']` = all) |
| `ANY /proxy/:provider/*` | proxy:use | forwards upstream with the stored key attached |

**Proxy**: providers are `ollama`, `gemini`, `openai`, `anthropic`, `custom`. The key is chosen by provider (first one, or label in header `X-Craft-Key`). Client `Authorization`/`x-api-key`/`x-goog-api-key`/cookie headers are dropped and the right upstream header is added server-side. `baseUrl` is only accepted for `ollama`/`custom`; path traversal is rejected; redirects are not followed; responses stream through.

**SSRF defences** (upstream URLs are vetted when a key is created and again on every proxy request): `baseUrl` may only be set by admins in multi mode (any user in single mode, who is the admin). The host is resolved and every address is checked; loopback, RFC1918, CGNAT, link-local (incl. 169.254.169.254 metadata), ULA, multicast and unspecified ranges (also IPv4-mapped IPv6) are refused with `400 bad_base_url` at create time and `403 upstream_blocked` at request time. Exceptions: `CRAFT_UPSTREAM_ALLOW` (comma list of `host`, `host:port`, `ip`, `ip:port`, IPv4 `a.b.c.d/len`, set by the operator) and, in single mode only, loopback (for local Ollama). The connection is pinned to the validated IP (custom `lookup`), so DNS rebinding cannot swap the target; only `http(s)` without embedded credentials is accepted. The gateway's own listen port on loopback/its bound address is always blocked, even if allow-listed.

Not done: key rotation of the master key, per-key quotas/usage logs, TLS (run behind a reverse proxy; bind to localhost by default).

## 9. Multiple gateways, app-scoped credentials, data ACLs, client protocol (v1)

Code: `server/gateway/{app,data,resources}.mjs`, client `client/craftgw.mjs` (browser + Node ES module, no build), `client/node-store.mjs`, CLI `client/cli.mjs` (`npm run gw`). Tests: `test/gateway-access.test.mjs`, `test/client.test.mjs`. Vectors: `docs/test-vectors.json`.

### 9.1 Gateway identity and connections
Every gateway has an immutable `gatewayId` (`gw_...`, in `GET /health` and `GET /auth/me`). A **connection profile** is client-side only: `{ id, name, baseUrl, gatewayId, userId, app, tokenRef, expiresAt }`. It never contains a secret; the token is stored in the client's SecretStore under `tokenRef`. The client pins `gatewayId` when the connection is added and refuses to store or use a token if `/auth/login` or `/auth/me` reports a different id. One user can hold any number of profiles (several gateways, or several apps on one gateway), each with its own grants; `Connections.status()` / `craftgw status` print user, app and scopes per gateway. `baseUrl` must be `https` (plain `http` only for localhost). A cross-gateway credential is one grant spec minted once per gateway (`mintAcross`): every gateway stores only its own token hash, and a token whose `gateways` list does not contain the serving gateway (or `*`) is rejected.

### 9.2 Key scoping model
A credential (session JWT or API token `cg_...`) carries `userId`, `gatewayId` (JWT claim `gw`; API tokens: `gateways` list) and **grants**: `[{ app: '*' | appId, scopes: [...] }]`. App ids match `^[a-z0-9][a-z0-9_-]{1,31}$` (e.g. `3dcraft`, `ataricraft`, `imagecraft`).
- (a) user-wide: one grant `{app:'*'}`: all apps on this gateway.
- (b) app-specific: one grant `{app:'ataricraft'}`: usable only for that app.
- (c) both / per-app permission lists: several grants, e.g. `imagecraft: [data:read]`, `3dcraft: [data:read, data:write]`, optionally plus `*`.
Create: `POST /tokens {name, expiresInDays?, gateways?, grants:[...]}` or shorthand `{name, app?, scopes}`; login accepts the same `app`/`scopes`/`grants`. A token can only grant a subset of the creator's own scopes; an app-bound credential can only mint for its own app; `admin` is only valid with app `*`.
**Binding on every request**: the client sends `X-Craft-App: <appId>`. The gateway picks the exact-app grant, else the `*` grant; if none: `403 app_not_permitted`, or `403 app_required` when the header is missing on an app-bound credential. The matched grant's scopes are the request's scopes. Resources and vault keys are filtered by the bound app (9.4). For `*` credentials the header is advisory and never used for ACL matching.
**Revocation/expiry**: API tokens are stored as SHA-256 and checked on every request (`DELETE /tokens/:id`, optional `expiresAt`). Sessions (1 h) carry `jti`; `POST /auth/logout` revokes one, `POST /auth/revoke-all` sets `validAfter` on the user (all older sessions die) and revokes all their API tokens.

### 9.3 Wire protocol (for Rust / WASM / any client)
Base: `{baseUrl}/api/v1`, JSON UTF-8, always TLS except localhost. Success `{ok:true,...}`; error `{ok:false,error:{code,message}}` with HTTP status. Headers: `Authorization: Bearer <token>`, `X-Craft-App: <appId>` (see 9.2), `Content-Type: application/json`. Flow:
1. `GET /health` -> `{ok,mode,gatewayId,name,protocol:1}`; pin `gatewayId`.
2. `POST /auth/login {userId,password,app?,scopes?,grants?}` -> `{token,tokenType:'Bearer',expiresIn,gatewayId,grants}`. The password travels only in this call, over TLS; the server hashes with scrypt. Clients must not persist it. Throttled after 5 failures (429).
3. `GET /auth/me` -> `{gatewayId,gatewayName,user,app,scopes,grants,expiresAt}`; verify `gatewayId` equals the pinned id.
4. Tokens are opaque to clients. (JWT layout, for reference: HS256, header `{"alg":"HS256","typ":"JWT"}`, claims `sub,gw,grants,jti,iatMs,iat,exp`.)
5. `POST /auth/logout` when signing out.
Secure client storage (9.5). Rust clients: `reqwest`+`rustls`, `aes-gcm`, `scrypt`, `keyring`/`security-framework`/DPAPI; WASM: `fetch` + WebCrypto + IndexedDB exactly like `BrowserSecretStore`.

### 9.4 Server data, ACLs, deny-by-default
Resource: `{ id, type, name, app|null, owner, acl[], size, contentType, data }` with `type` in the registry from `GET /resource-types` (`dataset, asset, clipart, font, diskimage, other`; up to 2 MiB each, inline; large blobs deferred). ACL entry: `{ principal:{kind:'user'|'role'|'app'|'public', id}, perms:['read'|'write'|'admin'], app?: appId }` (`write` implies `read`, `admin` implies both). Evaluation (`resources.mjs`):
1. An app-bound credential only ever sees resources whose `app` equals its app; otherwise 404.
2. Permissions = owner (all) + every matching ACL entry. `user` matches the user; `role` matches users holding it (custom roles set via `PUT /users/:id/roles`; role `everyone` matches every *authenticated* user and only because an admin wrote that entry; `everyone`/`admin` cannot be assigned to users); `app` matches only credentials bound to that app; `public` matches anyone, unauthenticated (read-only, via `GET /public/resources/:id/content` only). An entry's `app` field restricts it to requests under that app-bound credential.
3. No entry and not owner: no access (404, existence is not revealed). Admin role: may list (`GET /admin/resources`), query, edit ACLs and delete, but gets **no content access** unless an ACL grants it. `everyone`/`public` entries can only be written (or removed) by an admin and never carry `admin`; `public` is read-only.
4. Every route also requires the scope (`data:read` for read/list, `data:write` for create/update/ACL/delete).
**Who can access this?** `GET /resources/:id/access` (managers only: owner, `admin` permission, admin role with admin scope) returns the owner, every ACL entry and the resolved users/roles/apps, plus what the admin role can and cannot do. Default for everything is deny; there is no implicit public or `everyone` access, and unauthenticated requests succeed only on `/health`, `/providers`, `/auth/login|register` (per mode) and public resources. CORS is also deny-by-default (`CRAFT_CORS_ORIGINS`).

### 9.5 Client secret storage and test vectors
- Browser: AES-256-GCM with a non-extractable `CryptoKey` kept in IndexedDB (`craftgw` / `kv`: `__wrapkey`, `v:<name>` = `{iv, ct}`; AAD = the entry name). The page can use but never read the key.
- Node: OS keychain when present (Linux `secret-tool`, macOS `security -i`; secrets via stdin, not argv), otherwise an encrypted file `~/.config/craftgw/secrets.json` (0600, directory 0700). File format: `{v:1, kdf:'scrypt'|'keyfile', [N,r,p,salt], iv, tag, ct}` (base64); key = `scrypt(passphrase, salt, 32)` (N=16384,r=8,p=1) when `CRAFTGW_PASSPHRASE` is set, else a random 32-byte key in `secrets.json.key` (0600; weaker, same-user protection only); AES-256-GCM, AAD = ASCII `craftgw-secrets-v1`; plaintext = JSON map name->string. Windows keychain (DPAPI) is not implemented; it uses the encrypted file.
- `docs/test-vectors.json` (checked in `test/client.test.mjs`; scrypt/HMAC/SHA-256 also cross-checked with an independent implementation): `passwordHash` (server record `scrypt$N$r$p$saltB64$hashB64`), `jwt` (HS256 with fixed key/time), `apiTokenHash` (SHA-256 hex), `vaultRecord` (AES-256-GCM server vault record), `secretFilePassphrase` and `secretFileKeyfile` (client file format).

### 9.6 Done / deferred
Done: items above plus tests for deny-by-default, app binding, cross-user isolation, revocation, gateway binding, CORS, storage. Deferred: federated single-token-for-many-gateways (today one token per gateway), group objects (roles are plain names on users), Windows DPAPI store, large-blob storage and streaming uploads, audit log, password change/reset and MFA, JWT key rotation, per-resource quotas, a GUI (the SDK/CLI show per-gateway scopes).
