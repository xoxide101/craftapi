import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Store } from './store.mjs';
import { PROVIDERS } from './providers.mjs';
import * as C from './crypto.mjs';
import { vetUpstream, parseAllowList } from './ssrf.mjs';

const USER_SCOPES = ['keys:read', 'keys:write', 'proxy:use', 'tokens:manage'];
const ALL_SCOPES = [...USER_SCOPES, 'admin'];
const SESSION_TTL = 3600;
const STRIP = new Set(['host', 'connection', 'content-length', 'authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'x-craft-key', 'transfer-encoding', 'accept-encoding']);

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const isIPLiteral = (h) => /^[\d.]+$|:/.test(h);
const err = (s, c, m) => new HttpError(s, c, m);

export function createGateway({ masterKey, mode = 'single', allowSignup = false, store = new Store(), upstreamAllow = '', allowLoopback = mode === 'single' } = {}) {
  if (!['single', 'multi'].includes(mode)) throw new Error('mode must be single or multi');
  const keys = C.deriveKeys(C.parseMasterKey(masterKey));
  const db = store.data;
  const allowList = parseAllowList(upstreamAllow);
  let gateway; // set below; gives the vetting code our own listen address
  const vet = (u) => {
    const a = gateway.address();
    const self = a && typeof a === 'object' ? { port: a.port, host: a.address } : null;
    return vetUpstream(u, { allowList, allowLoopback, self });
  };
  const failures = new Map(); // login throttle: key -> { n, until }

  const publicUser = (u) => ({ id: u.id, userId: u.userId, role: u.role, createdAt: u.createdAt });
  const publicKey = (k) => ({ id: k.id, provider: k.provider, label: k.label, baseUrl: k.baseUrl || null, masked: k.masked, createdAt: k.createdAt });
  const publicToken = (t) => ({ id: t.id, name: t.name, scopes: t.scopes, expiresAt: t.expiresAt, createdAt: t.createdAt, revoked: !!t.revoked });
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
  const issueSession = (u, scopes) => ({
    token: C.signJwt(keys.jwt, { sub: u.id, scopes }, SESSION_TTL), tokenType: 'Bearer', expiresIn: SESSION_TTL, scopes,
  });

  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw err(401, 'unauthorized', 'missing bearer token');
    let sub, scopes, tokenId = null;
    if (m[1].startsWith('cg_')) {
      const t = Object.values(db.tokens).find((x) => x.hash === C.sha256(m[1]));
      if (!t || t.revoked || (t.expiresAt && Date.parse(t.expiresAt) < Date.now())) throw err(401, 'unauthorized', 'invalid token');
      sub = t.userRef; scopes = t.scopes; tokenId = t.id;
    } else {
      const claims = C.verifyJwt(keys.jwt, m[1]);
      if (!claims) throw err(401, 'unauthorized', 'invalid or expired token');
      sub = claims.sub; scopes = claims.scopes;
    }
    const user = db.users[sub];
    if (!user) throw err(401, 'unauthorized', 'unknown user');
    return { user, scopes, tokenId };
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
    const mine = Object.values(db.keys).filter((k) => k.owner === ctx.user.id && k.provider === provider);
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
    if (m === 'GET' && path === '/api/v1/health') return send(res, 200, { ok: true, mode });
    if (m === 'GET' && path === '/api/v1/providers') return send(res, 200, { ok: true, providers: Object.keys(PROVIDERS) });

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
      const { userId, password, scopes } = await readJson(req);
      const tid = `${req.socket.remoteAddress}|${String(userId).toLowerCase()}`;
      throttle(tid);
      const u = typeof userId === 'string' && typeof password === 'string' ? findUser(userId) : null;
      // Verify against a dummy hash for unknown users to keep timing similar.
      const ok = await C.verifyPassword(password ?? '', u ? u.passwordHash : dummyHash());
      if (!u || !ok) { noteFailure(tid); throw err(401, 'invalid_credentials', 'invalid userId or password'); }
      failures.delete(tid);
      let granted = scopesFor(u);
      if (scopes !== undefined) {
        if (!Array.isArray(scopes) || scopes.some((s) => !granted.includes(s))) throw err(400, 'bad_scopes', 'requested scopes not allowed');
        granted = scopes;
      }
      return send(res, 200, { ok: true, ...issueSession(u, granted) });
    }

    const ctx = authenticate(req);

    if (m === 'GET' && path === '/api/v1/auth/me') return send(res, 200, { ok: true, user: publicUser(ctx.user), scopes: ctx.scopes });

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
        const { name, scopes, expiresInDays } = await readJson(req);
        if (typeof name !== 'string' || !name || name.length > 64) throw err(400, 'bad_request', 'name required (max 64)');
        if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !ctx.scopes.includes(s))) throw err(400, 'bad_scopes', 'scopes must be a non-empty subset of your own scopes');
        const raw = C.newApiToken();
        const t = {
          id: C.newId('tok'), userRef: ctx.user.id, name, scopes, hash: C.sha256(raw), createdAt: new Date().toISOString(),
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
        return send(res, 200, { ok: true, keys: Object.values(db.keys).filter((k) => k.owner === ctx.user.id).map(publicKey) });
      }
      if (m === 'POST') {
        need(ctx, 'keys:write');
        const { provider, label, secret, baseUrl } = await readJson(req);
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
          id, owner: ctx.user.id, provider, label, baseUrl: baseUrl || null, createdAt: new Date().toISOString(),
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
      if (!k || k.owner !== ctx.user.id) throw err(404, 'not_found', 'key not found');
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
