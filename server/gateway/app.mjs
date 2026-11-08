import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Store } from './store.mjs';
import { PROVIDERS } from './providers.mjs';
import * as C from './crypto.mjs';
import { vetUpstream, parseAllowList } from './ssrf.mjs';
import { createDataRoutes, publicRead } from './data.mjs';
import { APP_RE } from './resources.mjs';

const USER_SCOPES = ['keys:read', 'keys:write', 'proxy:use', 'tokens:manage', 'data:read', 'data:write'];
const ALL_SCOPES = [...USER_SCOPES, 'admin'];
const SESSION_TTL = 3600;
const STRIP = new Set(['host', 'connection', 'content-length', 'authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'x-craft-key', 'x-craft-app', 'transfer-encoding', 'accept-encoding']);

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const isIPLiteral = (h) => /^[\d.]+$|:/.test(h);
const err = (s, c, m) => new HttpError(s, c, m);

export function createGateway({ masterKey, mode = 'single', allowSignup = false, store = new Store(), upstreamAllow = '', allowLoopback = mode === 'single', gatewayId, name = 'craft-api gateway', corsOrigins = '' } = {}) {
  if (!['single', 'multi'].includes(mode)) throw new Error('mode must be single or multi');
  const keys = C.deriveKeys(C.parseMasterKey(masterKey));
  const db = store.data;
  db.meta ??= {}; db.resources ??= {}; db.revoked ??= {};
  db.meta.gatewayId = gatewayId || db.meta.gatewayId || C.newId('gw');
  db.meta.name = name;
  store.save();
  const gwId = db.meta.gatewayId;
  const cors = new Set(String(corsOrigins).split(',').map((x) => x.trim()).filter(Boolean)); // deny-by-default: no origins unless listed
  const allowList = parseAllowList(upstreamAllow);
  let gateway; // set below; gives the vetting code our own listen address
  const vet = (u) => {
    const a = gateway.address();
    const self = a && typeof a === 'object' ? { port: a.port, host: a.address } : null;
    return vetUpstream(u, { allowList, allowLoopback, self });
  };
  const failures = new Map(); // login throttle: key -> { n, until }

  const publicUser = (u) => ({ id: u.id, userId: u.userId, role: u.role, roles: u.roles || [], createdAt: u.createdAt });
  const publicKey = (k) => ({ id: k.id, provider: k.provider, label: k.label, apps: k.apps || ['*'], baseUrl: k.baseUrl || null, masked: k.masked, createdAt: k.createdAt });
  const publicToken = (t) => ({ id: t.id, name: t.name, grants: t.grants, gateways: t.gateways, expiresAt: t.expiresAt, createdAt: t.createdAt, revoked: !!t.revoked });
  const findUser = (userId) => Object.values(db.users).find((u) => u.userId === userId.toLowerCase());

  function validateCreds(userId, password) {
    if (typeof userId !== 'string' || !/^[a-zA-Z0-9._-]{3,64}$/.test(userId)) throw err(400, 'bad_request', 'userId must be 3-64 chars of letters, digits, . _ -');
    if (typeof password !== 'string' || password.length < 10 || password.length > 256) throw err(400, 'bad_request', 'password must be 10-256 characters');
  }

  async function createUser(userId, password, role) {
    validateCreds(userId, password);
    if (findUser(userId)) throw err(409, 'exists', 'userId already taken');
    const u = { id: C.newId('usr'), userId: userId.toLowerCase(), role, passwordHash: await C.hashPassword(password), createdAt: new Date().toISOString() };
    db.users[u.id] = u;
    store.save();
    return u;
  }

  const scopesFor = (u) => (u.role === 'admin' ? ALL_SCOPES : USER_SCOPES);

  // grants: [{ app: '*' | appId, scopes: [...] }]. '*' = every app on this gateway.
  function validateGrants(grants, allowedScopes, boundApp = '*') {
    if (!Array.isArray(grants) || !grants.length || grants.length > 20) throw err(400, 'bad_grants', 'grants must be 1-20 entries');
    const seen = new Set();
    return grants.map((g) => {
      if (!g || (g.app !== '*' && !APP_RE.test(g.app))) throw err(400, 'bad_grants', "grant.app must be '*' or an app id");
      if (seen.has(g.app)) throw err(400, 'bad_grants', 'duplicate app in grants');
      seen.add(g.app);
      if (boundApp !== '*' && g.app !== boundApp) throw err(403, 'forbidden', 'app-bound credentials can only grant their own app');
      if (!Array.isArray(g.scopes) || !g.scopes.length || g.scopes.some((x) => !allowedScopes.includes(x))) throw err(400, 'bad_scopes', 'scopes must be a non-empty subset of your own scopes');
      if (g.scopes.includes('admin') && g.app !== '*') throw err(400, 'bad_scopes', "admin scope only valid for app '*'");
      return { app: g.app, scopes: [...new Set(g.scopes)] };
    });
  }
  // Accepts { grants } or the shorthand { app?, scopes }.
  function grantsFromBody(b, allowedScopes, boundApp, defaultScopes) {
    if (b.grants !== undefined) return validateGrants(b.grants, allowedScopes, boundApp);
    if (b.app !== undefined && b.app !== '*' && !APP_RE.test(b.app)) throw err(400, 'bad_grants', 'invalid app id');
    return validateGrants([{ app: b.app ?? boundApp, scopes: b.scopes ?? defaultScopes }], allowedScopes, boundApp);
  }

  function issueSession(u, grants) {
    const jti = C.newId('ses');
    const token = C.signJwt(keys.jwt, { sub: u.id, gw: gwId, grants, jti, iatMs: Date.now() }, SESSION_TTL);
    return { token, tokenType: 'Bearer', expiresIn: SESSION_TTL, gatewayId: gwId, grants };
  }

  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw err(401, 'unauthorized', 'missing bearer token');
    let sub, grants, tokenId = null, jti = null, exp = null, iatMs;
    if (m[1].startsWith('cg_')) {
      const t = Object.values(db.tokens).find((x) => x.hash === C.sha256(m[1]));
      if (!t || t.revoked || (t.expiresAt && Date.parse(t.expiresAt) < Date.now())) throw err(401, 'unauthorized', 'invalid token');
      if (!t.gateways.includes('*') && !t.gateways.includes(gwId)) throw err(401, 'unauthorized', 'token is not valid for this gateway');
      sub = t.userRef; grants = t.grants; tokenId = t.id; exp = t.expiresAt;
    } else {
      const claims = C.verifyJwt(keys.jwt, m[1]);
      if (!claims || claims.gw !== gwId) throw err(401, 'unauthorized', 'invalid or expired token');
      if (db.revoked[claims.jti]) throw err(401, 'unauthorized', 'token revoked');
      sub = claims.sub; grants = claims.grants; jti = claims.jti; exp = claims.exp;
      iatMs = claims.iatMs;
    }
    const user = db.users[sub];
    if (!user) throw err(401, 'unauthorized', 'unknown user');
    if (iatMs !== undefined && iatMs <= (user.validAfter || 0)) throw err(401, 'unauthorized', 'token revoked');
    // Bind to an app on every request.
    const hdr = req.headers['x-craft-app'];
    if (hdr !== undefined && !APP_RE.test(hdr)) throw err(400, 'bad_request', 'invalid X-Craft-App');
    const g = (hdr && grants.find((x) => x.app === hdr)) || grants.find((x) => x.app === '*');
    if (!g) {
      if (!hdr) throw err(403, 'app_required', 'this credential is app-bound; send X-Craft-App');
      throw err(403, 'app_not_permitted', `credential is not permitted for app ${hdr}`);
    }
    return { user, scopes: g.scopes, app: g.app, grants, tokenId, jti, exp };
  }
  const need = (ctx, scope) => { if (!ctx.scopes.includes(scope)) throw err(403, 'forbidden', `missing scope ${scope}`); };

  async function readBody(req, limit) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > limit) throw err(413, 'too_large', 'body too large'); chunks.push(c); }
    return Buffer.concat(chunks);
  }
  async function readJson(req) {
    const b = await readBody(req, 1 << 20);
    if (!b.length) return {};
    try { const j = JSON.parse(b); if (j && typeof j === 'object') return j; } catch { /* fallthrough */ }
    throw err(400, 'bad_request', 'invalid JSON body');
  }
  const send = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const data = createDataRoutes({ db, store, err, readJson, readBody, send, need });
  const keyUsable = (k, ctx) => ctx.app === '*' || (k.apps || ['*']).includes(ctx.app);

  function throttle(id) {
    const f = failures.get(id);
    if (f && f.until > Date.now()) throw err(429, 'rate_limited', 'too many failed logins, try later');
  }
  function noteFailure(id) {
    const f = failures.get(id) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= 5) { f.until = Date.now() + 60_000; f.n = 0; }
    failures.set(id, f);
  }

  async function proxy(req, res, ctx, provider, rest, search) {
    need(ctx, 'proxy:use');
    const p = PROVIDERS[provider];
    if (!p) throw err(404, 'unknown_provider', `unknown provider ${provider}`);
    const label = req.headers['x-craft-key'];
    const mine = Object.values(db.keys).filter((k) => k.owner === ctx.user.id && k.provider === provider && keyUsable(k, ctx));
    const rec = label ? mine.find((k) => k.label === label) : mine[0];
    if (!rec) throw err(404, 'no_key', `no ${provider} key${label ? ` labelled ${label}` : ''} in your vault`);
    const base = (p.allowBaseUrl && rec.baseUrl) || p.baseUrl;
    if (!base) throw err(400, 'no_base_url', 'key has no baseUrl');
    const target = new URL(base);
    const basePath = target.pathname.replace(/\/$/, '');
    target.pathname = `${basePath}/${rest}`.replace(/\/+/g, '/');
    if (!target.pathname.startsWith(`${basePath}/`) || /(^|\/)\.\.(\/|$)/.test(decodeURIComponent(rest))) throw err(400, 'bad_path', 'invalid path');
    target.search = search;
    let vetted;
    try { vetted = await vet(target.href); } catch (e) { throw err(403, 'upstream_blocked', e.message); }

    let secret = '';
    if (rec.secret) secret = C.decrypt(keys.vault, rec.secret, `${rec.owner}:${rec.id}`);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!STRIP.has(k.toLowerCase())) headers[k] = v;
    Object.assign(headers, p.auth(secret));
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const body = hasBody ? await readBody(req, 20 << 20) : undefined;
    headers.host = target.host;
    if (body?.length) headers['content-length'] = body.length;
    const doRequest = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const up = await new Promise((resolve, reject) => {
      const ureq = doRequest(target, {
        method: req.method, headers, servername: isIPLiteral(target.hostname) ? undefined : target.hostname,
        // Pin the connection to the vetted IP so a second DNS answer (rebinding) cannot change the target.
        lookup: (_h, _o, cb) => (_o?.all ? cb(null, [{ address: vetted.ip, family: vetted.family }]) : cb(null, vetted.ip, vetted.family)),
      }, resolve);
      ureq.on('error', reject);
      ureq.end(body?.length ? body : undefined);
    }).catch(() => { throw err(502, 'upstream_unreachable', 'upstream request failed'); });
    const out = {};
    for (const [k, v] of Object.entries(up.headers)) if (!['connection', 'transfer-encoding', 'set-cookie', 'keep-alive'].includes(k)) out[k] = v;
    res.writeHead(up.statusCode, out);
    for await (const chunk of up) res.write(chunk);
    res.end();
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const m = req.method;
    if (m === 'GET' && path === '/api/v1/health') return send(res, 200, { ok: true, mode, gatewayId: gwId, name: db.meta.name, protocol: 1 });
    if (m === 'GET' && path === '/api/v1/providers') return send(res, 200, { ok: true, providers: Object.keys(PROVIDERS) });

    let pr = /^\/api\/v1\/public\/resources\/([\w-]+)\/content$/.exec(path);
    if (m === 'GET' && pr) {
      const r0 = publicRead(db, pr[1]);
      if (!r0) throw err(404, 'not_found', 'resource not found');
      res.writeHead(200, { 'content-type': r0.contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' });
      return res.end(Buffer.from(r0.data, 'base64'));
    }

    if (m === 'POST' && path === '/api/v1/auth/register') {
      const { userId, password } = await readJson(req);
      const count = Object.keys(db.users).length;
      let role = 'user';
      if (count === 0) role = 'admin';
      else if (mode === 'single') throw err(403, 'signup_closed', 'single-user mode: account already exists');
      else {
        const hdr = req.headers.authorization;
        if (hdr) { const ctx = authenticate(req); need(ctx, 'admin'); }
        else if (!allowSignup) throw err(403, 'signup_closed', 'signup disabled; an admin must create users');
      }
      const u = await createUser(userId, password, role);
      return send(res, 201, { ok: true, user: publicUser(u) });
    }

    if (m === 'POST' && path === '/api/v1/auth/login') {
      const body = await readJson(req);
      const { userId, password } = body;
      const tid = `${req.socket.remoteAddress}|${String(userId).toLowerCase()}`;
      throttle(tid);
      const u = typeof userId === 'string' && typeof password === 'string' ? findUser(userId) : null;
      // Verify against a dummy hash for unknown users to keep timing similar.
      const ok = await C.verifyPassword(password ?? '', u ? u.passwordHash : dummyHash());
      if (!u || !ok) { noteFailure(tid); throw err(401, 'invalid_credentials', 'invalid userId or password'); }
      failures.delete(tid);
      const grants = grantsFromBody(body, scopesFor(u), '*', scopesFor(u));
      return send(res, 200, { ok: true, ...issueSession(u, grants) });
    }

    const ctx = authenticate(req);

    if (m === 'GET' && path === '/api/v1/auth/me') {
      return send(res, 200, { ok: true, gatewayId: gwId, gatewayName: db.meta.name, user: publicUser(ctx.user), app: ctx.app, scopes: ctx.scopes, grants: ctx.grants, expiresAt: ctx.exp ?? null });
    }
    if (m === 'POST' && path === '/api/v1/auth/logout') {
      if (ctx.jti) {
        db.revoked[ctx.jti] = ctx.exp;
        for (const [j, e] of Object.entries(db.revoked)) if (e < Date.now() / 1000) delete db.revoked[j];
      } else if (ctx.tokenId) db.tokens[ctx.tokenId].revoked = true;
      store.save();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && path === '/api/v1/auth/revoke-all') {
      ctx.user.validAfter = Date.now();
      for (const t of Object.values(db.tokens)) if (t.userRef === ctx.user.id) t.revoked = true;
      store.save();
      return send(res, 200, { ok: true });
    }

    if (await data(req, res, ctx, path, url)) return;

    const ur = /^\/api\/v1\/users\/([\w-]+)\/roles$/.exec(path);
    if (ur && m === 'PUT') {
      need(ctx, 'admin');
      const u = db.users[ur[1]];
      if (!u) throw err(404, 'not_found', 'user not found');
      const { roles } = await readJson(req);
      if (!Array.isArray(roles) || roles.length > 20 || roles.some((x) => !/^[a-z][a-z0-9_-]{1,31}$/.test(x) || ['everyone', 'admin'].includes(x))) throw err(400, 'bad_request', "roles must be role names; 'everyone' and 'admin' are reserved");
      u.roles = [...new Set(roles)]; store.save();
      return send(res, 200, { ok: true, user: publicUser(u) });
    }

    if (path === '/api/v1/users') {
      need(ctx, 'admin');
      if (m === 'GET') return send(res, 200, { ok: true, users: Object.values(db.users).map(publicUser) });
      if (m === 'POST') {
        if (mode === 'single') throw err(403, 'single_user_mode', 'cannot add users in single-user mode');
        const { userId, password, role } = await readJson(req);
        const u = await createUser(userId, password, role === 'admin' ? 'admin' : 'user');
        return send(res, 201, { ok: true, user: publicUser(u) });
      }
    }

    if (path === '/api/v1/tokens') {
      need(ctx, 'tokens:manage');
      if (m === 'GET') return send(res, 200, { ok: true, tokens: Object.values(db.tokens).filter((t) => t.userRef === ctx.user.id).map(publicToken) });
      if (m === 'POST') {
        const body = await readJson(req);
        const { name, expiresInDays } = body;
        if (typeof name !== 'string' || !name || name.length > 64) throw err(400, 'bad_request', 'name required (max 64)');
        const grants = grantsFromBody(body, ctx.scopes, ctx.app, undefined);
        let gateways = body.gateways ?? [gwId];
        if (!Array.isArray(gateways) || !gateways.length || gateways.some((g) => typeof g !== 'string') || (!gateways.includes('*') && !gateways.includes(gwId))) throw err(400, 'bad_request', 'gateways must be a list of gateway ids that includes this gateway (or *)');
        const raw = C.newApiToken();
        const t = {
          id: C.newId('tok'), userRef: ctx.user.id, name, grants, gateways, hash: C.sha256(raw), createdAt: new Date().toISOString(),
          expiresAt: Number.isFinite(expiresInDays) && expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 864e5).toISOString() : null,
        };
        db.tokens[t.id] = t; store.save();
        return send(res, 201, { ok: true, token: raw, info: publicToken(t) }); // raw token shown once
      }
    }
    let r = /^\/api\/v1\/tokens\/([\w-]+)$/.exec(path);
    if (r && m === 'DELETE') {
      need(ctx, 'tokens:manage');
      const t = db.tokens[r[1]];
      if (!t || t.userRef !== ctx.user.id) throw err(404, 'not_found', 'token not found');
      t.revoked = true; store.save();
      return send(res, 200, { ok: true });
    }

    if (path === '/api/v1/keys') {
      if (m === 'GET') {
        need(ctx, 'keys:read');
        return send(res, 200, { ok: true, keys: Object.values(db.keys).filter((k) => k.owner === ctx.user.id && keyUsable(k, ctx)).map(publicKey) });
      }
      if (m === 'POST') {
        need(ctx, 'keys:write');
        const { provider, label, secret, baseUrl, apps: appsIn } = await readJson(req);
        let apps = appsIn ?? [ctx.app];
        if (!Array.isArray(apps) || !apps.length || apps.some((a) => a !== '*' && !APP_RE.test(a))) throw err(400, 'bad_request', "apps must be a list of app ids or ['*']");
        if (ctx.app !== '*' && (apps.length !== 1 || apps[0] !== ctx.app)) throw err(403, 'forbidden', 'app-bound credentials can only create keys for their own app');
        const p = PROVIDERS[provider];
        if (!p) throw err(400, 'unknown_provider', `provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
        if (typeof label !== 'string' || !/^[\w .-]{1,64}$/.test(label)) throw err(400, 'bad_request', 'label required (1-64 chars)');
        if (secret !== undefined && (typeof secret !== 'string' || secret.length > 4096)) throw err(400, 'bad_request', 'invalid secret');
        if (!secret && !p.keyOptional) throw err(400, 'bad_request', 'secret required for this provider');
        if (baseUrl !== undefined) {
          if (!p.allowBaseUrl) throw err(400, 'bad_request', 'baseUrl not allowed for this provider');
          if (mode === 'multi' && ctx.user.role !== 'admin') throw err(403, 'forbidden', 'only admins may set a custom baseUrl in multi-user mode');
          try { await vet(baseUrl); } catch (e) { throw err(400, 'bad_base_url', e.message); }
        }
        if (provider === 'custom' && !baseUrl) throw err(400, 'bad_request', 'custom provider needs baseUrl');
        if (Object.values(db.keys).some((k) => k.owner === ctx.user.id && k.provider === provider && k.label === label)) throw err(409, 'exists', 'label already used for this provider');
        const id = C.newId('key');
        db.keys[id] = {
          id, owner: ctx.user.id, provider, label, apps: [...new Set(apps)], baseUrl: baseUrl || null, createdAt: new Date().toISOString(),
          masked: C.maskSecret(secret), secret: secret ? C.encrypt(keys.vault, secret, `${ctx.user.id}:${id}`) : null,
        };
        store.save();
        return send(res, 201, { ok: true, key: publicKey(db.keys[id]) });
      }
    }
    r = /^\/api\/v1\/keys\/([\w-]+)$/.exec(path);
    if (r && m === 'DELETE') {
      need(ctx, 'keys:write');
      const k = db.keys[r[1]];
      if (!k || k.owner !== ctx.user.id || !keyUsable(k, ctx)) throw err(404, 'not_found', 'key not found');
      delete db.keys[k.id]; store.save();
      return send(res, 200, { ok: true });
    }

    r = /^\/api\/v1\/proxy\/([a-z]+)\/(.*)$/.exec(path);
    if (r) return proxy(req, res, ctx, r[1], r[2], url.search);

    throw err(404, 'not_found', 'no such route');
  }

  let dummy;
  function dummyHash() { return (dummy ??= 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64')); }

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && cors.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-craft-app, x-craft-key');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(origin && cors.has(origin) ? 204 : 403); return res.end(); }
    route(req, res).catch((e) => {
      if (!(e instanceof HttpError)) console.error('gateway error:', e.message);
      if (res.headersSent) return res.destroy();
      const h = e instanceof HttpError ? e : err(500, 'internal', 'internal error');
      send(res, h.status, { ok: false, error: { code: h.code, message: h.message } });
    });
  });
  gateway = server;
  return { server, store };
}
