import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../server/gateway/app.mjs';
import { Store } from '../server/gateway/store.mjs';
import * as C from '../server/gateway/crypto.mjs';
import { vetUpstream, isBlockedIp, parseAllowList } from '../server/gateway/ssrf.mjs';

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

test('ssrf: ip classification and allow-list parsing', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:169.254.169.254', '::ffff:127.0.0.1', '100.64.0.1']) assert.ok(isBlockedIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isBlockedIp(ip), ip);
  await assert.rejects(vetUpstream('http://169.254.169.254/latest'));
  await assert.rejects(vetUpstream('http://[::ffff:10.0.0.1]/'));
  await assert.rejects(vetUpstream('http://localhost:9/'));
  await assert.rejects(vetUpstream('file:///etc/passwd'));
  await assert.rejects(vetUpstream('http://user:pw@8.8.8.8/'));
  await assert.rejects(vetUpstream('http://does-not-resolve.invalid/'));
  assert.equal((await vetUpstream('http://8.8.8.8:8080/x')).ip, '8.8.8.8');
  assert.equal((await vetUpstream('http://localhost:9/', { allowLoopback: true })).port, 9);
  const al = parseAllowList('10.0.0.5:8080, 192.168.0.0/16, ollama.lan');
  await vetUpstream('http://10.0.0.5:8080/', { allowList: al });
  await assert.rejects(vetUpstream('http://10.0.0.5:9/', { allowList: al }));
  await vetUpstream('http://192.168.4.4/', { allowList: al });
  await assert.rejects(vetUpstream('http://10.0.0.6:8080/', { allowList: al }));
});

test('ssrf: single mode blocks metadata/private/self, allows loopback', async () => {
  const t = await boot();
  await t.call('POST', '/auth/register', { body: { userId: 'solo1', password: PW } });
  const tok = (await t.call('POST', '/auth/login', { body: { userId: 'solo1', password: PW } })).json.token;
  const add = (baseUrl, label) => t.call('POST', '/keys', { token: tok, body: { provider: 'custom', label, baseUrl } });
  assert.equal((await add('http://169.254.169.254/', 'a')).status, 400);
  assert.equal((await add('http://10.0.0.1:11434/', 'b')).status, 400);
  assert.equal((await add('http://[::ffff:169.254.169.254]/', 'c')).status, 400);
  assert.equal((await add('http://localhost:11434/', 'd')).status, 201);
  const self = t.gw.server.address().port;
  const r = await add(`http://127.0.0.1:${self}/`, 'e');
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /gateway itself/);
  assert.equal((await add(`http://localhost:${self}/`, 'f')).status, 400);
  t.close();
});

test('ssrf: multi mode restricts baseUrl to admins, allow-list is honoured', async () => {
  const t = await boot({ mode: 'multi' });
  await t.call('POST', '/auth/register', { body: { userId: 'admin1', password: PW } });
  const a = (await t.call('POST', '/auth/login', { body: { userId: 'admin1', password: PW } })).json.token;
  await t.call('POST', '/users', { token: a, body: { userId: 'bob12', password: PW } });
  const b = (await t.call('POST', '/auth/login', { body: { userId: 'bob12', password: PW } })).json.token;
  const add = (token, baseUrl, label) => t.call('POST', '/keys', { token, body: { provider: 'ollama', label, baseUrl } });
  assert.equal((await add(b, 'http://8.8.8.8:11434', 'x')).status, 403);
  assert.equal((await add(a, 'http://127.0.0.1:11434', 'x')).status, 400, 'loopback not default-allowed in multi');
  assert.equal((await add(a, 'http://169.254.169.254', 'y')).status, 400);
  assert.equal((await add(a, 'http://8.8.8.8:11434', 'z')).status, 201);
  assert.equal((await t.call('POST', '/keys', { token: b, body: { provider: 'ollama', label: 'plain' } })).status, 201);
  t.close();

  const t2 = await boot({ mode: 'multi', upstreamAllow: '127.0.0.1:11434' });
  await t2.call('POST', '/auth/register', { body: { userId: 'admin1', password: PW } });
  const a2 = (await t2.call('POST', '/auth/login', { body: { userId: 'admin1', password: PW } })).json.token;
  const k = (baseUrl, label) => t2.call('POST', '/keys', { token: a2, body: { provider: 'ollama', label, baseUrl } });
  assert.equal((await k('http://127.0.0.1:11434', 'ok')).status, 201);
  assert.equal((await k('http://127.0.0.1:9999', 'no')).status, 400);
  t2.close();

  const t3 = await boot({ mode: 'multi', upstreamAllow: '127.0.0.0/8' });
  await t3.call('POST', '/auth/register', { body: { userId: 'admin1', password: PW } });
  const a3 = (await t3.call('POST', '/auth/login', { body: { userId: 'admin1', password: PW } })).json.token;
  const k3 = (baseUrl, label) => t3.call('POST', '/keys', { token: a3, body: { provider: 'ollama', label, baseUrl } });
  assert.equal((await k3('http://127.0.0.1:12345', 'ok')).status, 201);
  assert.equal((await k3(`http://127.0.0.1:${t3.gw.server.address().port}`, 'self')).status, 400, 'self blocked even when allow-listed');
  t3.close();
});

test('ssrf: proxy re-vets at request time and never reaches blocked hosts', async () => {
  let hits = 0;
  const up = createServer((q, s) => { hits++; s.end('{}'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const t = await boot({ mode: 'multi' });
  await t.call('POST', '/auth/register', { body: { userId: 'admin1', password: PW } });
  const a = (await t.call('POST', '/auth/login', { body: { userId: 'admin1', password: PW } })).json.token;
  const k = await t.call('POST', '/keys', { token: a, body: { provider: 'ollama', label: 'l' } });
  // simulate a stored/legacy or later-poisoned record: blocked baseUrl, plus a self-pointing one
  t.store.data.keys[k.json.key.id].baseUrl = `http://127.0.0.1:${up.address().port}`;
  const r = await t.call('GET', '/proxy/ollama/api/tags', { token: a });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'upstream_blocked');
  t.store.data.keys[k.json.key.id].baseUrl = `http://127.0.0.1:${t.gw.server.address().port}`;
  assert.equal((await t.call('GET', '/proxy/ollama/api/tags', { token: a })).status, 403);
  t.store.data.keys[k.json.key.id].baseUrl = 'http://169.254.169.254';
  assert.equal((await t.call('GET', '/proxy/ollama/latest/meta-data', { token: a })).status, 403);
  assert.equal(hits, 0);
  t.close(); up.close(); up.closeAllConnections();
});

test('ssrf: hex-mapped, IPv4-compatible and 6to4 forms are reduced to the embedded IPv4', async () => {
  const blocked = [
    '::ffff:7f00:1', '::ffff:7F00:0001', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:ac10:1',
    '::7f00:1', '::127.0.0.1', '::a9fe:a9fe', '::a00:1', '::c0a8:1',
    '2002:7f00:1::', '2002:7f00:1::1', '2002:a9fe:a9fe::', '2002:a00:1::', '2002:c0a8:101::', '2002:ac10:1::',
  ];
  for (const ip of blocked) assert.ok(isBlockedIp(ip), `${ip} should be blocked`);
  for (const ip of ['::ffff:808:808', '2002:808:808::', '::808:808', '2606:4700::1111']) assert.ok(!isBlockedIp(ip), `${ip} should be allowed`);
  for (const ip of blocked) await assert.rejects(vetUpstream(`http://[${ip}]:8080/`), `${ip} via vetUpstream`);
  await vetUpstream('http://[::ffff:808:808]:8080/');
  // allow-list entries match the embedded IPv4, and loopback allowance applies to the embedded form too
  await vetUpstream('http://[::ffff:a00:5]:8080/', { allowList: parseAllowList('10.0.0.5:8080') });
  await assert.rejects(vetUpstream('http://[::ffff:a00:6]:8080/', { allowList: parseAllowList('10.0.0.5:8080') }));
  await vetUpstream('http://[::ffff:7f00:1]:9/', { allowLoopback: true });
  await assert.rejects(vetUpstream('http://[::ffff:7f00:1]:9/'));
});

test('ssrf: self-port check catches every loopback encoding, even when allow-listed', async () => {
  const self = 4321;
  for (const h of ['[::ffff:7f00:1]', '[::7f00:1]', '[2002:7f00:1::]', '[::ffff:127.0.0.1]', '127.0.0.1', '[::1]']) {
    await assert.rejects(vetUpstream(`http://${h}:${self}/`, { allowLoopback: true, self: { port: self, host: '127.0.0.1' } }), /gateway itself/, h);
    await assert.rejects(vetUpstream(`http://${h}:${self}/`, { allowList: parseAllowList('127.0.0.0/8, ::1'), self: { port: self, host: '127.0.0.1' } }), /gateway itself/, h);
  }
  const t = await boot({ mode: 'multi', upstreamAllow: '127.0.0.0/8' });
  await t.call('POST', '/auth/register', { body: { userId: 'admin1', password: PW } });
  const a = (await t.call('POST', '/auth/login', { body: { userId: 'admin1', password: PW } })).json.token;
  const port = t.gw.server.address().port;
  let n = 0;
  for (const h of ['[::ffff:7f00:1]', '[::7f00:1]', '[2002:7f00:1::]']) {
    const r = await t.call('POST', '/keys', { token: a, body: { provider: 'ollama', label: `s${n++}`, baseUrl: `http://${h}:${port}` } });
    assert.equal(r.status, 400, h);
    assert.match(r.json.error.message, /gateway itself|allow-list|private/);
  }
  // and the request-time re-check, with a poisoned stored record
  const k = (await t.call('POST', '/keys', { token: a, body: { provider: 'ollama', label: 'ok' } })).json.key;
  t.store.data.keys[k.id].baseUrl = `http://[::ffff:7f00:1]:${port}`;
  const r = await t.call('GET', '/proxy/ollama/api/tags', { token: a });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'upstream_blocked');
  t.close();
});
