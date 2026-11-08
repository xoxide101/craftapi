import * as C from './crypto.mjs';
import { RESOURCE_TYPES, KNOWN_APPS, APP_RE, ROLE_RE, PERMS, MAX_RESOURCE_BYTES, evaluate, entryMatches, publicResource } from './resources.mjs';

// Data/ACL routes. Returns true when the request was handled.
export function createDataRoutes({ db, store, err, readJson, readBody, send, need }) {
  const usersById = () => db.users;
  const isAdmin = (ctx) => ctx.user.role === 'admin' && ctx.scopes.includes('admin');

  function load(ctx, id, needPerm) {
    const r = db.resources[id];
    const ev = r && evaluate(r, ctx.user, ctx);
    const canSee = ev && (ev.perms.size || ev.manage);
    if (!r || !canSee) throw err(404, 'not_found', 'resource not found'); // never reveal existence without access
    if (needPerm === 'manage' ? !ev.manage : !ev.perms.has(needPerm)) throw err(403, 'forbidden', `requires ${needPerm} access`);
    return { r, ev };
  }

  function parseAcl(input, ctx) {
    if (!Array.isArray(input) || input.length > 50) throw err(400, 'bad_acl', 'acl must be an array of at most 50 entries');
    return input.map((e) => {
      const kind = e?.principal?.kind;
      let id = e?.principal?.id;
      if (!['user', 'role', 'app', 'public'].includes(kind)) throw err(400, 'bad_acl', 'principal.kind must be user, role, app or public');
      if (!Array.isArray(e.perms) || !e.perms.length || e.perms.some((p) => !PERMS.includes(p))) throw err(400, 'bad_acl', `perms must be a non-empty subset of ${PERMS.join(',')}`);
      if (e.app !== undefined && e.app !== null && !APP_RE.test(e.app)) throw err(400, 'bad_acl', 'invalid app restriction');
      if (kind === 'user') {
        const u = Object.values(db.users).find((x) => x.id === id || x.userId === String(id).toLowerCase());
        if (!u) throw err(400, 'bad_acl', 'unknown user');
        id = u.id;
      } else if (kind === 'role') {
        if (!ROLE_RE.test(id)) throw err(400, 'bad_acl', 'invalid role name');
        if (id === 'everyone' && !isAdmin(ctx)) throw err(403, 'forbidden', 'only an admin may grant to role everyone');
      } else if (kind === 'app') {
        if (!APP_RE.test(id)) throw err(400, 'bad_acl', 'invalid app id');
      } else {
        id = '*';
        if (!isAdmin(ctx)) throw err(403, 'forbidden', 'only an admin may make a resource public');
      }
      if ((kind === 'public' || (kind === 'role' && id === 'everyone')) && e.perms.includes('admin')) throw err(400, 'bad_acl', 'admin permission cannot be granted to everyone/public');
      if (kind === 'public' && e.perms.some((p) => p !== 'read')) throw err(400, 'bad_acl', 'public access is read-only');
      return { principal: { kind, id }, perms: [...new Set(e.perms)], app: e.app || null };
    });
  }

  const describeEntry = (e) => {
    const { kind, id } = e.principal;
    const users = Object.values(db.users);
    let who;
    if (kind === 'user') who = [db.users[id]?.userId].filter(Boolean);
    else if (kind === 'role') who = id === 'everyone' ? 'all authenticated users' : users.filter((u) => (u.roles || []).includes(id) || (id === 'admin' && u.role === 'admin')).map((u) => u.userId);
    else if (kind === 'app') who = `requests made with a token bound to app ${id}`;
    else who = 'anyone, unauthenticated';
    return { principal: e.principal, perms: e.perms, app: e.app, resolved: who };
  };

  return async function handle(req, res, ctx, path, url) {
    const m = req.method;
    if (m === 'GET' && path === '/api/v1/resource-types') return send(res, 200, { ok: true, types: RESOURCE_TYPES, knownApps: KNOWN_APPS }), true;

    if (path === '/api/v1/resources') {
      if (m === 'GET') {
        need(ctx, 'data:read');
        const type = url.searchParams.get('type');
        const list = Object.values(db.resources).map((r) => [r, evaluate(r, ctx.user, ctx)])
          .filter(([r, ev]) => ev.perms.has('read') && (!type || r.type === type))
          .map(([r, ev]) => publicResource(r, usersById(), { myPerms: [...ev.perms] }));
        return send(res, 200, { ok: true, resources: list }), true;
      }
      if (m === 'POST') {
        need(ctx, 'data:write');
        const b = await readJson(req);
        if (!RESOURCE_TYPES[b.type]) throw err(400, 'bad_request', `type must be one of ${Object.keys(RESOURCE_TYPES).join(', ')}`);
        if (typeof b.name !== 'string' || !b.name || b.name.length > 128) throw err(400, 'bad_request', 'name required (max 128)');
        let app = b.app ?? null;
        if (ctx.app !== '*') { if (app !== null && app !== ctx.app) throw err(403, 'forbidden', 'app-bound token can only create resources for its own app'); app = ctx.app; }
        else if (app !== null && !APP_RE.test(app)) throw err(400, 'bad_request', 'invalid app id');
        const data = b.data === undefined ? Buffer.alloc(0) : Buffer.from(String(b.data), 'base64');
        if (data.length > MAX_RESOURCE_BYTES) throw err(413, 'too_large', 'resource too large');
        const now = new Date().toISOString();
        const r = { id: C.newId('res'), type: b.type, name: b.name, app, owner: ctx.user.id, acl: [], size: data.length, contentType: typeof b.contentType === 'string' ? b.contentType.slice(0, 100) : 'application/octet-stream', data: data.toString('base64'), createdAt: now, updatedAt: now };
        db.resources[r.id] = r; store.save();
        return send(res, 201, { ok: true, resource: publicResource(r, usersById()) }), true;
      }
    }

    if (m === 'GET' && path === '/api/v1/admin/resources') {
      need(ctx, 'admin');
      if (ctx.user.role !== 'admin') throw err(403, 'forbidden', 'admin only');
      return send(res, 200, { ok: true, resources: Object.values(db.resources).map((r) => publicResource(r, usersById(), { acl: r.acl.map(describeEntry) })) }), true;
    }

    const r = /^\/api\/v1\/resources\/([\w-]+)(\/content|\/acl|\/access)?$/.exec(path);
    if (r) {
      const sub = r[2] || '';
      if (m === 'GET' && !sub) { need(ctx, 'data:read'); const x = load(ctx, r[1], 'read'); return send(res, 200, { ok: true, resource: publicResource(x.r, usersById(), { myPerms: [...x.ev.perms] }) }), true; }
      if (m === 'GET' && sub === '/content') {
        need(ctx, 'data:read');
        const { r: res0 } = load(ctx, r[1], 'read');
        res.writeHead(200, { 'content-type': res0.contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' });
        return res.end(Buffer.from(res0.data, 'base64')), true;
      }
      if (m === 'PUT' && sub === '/content') {
        need(ctx, 'data:write');
        const { r: res0 } = load(ctx, r[1], 'write');
        const body = await readBody(req, MAX_RESOURCE_BYTES);
        res0.data = body.toString('base64'); res0.size = body.length; res0.updatedAt = new Date().toISOString();
        if (req.headers['content-type']) res0.contentType = String(req.headers['content-type']).slice(0, 100);
        store.save();
        return send(res, 200, { ok: true, resource: publicResource(res0, usersById()) }), true;
      }
      if (m === 'DELETE' && !sub) { need(ctx, 'data:write'); const { r: res0 } = load(ctx, r[1], 'manage'); delete db.resources[res0.id]; store.save(); return send(res, 200, { ok: true }), true; }
      if (sub === '/acl' && m === 'GET') { need(ctx, 'data:write'); const { r: res0 } = load(ctx, r[1], 'manage'); return send(res, 200, { ok: true, acl: res0.acl }), true; }
      if (sub === '/acl' && m === 'PUT') {
        need(ctx, 'data:write');
        const { r: res0 } = load(ctx, r[1], 'manage');
        const b = await readJson(req);
        const acl = parseAcl(b.acl, ctx);
        // Non-admins cannot silently drop or rewrite admin-granted everyone/public entries.
        if (!isAdmin(ctx)) {
          const priv = (e) => e.principal.kind === 'public' || (e.principal.kind === 'role' && e.principal.id === 'everyone');
          if (JSON.stringify(res0.acl.filter(priv)) !== JSON.stringify(acl.filter(priv))) throw err(403, 'forbidden', 'only an admin may change everyone/public entries');
        }
        res0.acl = acl; res0.updatedAt = new Date().toISOString(); store.save();
        return send(res, 200, { ok: true, acl }), true;
      }
      if (sub === '/access' && m === 'GET') {
        need(ctx, 'data:read');
        const { r: res0 } = load(ctx, r[1], 'manage');
        return send(res, 200, {
          ok: true, resource: publicResource(res0, usersById()),
          access: [{ principal: { kind: 'user', id: res0.owner }, perms: PERMS, app: null, resolved: [db.users[res0.owner]?.userId], via: 'owner' }, ...res0.acl.map((e) => ({ ...describeEntry(e), via: 'acl' }))],
          adminRoleCan: ['manage acl', 'delete'], adminRoleCannot: ['read content', 'write content (unless also granted)'],
        }), true;
      }
    }
    return false;
  };
}

// Unauthenticated read: only if an admin made the resource public.
export function publicRead(db, id) {
  const r = db.resources[id];
  if (!r || !r.acl.some((e) => e.principal.kind === 'public' && e.perms.includes('read') && !e.app)) return null;
  return r;
}
export { entryMatches };
