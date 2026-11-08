// craft-api gateway client SDK. Pure ES module: runs in browsers (fetch + WebCrypto + IndexedDB) and Node 20+.
// Wire protocol: docs/SPEC.md section 9. Passwords are only ever sent to POST /auth/login; tokens live in a SecretStore.

export class GatewayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function assertSecureUrl(baseUrl) {
  const u = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('gateway URL must be https (http only for localhost)');
  if (u.username || u.password) throw new Error('credentials in gateway URL not allowed');
  return u.origin + u.pathname.replace(/\/$/, '');
}

/** SecretStore interface: async get(name) -> string|null, set(name, string), delete(name). */
export class MemorySecretStore {
  #m = new Map();
  async get(n) { return this.#m.get(n) ?? null; }
  async set(n, v) { this.#m.set(n, String(v)); }
  async delete(n) { this.#m.delete(n); }
}

/**
 * Browser store: values are AES-256-GCM encrypted with a NON-EXTRACTABLE CryptoKey that lives in IndexedDB,
 * so page script (or an XSS payload) can use it in-page but can never read the raw key bytes or export it.
 */
export class BrowserSecretStore {
  constructor({ dbName = 'craftgw', idb = globalThis.indexedDB, crypto = globalThis.crypto } = {}) {
    this.dbName = dbName; this.idb = idb; this.crypto = crypto; this._db = null;
  }
  async #open() {
    if (this._db) return this._db;
    this._db = await new Promise((res, rej) => {
      const r = this.idb.open(this.dbName, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this._db;
  }
  async #op(mode, fn) {
    const db = await this.#open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode);
      const r = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(r.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  async #key() {
    let k = await this.#op('readonly', (s) => s.get('__wrapkey'));
    if (!k) {
      k = await this.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await this.#op('readwrite', (s) => s.put(k, '__wrapkey'));
    }
    return k;
  }
  async set(name, value) {
    const key = await this.#key();
    const iv = this.crypto.getRandomValues(new Uint8Array(12));
    const ct = await this.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) }, key, new TextEncoder().encode(value));
    await this.#op('readwrite', (s) => s.put({ iv, ct }, `v:${name}`));
  }
  async get(name) {
    const rec = await this.#op('readonly', (s) => s.get(`v:${name}`));
    if (!rec) return null;
    const pt = await this.crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv, additionalData: new TextEncoder().encode(name) }, await this.#key(), rec.ct);
    return new TextDecoder().decode(pt);
  }
  async delete(name) { await this.#op('readwrite', (s) => s.delete(`v:${name}`)); }
}

export class Connections {
  constructor({ store, fetch: f = globalThis.fetch.bind(globalThis) } = {}) {
    if (!store) throw new Error('a SecretStore is required');
    this.store = store; this.fetch = f;
  }

  async #profiles() { return JSON.parse((await this.store.get('profiles')) || '[]'); }
  async #save(list) { await this.store.set('profiles', JSON.stringify(list)); }
  async #find(name) {
    const p = (await this.#profiles()).find((x) => x.name === name);
    if (!p) throw new Error(`no such connection: ${name}`);
    return p;
  }
  async #update(p) { await this.#save((await this.#profiles()).map((x) => (x.id === p.id ? p : x))); }

  async #raw(baseUrl, method, path, { token, app, body, headers } = {}) {
    const res = await this.fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(app ? { 'x-craft-app': app } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    return res;
  }
  async #json(baseUrl, method, path, o) {
    const res = await this.#raw(baseUrl, method, path, o);
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new GatewayError(res.status, j?.error?.code ?? 'http_error', j?.error?.message ?? `HTTP ${res.status}`);
    return j;
  }

  /** Profiles never contain secrets; the token is stored under profile.tokenRef in the SecretStore. */
  async list() { return this.#profiles(); }

  async add({ name, baseUrl, app = null }) {
    if (!/^[\w .-]{1,64}$/.test(name)) throw new Error('invalid connection name');
    const list = await this.#profiles();
    if (list.some((p) => p.name === name)) throw new Error('connection name already exists');
    const url = assertSecureUrl(baseUrl);
    const h = await this.#json(url, 'GET', '/health');
    const id = `c_${globalThis.crypto.randomUUID()}`;
    const p = { id, name, baseUrl: url, gatewayId: h.gatewayId, gatewayName: h.name, mode: h.mode, userId: null, app, tokenRef: `token:${id}`, expiresAt: null };
    await this.#save([...list, p]);
    return p;
  }

  async login(name, userId, password, { app, scopes, grants } = {}) {
    const p = await this.#find(name);
    const j = await this.#json(p.baseUrl, 'POST', '/auth/login', { body: { userId, password, app: app ?? p.app ?? undefined, scopes, grants } });
    if (j.gatewayId !== p.gatewayId) throw new Error('gateway identity changed; refusing to store token');
    await this.store.set(p.tokenRef, j.token);
    await this.#update({ ...p, userId, app: app ?? p.app, expiresAt: new Date(Date.now() + j.expiresIn * 1000).toISOString(), kind: 'session' });
    return { gatewayId: j.gatewayId, grants: j.grants, expiresIn: j.expiresIn };
  }

  /** Install a pre-issued API token (cg_...) for this gateway. It is verified, then stored in the SecretStore. */
  async installToken(name, token, { app } = {}) {
    const p = await this.#find(name);
    const me = await this.#json(p.baseUrl, 'GET', '/auth/me', { token, app: app ?? p.app });
    if (me.gatewayId !== p.gatewayId) throw new Error('token belongs to a different gateway');
    await this.store.set(p.tokenRef, token);
    await this.#update({ ...p, userId: me.user.userId, app: app ?? p.app, expiresAt: me.expiresAt, kind: 'apitoken' });
    return me;
  }

  async whoami(name) {
    const p = await this.#find(name);
    const token = await this.store.get(p.tokenRef);
    if (!token) throw new Error(`not signed in to ${name}`);
    const me = await this.#json(p.baseUrl, 'GET', '/auth/me', { token, app: p.app });
    if (me.gatewayId !== p.gatewayId) throw new Error('gateway identity mismatch');
    return me;
  }

  /** One row per connection: who you are and which scopes you hold on each gateway. */
  async status() {
    const out = [];
    for (const p of await this.#profiles()) {
      const row = { name: p.name, baseUrl: p.baseUrl, gatewayId: p.gatewayId, app: p.app };
      try { const me = await this.whoami(p.name); Object.assign(row, { signedIn: true, userId: me.user.userId, effectiveApp: me.app, scopes: me.scopes, grants: me.grants, expiresAt: me.expiresAt }); }
      catch (e) { Object.assign(row, { signedIn: false, error: e.message }); }
      out.push(row);
    }
    return out;
  }

  /** Authenticated call. Returns the Response so callers can stream or read bytes. */
  async fetchAs(name, method, path, { body, headers } = {}) {
    const p = await this.#find(name);
    const token = await this.store.get(p.tokenRef);
    if (!token) throw new Error(`not signed in to ${name}`);
    return this.#raw(p.baseUrl, method, path, { token, app: p.app, body, headers });
  }
  async request(name, method, path, o) {
    const p = await this.#find(name);
    const token = await this.store.get(p.tokenRef);
    if (!token) throw new Error(`not signed in to ${name}`);
    return this.#json(p.baseUrl, method, path, { token, app: p.app, ...o });
  }

  async logout(name) {
    const p = await this.#find(name);
    const token = await this.store.get(p.tokenRef);
    if (token) await this.#json(p.baseUrl, 'POST', '/auth/logout', { token, app: p.app }).catch(() => {});
    await this.store.delete(p.tokenRef);
    await this.#update({ ...p, expiresAt: null });
  }
  async remove(name) {
    const p = await this.#find(name);
    await this.logout(name).catch(() => {});
    await this.#save((await this.#profiles()).filter((x) => x.id !== p.id));
  }

  /**
   * Cross-gateway credential: mint one API token per gateway with the same grants (each gateway stores
   * only its own token hash). Returns { name: tokenString }; install each with installToken().
   */
  async mintAcross(names, spec) {
    const out = {};
    for (const n of names) {
      const p = await this.#find(n);
      const j = await this.request(n, 'POST', '/tokens', { body: { ...spec, gateways: [p.gatewayId] } });
      out[n] = j.token;
    }
    return out;
  }
}
