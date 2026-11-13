import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// Tiny JSON-file store; path=null keeps everything in memory (tests).
export class Store {
  constructor(path = null) {
    this.path = path;
    this.data = { users: {}, keys: {}, tokens: {} };
    if (path && existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf8'));
  }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
