// Talks to server/mcp.mjs over stdio like a real MCP client would, to prove the tools work end to end.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../out-test');
rmSync(out, { recursive: true, force: true });

let failed = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) failed++; };

const client = new Client({ name: 'smoke', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'mcp.mjs')], env: { ...process.env, CRAFTAPI_OUT: out } }));

const tool = async (name, args = {}) => client.callTool({ name, arguments: args });
const data = (r) => JSON.parse(r.content[0].text);

const tools = (await client.listTools()).tools.map((t) => t.name);
check('lists tools', tools.length >= 14 && tools.includes('craft_apply'), `${tools.length} tools`);

check('describe', data(await tool('craft_describe')).shapes.length > 0);

let r = await tool('craft_apply', { ops: [{ op: 'add', shape: { type: 'box' }, name: 'cube', scale: [4, 4, 4] }] });
check('apply add', !r.isError && data(r).results[0].id);
const id = data(r).results[0].id;

r = await tool('craft_apply', { ops: [{ op: 'nope' }] });
check('error reported as isError', r.isError === true, r.content[0].text);

r = await tool('craft_summary');
check('summary', data(r).count === 1);

r = await tool('craft_explore', {
  mutations: [
    { name: 'half', ops: [{ op: 'set', id, prop: 'scale', value: [1.4, 1.4, 1.4] }] },
    { name: 'huge', ops: [{ op: 'set', id, prop: 'scale', value: [9, 9, 9] }] },
  ],
  score: { name: 'fits', args: { box: [3, 3, 3] } }, beam: 1, depth: 1,
});
const ex = data(r);
check('explore best', ex.best && ex.best.value === 1 && ex.best.path[0] === 'half', JSON.stringify(ex.best));
check('scene left at best state', data(await tool('craft_summary')).objects[0].scale[0] === 1.4);

r = await tool('craft_render', { width: 128, height: 96 });
check('render returns image', r.content[0].type === 'image' && r.content[0].data.length > 100);

r = await tool('craft_export', { format: 'stl', filename: 'test' });
check('export writes file', !r.isError && existsSync(data(r).file), data(r).file);
r = await tool('craft_export', { format: 'stl', filename: '../evil' });
check('export rejects path tricks', r.isError === true, r.content[0].text.slice(0, 80));

await client.close();
rmSync(out, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
