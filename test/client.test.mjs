import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../server/gateway/app.mjs';
import { Store } from '../server/gateway/store.mjs';
import * as C from '../server/gateway/crypto.mjs';
import { Connections, BrowserSecretStore, MemorySecretStore, assertSecureUrl } from '../client/craftgw.mjs';
import { EncryptedFileStore, KeychainStore, sealSecrets, openSecrets } from '../client/node-store.mjs';

const V = JSON.parse(readFileSync(new URL('../docs/test-vectors.json', import.meta.url), 'utf8'));
const PW = 'correct horse battery';

test('published test vectors reproduce', async () => {
  const p = V.passwordHash;
  assert.equal(await C.hashPassword(p.password, Buffer.from(p.saltB64, 'base64')), p.expected);
  assert.ok(await C.verifyPassword(p.password, p.expected));
  const j = V.jwt, key = Buffer.from(j.keyHex, 'hex');
  assert.equal(C.signJwt(key, j.claims, j.ttl, j.now), j.expected);
  assert.equal(C.sha256(V.apiTokenHash.token), V.apiTokenHash.expectedSha256Hex);
  const r = V.vaultRecord, vk = Buffer.from(r.keyHex, 'hex');
  assert.deepEqual(C.encrypt(vk, r.plaintext, r.aad, Buffer.from(r.ivHex, 'hex')), r.expected);
  assert.equal(C.decrypt(vk, r.expected, r.aad), r.plaintext);
  const f = V.secretFilePassphrase;
  assert.deepEqual(sealSecrets(f.plaintextMap, { passphrase: f.passphrase, salt: Buffer.from(f.saltHex, 'hex'), iv: Buffer.from(f.ivHex, 'hex') }), f.expected);
  assert.deepEqual(openSecrets(f.expected, { passphrase: f.passphrase }), f.plaintextMap);
  const k = V.secretFileKeyfile;
  assert.deepEqual(sealSecrets(k.plaintextMap, { key: Buffer.from(k.keyHex, 'hex'), iv: Buffer.from(k.ivHex, 'hex') }), k.expected);
});

test('encrypted file store: 0600, no plaintext, tamper/wrong passphrase rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'craftgw-'));
  try {
    const s = new EncryptedFileStore({ path: join(dir, 's.json'), passphrase: undefined });
    await s.set('token:a', 'cg_supersecret');
    assert.equal(await s.get('token:a'), 'cg_supersecret');
    assert.equal(statSync(s.path).mode & 0o777, 0o600);
    assert.equal(statSync(s.keyPath).mode & 0o777, 0o600);
    assert.ok(!readFileSync(s.path, 'utf8').includes('cg_supersecret'));
    await s.delete('token:a');
    assert.equal(await s.get('token:a'), null);

    const pp = new EncryptedFileStore({ path: join(dir, 'p.json'), passphrase: 'right passphrase' });
    await pp.set('x', 'secret-value');
    assert.ok(!readFileSync(pp.path, 'utf8').includes('secret-value'));
    await assert.rejects(new EncryptedFileStore({ path: pp.path, passphrase: 'wrong passphrase' }).get('x'));
    const f = JSON.parse(readFileSync(pp.path, 'utf8')); f.ct = Buffer.from('tampered').toString('base64');
    writeFileSync(pp.path, JSON.stringify(f));
    await assert.rejects(pp.get('x'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('keychain store keeps secrets off argv (linux secret-tool, macOS security -i)', async () => {
  const calls = [];
  const run = async (cmd, args, input) => { calls.push({ cmd, args, input }); };
  const lin = new KeychainStore({ os: 'linux', exec: async () => ({ stdout: 'v' }), spawnStdin: run });
  await lin.set('token:a', 'cg_secret');
  assert.deepEqual(calls[0].args.slice(0, 1), ['store']);
  assert.ok(!JSON.stringify(calls[0].args).includes('cg_secret'));
  assert.equal(calls[0].input, 'cg_secret');
  const mac = new KeychainStore({ os: 'darwin', exec: async () => ({ stdout: 'v\n' }), spawnStdin: run });
  await mac.set('token:a', 'cg_secret');
  assert.deepEqual(calls[1].args, ['-i']);
  assert.match(calls[1].input, /cg_secret/);
  assert.equal(await mac.get('token:a'), 'v');
  assert.equal(await new KeychainStore({ os: 'win32' }).available(), false);
});

function fakeIdb() {
  const data = new Map();
  return {
    data,
    open() {
      const r = {};
      queueMicrotask(() => {
        r.result = {
          createObjectStore() {},
          transaction() {
            const tx = {};
            tx.objectStore = () => ({
              get(k) { const q = {}; queueMicrotask(() => { q.result = data.get(k); }); return q; },
              put(v, k) { data.set(k, v); return {}; },
              delete(k) { data.delete(k); return {}; },
            });
            queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
            return tx;
          },
        };
        r.onupgradeneeded?.(); r.onsuccess?.();
      });
      return r;
    },
  };
}

test('browser store: non-extractable WebCrypto key, ciphertext only at rest', async () => {
  const idb = fakeIdb();
  const s = new BrowserSecretStore({ idb, crypto: webcrypto });
  await s.set('token:a', 'cg_supersecret');
  assert.equal(await s.get('token:a'), 'cg_supersecret');
  assert.equal(await s.get('missing'), null);
  const wrap = idb.data.get('__wrapkey');
  assert.equal(wrap.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', wrap));
  const rec = idb.data.get('v:token:a');
  assert.ok(!Buffer.from(rec.ct).toString('latin1').includes('cg_supersecret'));
  // AAD binds the ciphertext to its name
  idb.data.set('v:token:b', rec);
  await assert.rejects(s.get('token:b'));
  await s.delete('token:a');
  assert.equal(await s.get('token:a'), null);
});

async function boot(opts) {
  const gw = createGateway({ masterKey: randomBytes(32).toString('base64'), store: new Store(), ...opts });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${gw.server.address().port}`;
  const post = (path, body, token) => fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  await post('/auth/register', { userId: 'me123', password: PW });
  return { url, gw, post, close: () => { gw.server.close(); gw.server.closeAllConnections(); } };
}

test('one user signed in to several gateways with different permissions', async () => {
  const home = await boot({ mode: 'single' }), lab = await boot({ mode: 'multi' });
  const writes = [];
  const mem = new MemorySecretStore();
  const store = { get: (n) => mem.get(n), delete: (n) => mem.delete(n), set: (n, v) => { writes.push([n, v]); return mem.set(n, v); } };
  const c = new Connections({ store });
  assert.throws(() => assertSecureUrl('http://example.com'));
  await assert.rejects(c.add({ name: 'bad', baseUrl: 'http://example.com' }));
  await c.add({ name: 'home', baseUrl: home.url });
  await c.add({ name: 'lab', baseUrl: lab.url, app: 'ataricraft' });
  await c.login('home', 'me123', PW);
  const r = await c.login('lab', 'me123', PW, { scopes: ['data:read', 'data:write'] });
  assert.equal(r.grants[0].app, 'ataricraft');

  const st = await c.status();
  assert.equal(st.length, 2);
  const [h, l] = st;
  assert.equal(h.signedIn, true); assert.ok(h.scopes.includes('keys:write')); assert.equal(h.effectiveApp, '*');
  assert.deepEqual(l.scopes, ['data:read', 'data:write']); assert.equal(l.effectiveApp, 'ataricraft');
  assert.notEqual(h.gatewayId, l.gatewayId);

  // lab session is app-bound with no key scopes; home has them
  await assert.rejects(c.request('lab', 'GET', '/keys'), /missing scope keys:read/);
  assert.equal((await c.request('home', 'GET', '/keys')).keys.length, 0);
  const made = await c.request('lab', 'POST', '/resources', { body: { type: 'diskimage', name: 'd.atr', data: Buffer.from('ATR').toString('base64') } });
  assert.equal(made.resource.app, 'ataricraft');
  const bytes = await (await c.fetchAs('lab', 'GET', `/resources/${made.resource.id}/content`)).text();
  assert.equal(bytes, 'ATR');

  // secrets: password never stored; profiles hold no token
  assert.ok(!JSON.stringify(writes).includes(PW));
  const profiles = await c.list();
  assert.ok(!JSON.stringify(profiles).includes('eyJ'));
  assert.ok(profiles.every((p) => p.tokenRef.startsWith('token:')));

  // cross-gateway credential: one spec, one token per gateway, installed via installToken
  const minted = await c.mintAcross(['home'], { name: 'cli', grants: [{ app: '3dcraft', scopes: ['data:read'] }] });
  await c.add({ name: 'home-3d', baseUrl: home.url, app: '3dcraft' });
  const me = await c.installToken('home-3d', minted.home);
  assert.deepEqual(me.scopes, ['data:read']);
  assert.equal(me.app, '3dcraft');
  await assert.rejects(c.installToken('lab', minted.home), /different gateway|not valid|unauthorized|invalid/i);

  // identity pinning: a profile whose pinned id no longer matches is refused
  const tampered = (await c.list()).map((p) => (p.name === 'home' ? { ...p, gatewayId: 'gw_other' } : p));
  await mem.set('profiles', JSON.stringify(tampered));
  await assert.rejects(c.whoami('home'), /mismatch/);
  await mem.set('profiles', JSON.stringify((await c.list()).map((p) => (p.name === 'home' ? { ...p, gatewayId: h.gatewayId } : p))));

  // logout revokes server-side
  const tok = await mem.get((await c.list()).find((p) => p.name === 'home').tokenRef);
  await c.logout('home');
  assert.equal((await fetch(`${home.url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${tok}` } })).status, 401);
  await assert.rejects(c.whoami('home'), /not signed in/);
  await c.remove('lab');
  assert.equal((await c.list()).some((p) => p.name === 'lab'), false);
  home.close(); lab.close();
});
