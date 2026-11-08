import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../server/gateway/app.mjs';
import { Store } from '../server/gateway/store.mjs';
import * as C from '../server/gateway/crypto.mjs';

const MK = randomBytes(32).toString('base64');
const PW = 'correct horse battery';

async function boot(opts = {}) {
  const store = new Store();
  const gw = createGateway({ masterKey: MK, store, ...opts });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gw.server.address().port}/api/v1`;
  const call = async (method, path, { token, body, headers } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, text };
  };
  return { gw, store, call, close: () => { gw.server.close(); gw.server.closeAllConnections(); } };
}

test('crypto: scrypt, AES-GCM with AAD, JWT', async () => {
  const h = await C.hashPassword(PW);
  assert.ok(!h.includes(PW));
  assert.ok(await C.verifyPassword(PW, h));
  assert.ok(!(await C.verifyPassword('wrong password!', h)));
  const k = C.deriveKeys(C.parseMasterKey(MK));
  const blob = C.encrypt(k.vault, 'sk-secret', 'a:b');
  assert.equal(C.decrypt(k.vault, blob, 'a:b'), 'sk-secret');
  assert.throws(() => C.decrypt(k.vault, blob, 'a:c'));
  assert.throws(() => C.parseMasterKey('short'));
  const jwt = C.signJwt(k.jwt, { sub: 'x' }, 60);
  assert.equal(C.verifyJwt(k.jwt, jwt).sub, 'x');
  assert.equal(C.verifyJwt(k.jwt, jwt.slice(0, -2) + 'AA'), null);
  assert.equal(C.verifyJwt(k.jwt, C.signJwt(k.jwt, { sub: 'x' }, -10)), null);
  assert.equal(C.maskSecret('sk-abcdefghijkl'), 'sk-…ijkl');
});

test('single-user mode: one account, login, closed signup', async () => {
  const t = await boot();
  assert.equal((await t.call('POST', '/auth/register', { body: { userId: 'Me123', password: 'short' } })).status, 400);
  assert.equal((await t.call('POST', '/auth/register', { body: { userId: 'me123', password: PW } })).status, 201);
  assert.equal((await t.call('POST', '/auth/register', { body: { userId: 'other', password: PW } })).status, 403);
  assert.equal((await t.call('POST', '/auth/login', { body: { userId: 'me123', password: 'nope nope nope' } })).status, 401);
  const login = await t.call('POST', '/auth/login', { body: { userId: 'ME123', password: PW } });
  assert.equal(login.status, 200);
  const me = await t.call('GET', '/auth/me', { token: login.json.token });
  assert.equal(me.json.user.role, 'admin');
  assert.ok(!JSON.stringify(t.store.data).includes(PW), 'no plaintext password stored');
  assert.equal((await t.call('GET', '/auth/me')).status, 401);
  t.close();
});

test('multi-user mode: isolation, admin-created users, scoped tokens', async () => {
  const t = await boot({ mode: 'multi' });
  await t.call('POST', '/auth/register', { body: { userId: 'admin1', password: PW } });
  assert.equal((await t.call('POST', '/auth/register', { body: { userId: 'bob12', password: PW } })).status, 403);
  const a = (await t.call('POST', '/auth/login', { body: { userId: 'admin1', password: PW } })).json.token;
  assert.equal((await t.call('POST', '/users', { token: a, body: { userId: 'bob12', password: PW } })).status, 201);
  const b = (await t.call('POST', '/auth/login', { body: { userId: 'bob12', password: PW } })).json.token;
  assert.equal((await t.call('GET', '/users', { token: b })).status, 403);

  const k = await t.call('POST', '/keys', { token: a, body: { provider: 'gemini', label: 'main', secret: 'AIzaSyEXAMPLEKEY1234' } });
  assert.equal(k.status, 201);
  assert.ok(!k.text.includes('EXAMPLEKEY'));
  assert.equal(k.json.key.masked, 'AIz…1234');
  assert.ok(!JSON.stringify(t.store.data).includes('AIzaSyEXAMPLEKEY1234'), 'encrypted at rest');
  assert.deepEqual((await t.call('GET', '/keys', { token: b })).json.keys, []);
  assert.equal((await t.call('DELETE', `/keys/${k.json.key.id}`, { token: b })).status, 404);

  // scoped API token: read-only keys
  const sub = await t.call('POST', '/auth/login', { body: { userId: 'bob12', password: PW, scopes: ['admin'] } });
  assert.equal(sub.status, 400);
  const tok = await t.call('POST', '/tokens', { token: a, body: { name: 'ro', scopes: ['keys:read'] } });
  assert.equal(tok.status, 201);
  assert.equal((await t.call('GET', '/keys', { token: tok.json.token })).status, 200);
  assert.equal((await t.call('POST', '/keys', { token: tok.json.token, body: { provider: 'ollama', label: 'x' } })).status, 403);
  assert.equal((await t.call('POST', '/tokens', { token: b, body: { name: 'esc', scopes: ['admin'] } })).status, 400);
  assert.ok(!JSON.stringify(t.store.data).includes(tok.json.token), 'api token stored hashed');
  await t.call('DELETE', `/tokens/${tok.json.info.id}`, { token: a });
  assert.equal((await t.call('GET', '/keys', { token: tok.json.token })).status, 401);
  t.close();
});

test('proxy attaches server-side key; client never sees it', async () => {
  const seen = [];
  const up = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echo: true }));
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${up.address().port}`;
  const t = await boot();
  await t.call('POST', '/auth/register', { body: { userId: 'solo1', password: PW } });
  const tok = (await t.call('POST', '/auth/login', { body: { userId: 'solo1', password: PW } })).json.token;
  await t.call('POST', '/keys', { token: tok, body: { provider: 'ollama', label: 'local', secret: 'upstream-secret-123', baseUrl: upBase } });
  assert.equal((await t.call('POST', '/keys', { token: tok, body: { provider: 'openai', label: 'x', secret: 'k', baseUrl: upBase } })).status, 400);

  const r = await t.call('POST', '/proxy/ollama/api/generate?stream=0', { token: tok, body: { model: 'm' }, headers: { 'x-goog-api-key': 'client-sent' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { echo: true });
  assert.equal(seen[0].url, '/api/generate?stream=0');
  assert.equal(seen[0].headers.authorization, 'Bearer upstream-secret-123');
  assert.equal(seen[0].headers['x-goog-api-key'], undefined);
  assert.ok(!r.text.includes('upstream-secret'));
  assert.equal((await t.call('GET', '/proxy/gemini/v1/models', { token: tok })).status, 404, 'no gemini key');
  assert.equal((await t.call('GET', '/proxy/ollama/x%2f%2e%2e%2f%2e%2e%2fy', { token: tok })).status, 400);
  assert.equal((await t.call('GET', '/proxy/nope/x', { token: tok })).status, 404);
  assert.equal((await t.call('GET', '/proxy/ollama/x')).status, 401);
  t.close(); up.close(); up.closeAllConnections();
});

test('login throttling after repeated failures', async () => {
  const t = await boot();
  await t.call('POST', '/auth/register', { body: { userId: 'solo1', password: PW } });
  let last;
  for (let i = 0; i < 6; i++) last = await t.call('POST', '/auth/login', { body: { userId: 'solo1', password: 'wrongwrongwrong' } });
  assert.equal(last.status, 429);
  t.close();
});
