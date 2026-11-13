import { appendFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const FORBIDDEN = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|hash/i;
const GENESIS = '0'.repeat(64);
const entryHash = (prev, body) => createHash('sha256').update(prev).update(body).digest('hex');

/**
 * Append-only, hash-chained JSON-lines audit log (each entry commits to the previous one, so edits or
 * deletions in the middle are detectable). Without a path it is in-memory only. Field names that look
 * secret-bearing are refused outright so a coding slip cannot leak credentials into the log.
 */
export class AuditLog {
  constructor(path = null) {
    this.path = path; this.mem = []; this.seq = 0; this.prev = GENESIS;
    if (path) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
        if (lines.length) { const last = JSON.parse(lines[lines.length - 1]); this.seq = last.seq; this.prev = last.hash; }
      }
    }
  }
  record(event, fields = {}) {
    for (const k of Object.keys(fields)) if (FORBIDDEN.test(k)) throw new Error(`audit field not allowed: ${k}`);
    const body = JSON.stringify({ seq: this.seq + 1, ts: new Date().toISOString(), event, ...fields, prev: this.prev });
    const hash = entryHash(this.prev, body);
    const line = `${body.slice(0, -1)},"hash":"${hash}"}`;
    this.seq += 1; this.prev = hash;
    if (this.path) { appendFileSync(this.path, `${line}\n`, { mode: 0o600 }); try { chmodSync(this.path, 0o600); } catch { /* best effort */ } }
    else this.mem.push(line);
    return JSON.parse(line);
  }
  entries() {
    const lines = this.path ? (existsSync(this.path) ? readFileSync(this.path, 'utf8').split('\n').filter(Boolean) : []) : this.mem;
    return lines.map((l) => JSON.parse(l));
  }
}

export function verifyChain(entries) {
  let prev = GENESIS;
  for (const e of entries) {
    const { hash, ...rest } = e;
    if (rest.prev !== prev || entryHash(prev, JSON.stringify(rest)) !== hash) return { ok: false, badSeq: e.seq };
    prev = hash;
  }
  return { ok: true };
}
