// Node SecretStores: OS keychain when available, otherwise an AES-256-GCM encrypted file (mode 0600).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

const execFileP = promisify(execFile);
const SERVICE = 'craftgw';
const FILE_AAD = Buffer.from('craftgw-secrets-v1');
const SCRYPT = { N: 16384, r: 8, p: 1 };

// ---- encrypted file format (documented in SPEC section 9.5) ----
export function sealSecrets(map, { passphrase, key, salt = randomBytes(16), iv = randomBytes(12) }) {
  const k = passphrase !== undefined ? scryptSync(passphrase, salt, 32, SCRYPT) : key;
  const c = createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(FILE_AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(map), 'utf8'), c.final()]);
  const head = passphrase !== undefined ? { kdf: 'scrypt', ...SCRYPT, salt: salt.toString('base64') } : { kdf: 'keyfile' };
  return { v: 1, ...head, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
export function openSecrets(file, { passphrase, key }) {
  const k = file.kdf === 'scrypt' ? scryptSync(passphrase, Buffer.from(file.salt, 'base64'), 32, { N: file.N, r: file.r, p: file.p }) : key;
  const d = createDecipheriv('aes-256-gcm', k, Buffer.from(file.iv, 'base64'));
  d.setAAD(FILE_AAD);
  d.setAuthTag(Buffer.from(file.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(file.ct, 'base64')), d.final()]).toString('utf8'));
}

function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export class EncryptedFileStore {
  /** passphrase (e.g. from CRAFTGW_PASSPHRASE) is preferred; without one a random key file (0600) is used. */
  constructor({ path = join(homedir(), '.config', 'craftgw', 'secrets.json'), passphrase = process.env.CRAFTGW_PASSPHRASE } = {}) {
    this.path = path; this.passphrase = passphrase || undefined;
    this.keyPath = `${path}.key`;
  }
  #key() {
    if (existsSync(this.keyPath)) return Buffer.from(readFileSync(this.keyPath, 'utf8').trim(), 'base64');
    const k = randomBytes(32);
    writePrivate(this.keyPath, k.toString('base64'));
    return k;
  }
  #read() {
    if (!existsSync(this.path)) return {};
    const f = JSON.parse(readFileSync(this.path, 'utf8'));
    return openSecrets(f, this.passphrase !== undefined ? { passphrase: this.passphrase } : { key: this.#key() });
  }
  #write(map) {
    writePrivate(this.path, JSON.stringify(sealSecrets(map, this.passphrase !== undefined ? { passphrase: this.passphrase } : { key: this.#key() })));
  }
  async get(n) { return this.#read()[n] ?? null; }
  async set(n, v) { const m = this.#read(); m[n] = String(v); this.#write(m); }
  async delete(n) { const m = this.#read(); delete m[n]; this.#write(m); }
}

/** OS keychain via CLI tools; secrets go over stdin, never argv. Linux: secret-tool (libsecret). macOS: security -i. */
export class KeychainStore {
  constructor({ exec = execFileP, os = platform(), spawnStdin = runWithStdin } = {}) { this.exec = exec; this.os = os; this.run = spawnStdin; }
  async available() {
    const tool = this.os === 'linux' ? 'secret-tool' : this.os === 'darwin' ? 'security' : null;
    if (!tool) return false;
    try { await this.exec('which', [tool]); return true; } catch { return false; }
  }
  async get(n) {
    try {
      if (this.os === 'linux') return (await this.exec('secret-tool', ['lookup', 'service', SERVICE, 'account', n])).stdout || null;
      return (await this.exec('security', ['find-generic-password', '-s', SERVICE, '-a', n, '-w'])).stdout.replace(/\n$/, '') || null;
    } catch { return null; }
  }
  async set(n, v) {
    if (this.os === 'linux') return this.run('secret-tool', ['store', '--label', `craftgw ${n}`, 'service', SERVICE, 'account', n], v);
    // `security -i` reads commands from stdin so the secret is not exposed in the process list.
    const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
    return this.run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${q(n)} -w ${q(v)}\n`);
  }
  async delete(n) {
    try {
      if (this.os === 'linux') await this.exec('secret-tool', ['clear', 'service', SERVICE, 'account', n]);
      else await this.exec('security', ['delete-generic-password', '-s', SERVICE, '-a', n]);
    } catch { /* already gone */ }
  }
}
function runWithStdin(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const c = execFile(cmd, args, (e) => (e ? reject(e) : resolve()));
    c.stdin.end(input);
  });
}

export async function createNodeStore(opts = {}) {
  if (!process.env.CRAFTGW_NO_KEYCHAIN) {
    const k = new KeychainStore(opts.keychain);
    if (await k.available()) return k;
  }
  return new EncryptedFileStore(opts.file);
}
