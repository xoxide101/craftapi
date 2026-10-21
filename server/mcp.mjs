// MCP server (stdio) exposing the 3dcraft craftapi to any MCP client.
// Run: node server/mcp.mjs     Env: CRAFT3D_INDEX (path to index.html), CRAFTAPI_OUT (export folder), CRAFTAPI_HEADFUL=1 to watch it work.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openSession } from './session.mjs';
import { explore, pathTo } from '../explorer/explore.mjs';

const OUT = path.resolve(process.env.CRAFTAPI_OUT || 'out');
let session = null;
let opening = null;

async function sess() {
  if (session) return session;
  opening = opening || openSession({ headless: process.env.CRAFTAPI_HEADFUL !== '1' }).then((s) => { session = s; return s; });
  return opening;
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const run = (fn, ...args) => async (a = {}) => {
  try {
    const { call } = await sess();
    const r = await call(fn, ...(typeof args[0] === 'function' ? args[0](a) : args));
    return r.ok ? text(r) : fail(`${r.error.code}: ${r.error.message}`);
  } catch (e) { return fail(String(e.message || e)); }
};

const server = new McpServer({ name: 'craftapi-3dcraft', version: '0.2.0' });

server.registerTool('craft_describe', {
  description: 'List what this 3dcraft instance supports: ops, shapes, materials, modifiers, animation properties, scores, export formats. Call first.',
  inputSchema: {},
}, run('describe'));

server.registerTool('craft_new_scene', {
  description: 'Open a fresh empty scene. A session starts with an empty scene already; use this to start over.',
  inputSchema: { name: z.string().optional() },
}, run('newScene', (a) => [{ name: a.name }]));

server.registerTool('craft_summary', {
  description: 'Structured view of the scene (objects, sizes, positions, modifiers, problems such as open edges). Prefer this over rendering to understand state.',
  inputSchema: {},
}, run('summary'));

server.registerTool('craft_state', {
  description: 'The full scene document as JSON (everything needed to recreate it).',
  inputSchema: {},
}, run('state'));

server.registerTool('craft_load_state', {
  description: 'Replace the scene with a document previously returned by craft_state.',
  inputSchema: { doc: z.record(z.string(), z.any()) },
}, run('loadState', (a) => [a.doc]));

server.registerTool('craft_apply', {
  description: 'Run a batch of operations atomically (all or nothing; a failed batch is rolled back). Each op is { op, ...args }. '
    + 'Ops: add {shape:{type},name?,pos?,rot?,scale?,color?,material?,parent?} -> id; remove {id}; rename {id,name}; set {id,prop:pos|rot|scale|color|opacity|visible|locked,value}; '
    + 'setMaterial {id,preset?,color?,opacity?,props?}; group {ids,name?}; ungroup {id}; modifier {id,action:add|set|remove|move|toggle,type?,index?,params?,to?}; '
    + 'boolean {id,other,mode:cut|join|overlap,ghost?}; physics {id,kind:dynamic|static,bounce?,slip?,weight?,push?,spin?,onHit?}; bake {length?,gravity?}; clearPhysics; '
    + 'camera {pos?,target?,fov?}; scene {bg?,ground?,light?,...}; animate {id,prop,keys:[{t,v,ease?}],length?,fps?,loop?}; time {t}. Use craft_describe for valid names.',
  inputSchema: { ops: z.array(z.object({ op: z.string() }).passthrough()) },
}, run('apply', (a) => [a.ops]));

server.registerTool('craft_snapshot', {
  description: 'Save the current scene and return a snapshot id. Cheap: use before trying something.',
  inputSchema: { label: z.string().optional() },
}, run('snapshot', (a) => [a.label]));

server.registerTool('craft_restore', {
  description: 'Go back to a snapshot.',
  inputSchema: { id: z.string() },
}, run('restore', (a) => [a.id]));

server.registerTool('craft_snapshots', { description: 'List snapshots with labels and human ratings.', inputSchema: {} }, run('snapshots'));

server.registerTool('craft_diff', {
  description: 'What changed between two snapshots (objects added, removed, changed and which properties).',
  inputSchema: { a: z.string(), b: z.string() },
}, run('diff', (x) => [x.a, x.b]));

server.registerTool('craft_rate', {
  description: 'Record a human rating (0..1) on a snapshot. Ratings from the person are the most trusted score.',
  inputSchema: { id: z.string(), value: z.number().min(0).max(1), note: z.string().optional() },
}, run('rate', (a) => [a.id, a.value, a.note]));

server.registerTool('craft_score', {
  description: 'Run a score on the current scene: printCheck {minWall?}, fits {box:[x,y,z]}, triangles {target?}, human {snapshot}. Returns value 0..1 (higher is better) and detail.',
  inputSchema: { name: z.string(), args: z.record(z.string(), z.any()).optional() },
}, run('score', (a) => [a.name, a.args || {}]));

server.registerTool('craft_render', {
  description: 'Render the scene to an image.',
  inputSchema: { width: z.number().int().min(64).max(2048).optional(), height: z.number().int().min(64).max(2048).optional(), transparent: z.boolean().optional() },
}, async (a = {}) => {
  try {
    const { call } = await sess();
    const r = await call('render', { w: a.width || 512, h: a.height || 384, transparent: !!a.transparent });
    if (!r.ok) return fail(`${r.error.code}: ${r.error.message}`);
    return { content: [{ type: 'image', data: r.image.replace(/^data:image\/png;base64,/, ''), mimeType: 'image/png' }] };
  } catch (e) { return fail(String(e.message || e)); }
});

server.registerTool('craft_export', {
  description: 'Export the scene as glb, obj or stl (scale 1 = scene units; use 10 etc. for millimetres). Saved under the output folder; returns the file path.',
  inputSchema: { format: z.enum(['glb', 'obj', 'stl']), scale: z.number().positive().optional(), filename: z.string().regex(/^[\w.-]+$/).optional() },
}, async (a) => {
  try {
    const { call } = await sess();
    const r = await call('export', a.format, { scale: a.scale || 1 });
    if (!r.ok) return fail(`${r.error.code}: ${r.error.message}`);
    mkdirSync(OUT, { recursive: true });
    const base = (a.filename || `scene-${Date.now()}`).replace(/\.(glb|obj|stl)$/i, '');
    const file = path.join(OUT, `${base}.${a.format}`);
    if (path.dirname(path.resolve(file)) !== OUT) return fail('bad filename');
    writeFileSync(file, Buffer.from(r.base64, 'base64'));
    return text({ file, bytes: r.bytes });
  } catch (e) { return fail(String(e.message || e)); }
});

server.registerTool('craft_explore', {
  description: 'Branch explorer (beam search). Starting from the current scene, try each mutation (a named list of ops) from every kept state, score each result with an external score, keep the best `beam` per level for `depth` levels. '
    + 'Returns the tree and the best path. The scene is left at the best state found.',
  inputSchema: {
    mutations: z.array(z.object({ name: z.string(), ops: z.array(z.object({ op: z.string() }).passthrough()) })).min(1).max(40),
    score: z.object({ name: z.string(), args: z.record(z.string(), z.any()).optional() }),
    beam: z.number().int().min(1).max(10).optional(),
    depth: z.number().int().min(1).max(5).optional(),
  },
}, async (a) => {
  try {
    const { call } = await sess();
    const snap = await call('snapshot', 'explore-start');
    if (!snap.ok) return fail(`${snap.error.code}: ${snap.error.message}`);
    const res = await explore(call, { start: snap.id, mutations: a.mutations, score: a.score, beam: a.beam || 3, depth: a.depth || 2 });
    if (res.best) await call('restore', res.best.id);
    return text({ best: res.best && { id: res.best.id, value: res.best.value, path: pathTo(res.nodes, res.best.id) },
      nodes: res.nodes.map((n) => ({ id: n.id, parent: n.parent, name: n.name, level: n.level, value: n.value, kept: n.kept, error: n.error && n.error.message })) });
  } catch (e) { return fail(String(e.message || e)); }
});

const close = async () => { if (session) await session.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
process.stdin.on('close', close);

await server.connect(new StdioServerTransport());
