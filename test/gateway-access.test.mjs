import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../server/gateway/app.mjs';
import { Store } from '../server/gateway/store.mjs';

const MK = randomBytes(32).toString('base64');
const PW = 'correct horse battery';

async function boot(opts = {}) {
  const store = new Store();
  const gw = createGateway({ masterKey: MK, store, mode: 'multi', ...opts });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gw.server.address().port}/api/v1`;
  const call = async (method, path, { token, body, app, headers, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(app ? { 'x-craft-app': app } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async (userId, extra = {}) => (await call('POST', '/auth/login', { body: { userId, password: PW, ...extra } })).json.token;
  await call('POST', '/auth/register', { body: { userId: 'admin1', password: PW } });
  const admin = await login('admin1');
  for (const u of ['alice', 'bobby']) await call('POST', '/users', { token: admin, body: { userId: u, password: PW } });
  return { gw, store, call, login, admin, close: () => { gw.server.close(); gw.server.closeAllConnections(); } };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const mk = (t, token, extra = {}) => t.call('POST', '/resources', { token, body: { type: 'clipart', name: 'star', data: b64('SVGDATA'), ...extra } });

test('deny by default: nothing readable without explicit ACL, no anonymous access', async () => {
  const t = await boot();
  const alice = await t.login('alice'), bob = await t.login('bobby');
  const r = (await mk(t, alice)).json.resource;
  assert.equal((await t.call('GET', `/resources/${r.id}`)).status, 401);
  assert.equal((await t.call('GET', `/public/resources/${r.id}/content`)).status, 404);
  assert.equal((await t.call('GET', `/resources/${r.id}/content`, { token: bob })).status, 404);
  assert.deepEqual((await t.call('GET', '/resources', { token: bob })).json.resources, []);
  assert.equal((await t.call('GET', `/resources/${r.id}/content`, { token: alice })).text, 'SVGDATA');
  // admin role does not get content access implicitly, but can list/manage
  assert.equal((await t.call('GET', `/resources/${r.id}/content`, { token: t.admin })).status, 403);
  const listing = await t.call('GET', '/admin/resources', { token: t.admin });
  assert.equal(listing.json.resources.length, 1);
  assert.equal((await t.call('GET', '/admin/resources', { token: alice })).status, 403);
  // unknown routes and anonymous: nothing is public
  assert.equal((await t.call('GET', '/resources')).status, 401);
  assert.equal((await t.call('GET', '/keys')).status, 401);
  t.close();
});

test('cross-user isolation and ACL grants incl. everyone/public admin-only', async () => {
  const t = await boot();
  const alice = await t.login('alice'), bob = await t.login('bobby');
  const r = (await mk(t, alice, { type: 'font' })).json.resource;
  const acl = (token, entries) => t.call('PUT', `/resources/${r.id}/acl`, { token, body: { acl: entries } });
  assert.equal((await acl(bob, [])).status, 404, 'bob cannot even see it');
  assert.equal((await acl(alice, [{ principal: { kind: 'user', id: 'bobby' }, perms: ['read'] }])).status, 200);
  assert.equal((await t.call('GET', `/resources/${r.id}/content`, { token: bob })).status, 200);
  const w = await t.call('PUT', `/resources/${r.id}/content`, { token: bob, raw: 'x', headers: { 'content-type': 'text/plain' } });
  assert.equal(w.status, 403, 'read-only grant cannot write');
  assert.equal((await t.call('DELETE', `/resources/${r.id}`, { token: bob })).status, 403);
  // everyone / public: only admin
  assert.equal((await acl(alice, [{ principal: { kind: 'role', id: 'everyone' }, perms: ['read'] }])).status, 403);
  assert.equal((await acl(alice, [{ principal: { kind: 'public' }, perms: ['read'] }])).status, 403);
  assert.equal((await acl(t.admin, [{ principal: { kind: 'public' }, perms: ['write'] }])).status, 400);
  assert.equal((await acl(t.admin, [{ principal: { kind: 'role', id: 'everyone' }, perms: ['admin'] }])).status, 400);
  assert.equal((await acl(t.admin, [{ principal: { kind: 'public' }, perms: ['read'] }])).status, 200);
  assert.equal((await t.call('GET', `/public/resources/${r.id}/content`)).status, 200);
  // owner cannot strip admin-granted public entry
  assert.equal((await acl(alice, [])).status, 403);
  assert.equal((await acl(t.admin, [])).status, 200);
  assert.equal((await t.call('GET', `/public/resources/${r.id}/content`)).status, 404);
  // everyone role, then roles
  await acl(t.admin, [{ principal: { kind: 'role', id: 'everyone' }, perms: ['read'] }]);
  assert.equal((await t.call('GET', `/resources/${r.id}/content`, { token: bob })).status, 200);
  await acl(t.admin, [{ principal: { kind: 'role', id: 'designers' }, perms: ['write'] }]);
  assert.equal((await t.call('GET', `/resources/${r.id}/content`, { token: bob })).status, 404);
  const users = (await t.call('GET', '/users', { token: t.admin })).json.users;
  const bobId = users.find((u) => u.userId === 'bobby').id;
  assert.equal((await t.call('PUT', `/users/${bobId}/roles`, { token: t.admin, body: { roles: ['everyone'] } })).status, 400, 'everyone is never assignable');
  await t.call('PUT', `/users/${bobId}/roles`, { token: t.admin, body: { roles: ['designers'] } });
  assert.equal((await t.call('PUT', `/resources/${r.id}/content`, { token: bob, raw: 'new' })).status, 200);
  t.close();
});

test('who-can-access query and admin listing', async () => {
  const t = await boot();
  const alice = await t.login('alice'), bob = await t.login('bobby');
  const r = (await mk(t, alice)).json.resource;
  await t.call('PUT', `/resources/${r.id}/acl`, { token: alice, body: { acl: [{ principal: { kind: 'user', id: 'bobby' }, perms: ['read'] }, { principal: { kind: 'app', id: 'imagecraft' }, perms: ['read'] }] } });
  const q = await t.call('GET', `/resources/${r.id}/access`, { token: alice });
  assert.equal(q.status, 200);
  assert.deepEqual(q.json.access[0].resolved, ['alice']);
  assert.deepEqual(q.json.access[1].resolved, ['bobby']);
  assert.match(q.json.access[2].resolved, /imagecraft/);
  assert.equal((await t.call('GET', `/resources/${r.id}/access`, { token: bob })).status, 403, 'readers cannot enumerate access');
  const adminView = await t.call('GET', `/resources/${r.id}/access`, { token: t.admin });
  assert.equal(adminView.status, 200);
  assert.equal((await t.call('GET', '/resource-types', { token: alice })).json.types.diskimage.description.length > 0, true);
  t.close();
});

test('app binding is verified on every request', async () => {
  const t = await boot();
  const alice = await t.login('alice');
  const mint = (body) => t.call('POST', '/tokens', { token: alice, body });
  const appTok = (await mint({ name: 'atari', app: 'ataricraft', scopes: ['data:read', 'data:write', 'keys:read', 'keys:write', 'proxy:use'] })).json.token;
  const multi = (await mint({ name: 'two', grants: [{ app: 'imagecraft', scopes: ['data:read'] }, { app: '3dcraft', scopes: ['data:read', 'data:write'] }] })).json.token;
  const userWide = (await mint({ name: 'all', scopes: ['data:read', 'data:write'] })).json.token;

  assert.equal((await t.call('GET', '/resources', { token: appTok })).status, 403, 'app-bound needs X-Craft-App');
  assert.equal((await t.call('GET', '/resources', { token: appTok, app: 'imagecraft' })).status, 403);
  assert.equal((await t.call('GET', '/resources', { token: appTok, app: 'ataricraft' })).status, 200);
  assert.equal((await mk(t, appTok, { type: 'diskimage' })).status, 403, 'missing header');
  const made = await t.call('POST', '/resources', { token: appTok, app: 'ataricraft', body: { type: 'diskimage', name: 'dos.atr', data: b64('ATR') } });
  assert.equal(made.status, 201);
  assert.equal(made.json.resource.app, 'ataricraft');
  assert.equal((await t.call('POST', '/resources', { token: appTok, app: 'ataricraft', body: { type: 'asset', name: 'x', app: 'imagecraft' } })).status, 403);
  const id = made.json.resource.id;
  // the same user's other-app tokens cannot see it
  assert.equal((await t.call('GET', `/resources/${id}`, { token: multi, app: '3dcraft' })).status, 404);
  assert.equal((await t.call('GET', `/resources/${id}`, { token: multi, app: 'ataricraft' })).status, 403);
  // per-app scopes within one credential
  assert.equal((await t.call('POST', '/resources', { token: multi, app: 'imagecraft', body: { type: 'asset', name: 'n' } })).status, 403, 'imagecraft grant is read-only');
  assert.equal((await t.call('POST', '/resources', { token: multi, app: '3dcraft', body: { type: 'asset', name: 'n' } })).status, 201);
  // user-wide token sees everything the user owns, on any app header
  assert.equal((await t.call('GET', `/resources/${id}`, { token: userWide, app: 'whatever' })).status, 200);
  assert.equal((await t.call('GET', `/resources/${id}`, { token: userWide })).status, 200);
  // app-bound token cannot mint credentials for other apps or widen scopes
  assert.equal((await t.call('POST', '/tokens', { token: appTok, app: 'ataricraft', body: { name: 'z', scopes: ['data:read'] } })).status, 403, 'no tokens:manage scope');
  const mgr = (await mint({ name: 'mgr', app: 'ataricraft', scopes: ['tokens:manage', 'data:read'] })).json.token;
  assert.equal((await t.call('POST', '/tokens', { token: mgr, app: 'ataricraft', body: { name: 'c', app: 'imagecraft', scopes: ['data:read'] } })).status, 403);
  assert.equal((await t.call('POST', '/tokens', { token: mgr, app: 'ataricraft', body: { name: 'c', scopes: ['data:read', 'data:write'] } })).status, 400);
  assert.equal((await t.call('POST', '/tokens', { token: mgr, app: 'ataricraft', body: { name: 'c', scopes: ['data:read'] } })).status, 201);
  // an app principal in an ACL matches only app-bound tokens, never a self-declared header
  const bob = await t.login('bobby');
  await t.call('PUT', `/resources/${id}/acl`, { token: appTok, app: 'ataricraft', body: { acl: [] } }); // owner may manage
  assert.equal((await t.call('GET', `/resources/${id}`, { token: bob, app: 'ataricraft' })).status, 404);
  // session with app binding
  const sess = await t.login('alice', { app: 'ataricraft', scopes: ['data:read'] });
  assert.equal((await t.call('GET', '/resources', { token: sess, app: 'imagecraft' })).status, 403);
  assert.equal((await t.call('GET', '/resources', { token: sess })).status, 403);
  assert.equal((await t.call('GET', '/resources', { token: sess, app: 'ataricraft' })).status, 200);
  const me = (await t.call('GET', '/auth/me', { token: multi, app: '3dcraft' })).json;
  assert.equal(me.app, '3dcraft'); assert.deepEqual(me.scopes, ['data:read', 'data:write']); assert.ok(me.gatewayId.startsWith('gw_'));
  assert.equal((await t.call('GET', '/auth/me', { token: multi, app: 'BAD APP' })).status, 400);
  t.close();
});

test('app-bound keys in the vault', async () => {
  const m = await boot();
  const alice = await m.login('alice');
  const k = await m.call('POST', '/keys', { token: alice, body: { provider: 'gemini', label: 'g', secret: 'AIzaSyEXAMPLEKEY1234', apps: ['imagecraft'] } });
  assert.equal(k.status, 201);
  assert.deepEqual(k.json.key.apps, ['imagecraft']);
  const imgTok = (await m.call('POST', '/tokens', { token: alice, body: { name: 'i', app: 'imagecraft', scopes: ['keys:read', 'proxy:use'] } })).json.token;
  const atariTok = (await m.call('POST', '/tokens', { token: alice, body: { name: 'a', app: 'ataricraft', scopes: ['keys:read', 'proxy:use'] } })).json.token;
  assert.equal((await m.call('GET', '/keys', { token: imgTok, app: 'imagecraft' })).json.keys.length, 1);
  assert.equal((await m.call('GET', '/keys', { token: atariTok, app: 'ataricraft' })).json.keys.length, 0);
  assert.equal((await m.call('GET', '/proxy/gemini/v1/models', { token: atariTok, app: 'ataricraft' })).status, 404, 'key not usable by other app');
  m.close();
});

test('revocation: API tokens, logout, revoke-all, expiry, foreign gateway', async () => {
  const t = await boot();
  const alice = await t.login('alice');
  const mint = async (extra = {}) => (await t.call('POST', '/tokens', { token: alice, body: { name: 'n', scopes: ['data:read'], ...extra } })).json;
  const a = await mint();
  assert.equal((await t.call('GET', '/resources', { token: a.token })).status, 200);
  await t.call('DELETE', `/tokens/${a.info.id}`, { token: alice });
  assert.equal((await t.call('GET', '/resources', { token: a.token })).status, 401);
  // logout revokes the session
  const s = await t.login('alice');
  assert.equal((await t.call('GET', '/auth/me', { token: s })).status, 200);
  await t.call('POST', '/auth/logout', { token: s });
  assert.equal((await t.call('GET', '/auth/me', { token: s })).status, 401);
  // revoke-all kills sessions and API tokens, new login works
  const s2 = await t.login('alice'); const b = await mint();
  await t.call('POST', '/auth/revoke-all', { token: s2 });
  assert.equal((await t.call('GET', '/auth/me', { token: s2 })).status, 401);
  assert.equal((await t.call('GET', '/resources', { token: b.token })).status, 401);
  assert.equal((await t.call('GET', '/auth/me', { token: await t.login('alice') })).status, 200);
  // expiry
  const e = await (async () => (await t.call('POST', '/tokens', { token: await t.login('alice'), body: { name: 'n', scopes: ['data:read'] } })).json)();
  t.store.data.tokens[e.info.id].expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await t.call('GET', '/resources', { token: e.token })).status, 401);
  // bob's revoke does not touch alice
  const s3 = await t.login('alice'); const bob = await t.login('bobby');
  await t.call('POST', '/auth/revoke-all', { token: bob });
  assert.equal((await t.call('GET', '/auth/me', { token: s3 })).status, 200);
  t.close();
});

test('tokens are bound to a gateway id', async () => {
  const g1 = await boot({ gatewayId: 'gw_one' }), g2 = await boot({ gatewayId: 'gw_two' });
  const a1 = await g1.login('alice'), a2 = await g2.login('alice');
  assert.equal((await g2.call('GET', '/auth/me', { token: a1 })).status, 401, 'JWT from gateway 1 rejected by gateway 2');
  assert.equal((await g1.call('POST', '/tokens', { token: a1, body: { name: 'x', scopes: ['data:read'], gateways: ['gw_two'] } })).status, 400);
  const ok = await g1.call('POST', '/tokens', { token: a1, body: { name: 'x', scopes: ['data:read'], gateways: ['gw_one', 'gw_two'] } });
  assert.equal(ok.status, 201);
  assert.equal((await g1.call('GET', '/health')).json.gatewayId, 'gw_one');
  // an API-token record that names another gateway only is rejected even if present locally
  g2.store.data.tokens.t = { id: 't', userRef: Object.keys(g2.store.data.users)[0], hash: (await import('../server/gateway/crypto.mjs')).sha256('cg_x'), grants: [{ app: '*', scopes: ['data:read'] }], gateways: ['gw_one'], createdAt: '', expiresAt: null };
  assert.equal((await g2.call('GET', '/resources', { token: 'cg_x' })).status, 401);
  void a2;
  g1.close(); g2.close();
});

test('CORS is deny-by-default and per-origin allow-listed', async () => {
  const t = await boot({ corsOrigins: 'https://app.example' });
  const ok = await t.call('GET', '/health', { headers: { origin: 'https://app.example' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example');
  const bad = await t.call('GET', '/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.equal((await t.call('OPTIONS', '/keys', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await t.call('OPTIONS', '/keys', { headers: { origin: 'https://app.example' } })).status, 204);
  t.close();
});
