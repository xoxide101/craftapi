// Resource registry + ACL decisions. Everything is deny-by-default: access exists only through
// ownership or an explicit ACL entry; admins can manage ACLs but do not get content access implicitly.
export const RESOURCE_TYPES = {
  dataset: { description: 'Structured data (CSV/JSON/etc.) used by apps' },
  asset: { description: 'Generic binary or text asset' },
  clipart: { description: 'Clip art / vector or bitmap graphics' },
  font: { description: 'Font files' },
  diskimage: { description: 'Disk images (e.g. Atari disk images)' },
  other: { description: 'Anything else' },
};
export const KNOWN_APPS = ['3dcraft', 'ataricraft', 'imagecraft', 'logocraft', 'labelcraft', 'sitecraft', 'presscraft', 'shiftcraft', 'datacraft'];
export const APP_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const ROLE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const PERMS = ['read', 'write', 'admin'];
export const MAX_RESOURCE_BYTES = 2 << 20;

const expand = (perms) => {
  const s = new Set(perms);
  if (s.has('admin')) { s.add('write'); }
  if (s.has('write')) { s.add('read'); }
  return s;
};

const roleList = (user) => [...(user.roles || []), ...(user.role === 'admin' ? ['admin'] : [])];

export function entryMatches(e, user, ctx) {
  if (e.app && (ctx.app === '*' || e.app !== ctx.app)) return false; // app restriction needs a token bound to that app
  const { kind, id } = e.principal;
  if (kind === 'user') return id === user.id;
  if (kind === 'role') return id === 'everyone' || roleList(user).includes(id);
  if (kind === 'app') return ctx.app !== '*' && ctx.app === id;
  if (kind === 'public') return true;
  return false;
}

// -> { perms:Set, manage:boolean }. manage = may edit ACL / delete (owner, admin perm, or admin role with admin scope).
export function evaluate(resource, user, ctx) {
  const none = { perms: new Set(), manage: false };
  if (ctx.app !== '*' && resource.app !== ctx.app) return none; // app-bound tokens only see their own app's resources
  const perms = resource.owner === user.id ? expand(PERMS) : new Set();
  for (const e of resource.acl) if (entryMatches(e, user, ctx)) for (const p of expand(e.perms)) perms.add(p);
  const adminOverride = user.role === 'admin' && ctx.scopes.includes('admin');
  return { perms, manage: perms.has('admin') || adminOverride };
}

export function publicResource(r, usersById, extra = {}) {
  return { id: r.id, type: r.type, name: r.name, app: r.app, owner: usersById[r.owner]?.userId ?? null, size: r.size, contentType: r.contentType, createdAt: r.createdAt, updatedAt: r.updatedAt, ...extra };
}
