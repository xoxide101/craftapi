#!/usr/bin/env node
// craftgw: manage several gateway connections from the terminal.
import { Connections } from './craftgw.mjs';
import { createNodeStore } from './node-store.mjs';

const [cmd, ...a] = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a.splice(i, 2)[1] : undefined; };
const readStdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s.trim(); };

const usage = `craftgw <command>
  add <name> <url> [--app id]       register a gateway (verifies it and pins its id)
  login <name> <userId> [--app id]  password from CRAFTGW_PASSWORD or stdin
  install <name> [--app id]         install an API token read from stdin
  status                            every connection with user, app and scopes
  call <name> <METHOD> <path> [json]
  logout <name> | remove <name>`;

const conns = new Connections({ store: await createNodeStore() });
try {
  if (cmd === 'add') { const app = flag('app'); const p = await conns.add({ name: a[0], baseUrl: a[1], app }); console.log(`added ${p.name} -> gateway ${p.gatewayId} (${p.mode})`); }
  else if (cmd === 'login') { const app = flag('app'); const pw = process.env.CRAFTGW_PASSWORD ?? await readStdin(); const r = await conns.login(a[0], a[1], pw, { app }); console.log(`signed in; grants: ${JSON.stringify(r.grants)}`); }
  else if (cmd === 'install') { const app = flag('app'); const me = await conns.installToken(a[0], await readStdin(), { app }); console.log(`installed; scopes: ${me.scopes.join(', ')}`); }
  else if (cmd === 'status') for (const r of await conns.status()) console.log(`${r.name}\t${r.baseUrl}\t${r.gatewayId}\t${r.signedIn ? `${r.userId} app=${r.effectiveApp} scopes=${r.scopes.join(',')}` : `signed out (${r.error})`}`);
  else if (cmd === 'call') console.log(JSON.stringify(await conns.request(a[0], a[1], a[2], a[3] ? { body: JSON.parse(a[3]) } : {}), null, 2));
  else if (cmd === 'logout') await conns.logout(a[0]);
  else if (cmd === 'remove') await conns.remove(a[0]);
  else console.log(usage);
} catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
