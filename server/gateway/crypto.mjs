import { scrypt, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHmac, createHash, hkdfSync } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password, salt = randomBytes(16)) { // salt param is for test vectors only
  const dk = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const dk = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(dk, expected);
}

// Master key: 32 bytes as base64 or 64 hex chars, from env only.
export function parseMasterKey(value) {
  if (!value) throw new Error('CRAFT_MASTER_KEY is required (32 bytes, base64 or hex). Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  const buf = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (buf.length !== 32) throw new Error('CRAFT_MASTER_KEY must decode to exactly 32 bytes');
  return buf;
}

export function deriveKeys(master) {
  const d = (info) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  return { vault: d('craftapi-vault-v1'), jwt: d('craftapi-jwt-v1') };
}

// AES-256-GCM; aad binds a record to its owner so blobs can't be swapped between users.
export function encrypt(key, plaintext, aad, iv = randomBytes(12)) { // iv param is for test vectors only
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

export function decrypt(key, blob, aad) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

export function maskSecret(s) {
  if (!s) return '';
  return s.length <= 8 ? '****' : `${s.slice(0, 3)}…${s.slice(-4)}`;
}

const b64u = (b) => Buffer.from(b).toString('base64url');

export function signJwt(secret, claims, ttlSec, now = Math.floor(Date.now() / 1000)) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...claims, iat: now, exp: now + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(secret, token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (head.alg !== 'HS256' || typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch { return null; }
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const newId = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const newApiToken = () => `cg_${randomBytes(32).toString('base64url')}`;
