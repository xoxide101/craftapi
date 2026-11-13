import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createGateway } from '../server/gateway/app.mjs';
import { Store } from '../server/gateway/store.mjs';
import { AuditLog, verifyChain } from '../server/gateway/audit.mjs';
import * as C from '../server/gateway/crypto.mjs';

const MK = randomBytes(32).toString('base64');
const PW = 'correct horse battery';
const b64 = (s) => Buffer.from(s).toString('base64');

async function boot(opts = {}) {
  const store = opts.store ?? new Store();
  const gw = createGateway({ masterKey: MK, store, mode: 'multi', ...opts });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gw.server.address().port}/api/v1`;
  const call = async (method, path, { token, body, app } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(app ? { 'x-craft-app': app } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const login = async (userId) => (await call('POST', '/auth/login', { body: { userId, password: PW } })).json.token;
  await call('POST', '/auth/register', { body: { userId: 'admin1', password: PW } });
  const admin = await login('admin1');
  await call('POST', '/users', { token: admin, body: { userId: 'alice', password: PW } });
  await call('POST', '/users', { token: admin, body: { userId: 'bobby', password: PW } });
  return { gw, call, login, admin, base, close: () => { gw.server.close(); gw.server.closeAllConnections(); } };
}

test('audit: records the security events and never secrets', async () => {
  const up = createServer((q, r) => r.end('{}'));
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const t = await boot({ upstreamAllow: '127.0.0.1' });
  t.gw.server.on('close', () => { up.close(); up.closeAllConnections(); });
  const alice = await t.login('alice'), bob = await t.login('bobby');
  await t.call('POST', '/auth/login', { body: { userId: 'alice', password: 'wrong-wrong-wrong' } });
  await t.call('POST', '/auth/login', { body: { userId: 'hunter2 is my password', password: 'x' } });
  const tok = (await t.call('POST', '/tokens', { token: alice, body: { name: 'ro', app: 'imagecraft', scopes: ['data:read'] } })).json;
  await t.call('DELETE', `/tokens/${tok.info.id}`, { token: alice });
  const k = (await t.call('POST', '/keys', { token: t.admin, body: { provider: 'ollama', label: 'g', secret: 'AIzaSySUPERSECRETVALUE9999', baseUrl: `http://127.0.0.1:${up.address().port}` } })).json.key;
  assert.equal((await t.call('GET', '/proxy/ollama/api/tags', { token: t.admin })).status, 200);
  const r = (await t.call('POST', '/resources', { token: alice, body: { type: 'asset', name: 'a', data: b64('x') } })).json.resource;
  await t.call('PUT', `/resources/${r.id}/acl`, { token: alice, body: { acl: [{ principal: { kind: 'user', id: 'bobby' }, perms: ['read'] }] } });
  await t.call('GET', `/resources/${r.id}`, { token: bob }); // allowed
  await t.call('PUT', `/resources/${r.id}/content`, { token: bob, body: undefined }); // 403 write denied
  await t.call('GET', '/resources/res_doesnotexist', { token: bob }); // 404 denied-as-not-found
  await t.call('GET', '/keys', { token: tok.token }); // revoked token -> 401
  await t.call('DELETE', `/keys/${k.id}`, { token: t.admin });
  await t.call('POST', '/auth/logout', { token: bob });
  await t.call('POST', '/auth/revoke-all', { token: alice });

  const entries = (await t.call('GET', '/admin/audit?limit=1000', { token: t.admin })).json.entries;
  const ev = entries.map((e) => e.event);
  for (const e of ['login.success', 'login.failure', 'user.create', 'token.create', 'token.revoke', 'key.create', 'key.use', 'key.delete', 'acl.change', 'access.denied', 'logout', 'token.revoke_all']) assert.ok(ev.includes(e), `missing ${e}`);
  const denied = entries.filter((e) => e.event === 'access.denied');
  assert.ok(denied.some((e) => e.status === 403) && denied.some((e) => e.status === 404) && denied.some((e) => e.status === 401));
  const fail = entries.filter((e) => e.event === 'login.failure');
  assert.equal(fail[0].target, 'alice');
  assert.equal(fail[1].target, '[invalid]', 'free-text userId is never logged');
  const dump = JSON.stringify(entries);
  for (const secret of [PW, 'wrong-wrong-wrong', 'AIzaSySUPERSECRETVALUE9999', tok.token, alice, bob, 'hunter2']) assert.ok(!dump.includes(secret), `leaked ${secret.slice(0, 6)}`);
  assert.ok(!/scrypt\$/.test(dump));
  assert.equal(entries.find((e) => e.event === 'key.use').actor, 'admin1');
  assert.deepEqual(verifyChain(entries), { ok: true });
  assert.equal((await t.call('GET', '/admin/audit', { token: await t.login('alice') })).status, 403);
  assert.equal((await t.call('GET', '/admin/audit')).status, 401);
  t.close();
});

test('audit log: hash chain detects tampering, file is append-only 0600 and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const path = join(dir, 'a.jsonl');
    const a = new AuditLog(path);
    a.record('one', { x: 1 }); a.record('two', { x: 2 }); a.record('three', { x: 3 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => a.record('bad', { password: 'x' }), /not allowed/);
    assert.throws(() => a.record('bad', { apiKey: 'x' }), /not allowed/);
    const b = new AuditLog(path); // restart continues the chain
    b.record('four');
    const entries = b.entries();
    assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3, 4]);
    assert.deepEqual(verifyChain(entries), { ok: true });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const edit = [...lines]; edit[1] = edit[1].replace('"x":2', '"x":9');
    assert.deepEqual(verifyChain(edit.map((l) => JSON.parse(l))), { ok: false, badSeq: 2 });
    const del = lines.filter((_, i) => i !== 1).map((l) => JSON.parse(l));
    assert.equal(verifyChain(del).ok, false, 'deleted entry detected');
    writeFileSync(path, lines.join('\n') + '\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit: persisted next to the store file by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gwstore-'));
  try {
    const t = await boot({ store: new Store(join(dir, 'gw.json')) });
    await t.login('alice');
    t.close();
    const lines = readFileSync(join(dir, 'gw.json.audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((e) => e.event === 'login.success' && e.target === 'alice'));
    assert.ok(verifyChain(lines).ok);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('jwt rotation: kid header, previous key accepted until retired, unknown kid rejected', async () => {
  const store = new Store();
  const gw1 = await boot({ store, jwtKid: 'v1' });
  const old = await gw1.login('alice');
  assert.equal(JSON.parse(Buffer.from(old.split('.')[0], 'base64url')).kid, 'v1');
  gw1.close();

  // rotate: new current kid, previous kept
  const gw2 = await boot({ store, jwtKid: 'k2', jwtPreviousKids: ['v1'], gatewayId: store.data.meta.gatewayId });
  assert.equal((await gw2.call('GET', '/auth/me', { token: old })).status, 200, 'token signed with the previous key still works');
  const fresh = await gw2.login('alice');
  assert.equal(JSON.parse(Buffer.from(fresh.split('.')[0], 'base64url')).kid, 'k2');
  assert.equal((await gw2.call('GET', '/auth/me', { token: fresh })).status, 200);
  gw2.close();

  // retire v1
  const gw3 = await boot({ store, jwtKid: 'k2', gatewayId: store.data.meta.gatewayId });
  assert.equal((await gw3.call('GET', '/auth/me', { token: old })).status, 401, 'retired key rejected');
  assert.equal((await gw3.call('GET', '/auth/me', { token: fresh })).status, 200);
  // forged kid / forged signature / alg none
  const [h, p, s] = fresh.split('.');
  const forgedKid = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'v1' })).toString('base64url');
  assert.equal((await gw3.call('GET', '/auth/me', { token: `${forgedKid}.${p}.${s}` })).status, 401);
  const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k2' })).toString('base64url');
  assert.equal((await gw3.call('GET', '/auth/me', { token: `${none}.${p}.` })).status, 401);
  void h;
  gw3.close();
});

test('jwt rotation at the crypto layer: legacy kid-less tokens use v1; vectors unchanged', () => {
  const master = C.parseMasterKey(MK);
  const ring = C.deriveKeys(master, { kid: 'k2', previousKids: ['v1'] });
  const legacy = C.signJwt(C.deriveKeys(master).jwt, { sub: 'x' }, 60); // no kid header
  assert.equal(C.verifyJwt((k) => ring.jwtRing.get(k), legacy).sub, 'x');
  assert.notDeepEqual(ring.jwtRing.get('k2'), ring.jwtRing.get('v1'));
  assert.equal(C.verifyJwt((k) => ring.jwtRing.get(k), C.signJwt(ring.jwt, { sub: 'y' }, -5, undefined, 'k2')), null, 'expired');
});

test('npm test browser wrapper skips cleanly without Chrome/3dcraft and can be made strict', () => {
  const run = (env) => spawnSync(process.execPath, ['server/run-browser-tests.mjs'], { env: { ...process.env, CHROME_PATH: '/nonexistent/chrome', CRAFT3D_INDEX: '/nonexistent/index.html', ...env }, encoding: 'utf8' });
  const r = run({});
  // On machines with a real Chrome in the default Windows path this wouldn't skip; here the 3dcraft path is always missing.
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SKIPPED browser smoke tests/);
  const strict = run({ CRAFT_REQUIRE_BROWSER: '1' });
  assert.equal(strict.status, 1);
});
