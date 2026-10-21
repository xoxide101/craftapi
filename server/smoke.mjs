// Headless smoke test for every craftapi command against the real 3dcraft.
// Usage: node server/smoke.mjs   (set CRAFT3D_INDEX to test another copy of 3dcraft)
import { openSession } from './session.mjs';
import { explore, pathTo } from '../explorer/explore.mjs';

let failed = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) failed++; };
const j = (x) => JSON.stringify(x);

const s = await openSession();
const { call } = s;
const count = async () => (await call('summary')).count;

const d = await call('describe');
check('describe', d.ok && d.shapes.length > 0 && d.modifiers.includes('twist'), `${d.shapes?.length} shapes, ${d.modifiers?.length} modifiers`);

const start = (await call('snapshot', 'start')).id;

// objects
let r = await call('apply', [
  { op: 'add', shape: { type: 'box' }, name: 'plate', color: '#e8590c' },
  { op: 'add', shape: { type: 'cylinder' }, name: 'peg', pos: [0, 0.5, 0] },
]);
check('add two', r.ok && (await count()) === 2, j(r.error || ''));
const [plate, peg] = r.results.map((x) => x.id);

r = await call('apply', [{ op: 'set', id: plate, prop: 'pos', value: [1, 0, 0] }, { op: 'rename', id: peg, name: 'Peg' }, { op: 'setMaterial', id: peg, preset: 'gold' }]);
check('set / rename / material', r.ok, j(r.error || ''));
const sm = await call('summary');
check('summary reflects changes', sm.objects.find((o) => o.id === plate).pos[0] === 1 && sm.objects.find((o) => o.id === peg).name === 'Peg' && sm.objects.find((o) => o.id === peg).material === 'gold');

// validation and rollback
r = await call('apply', [{ op: 'add', shape: { type: 'box' } }, { op: 'nope' }]);
check('failed batch rolls back', !r.ok && (await count()) === 2, r.error?.message);
r = await call('apply', [{ op: 'set', id: plate, prop: 'pos', value: [1, 2] }]);
check('bad vector rejected', !r.ok, r.error?.message);
r = await call('apply', [{ op: 'add', shape: { type: 'no-such-shape' } }]);
check('unknown shape rejected', !r.ok, r.error?.message);

// modifiers
r = await call('apply', [{ op: 'modifier', id: plate, type: 'twist', params: { angle: 45 } }, { op: 'modifier', id: plate, type: 'array', params: { count: 2 } }]);
check('modifiers add', r.ok && (await call('summary')).objects.find((o) => o.id === plate).mods.length === 2, j(r.error || ''));
r = await call('apply', [{ op: 'modifier', id: plate, action: 'toggle', index: 0 }, { op: 'modifier', id: plate, action: 'remove', index: 1 }]);
check('modifier toggle / remove', r.ok && j((await call('summary')).objects.find((o) => o.id === plate).mods) === '["twist (off)"]', j(r.error || ''));
r = await call('apply', [{ op: 'modifier', id: plate, type: 'wobble' }]);
check('unknown modifier rejected', !r.ok, r.error?.message);

// boolean
r = await call('apply', [{ op: 'boolean', id: plate, other: peg, mode: 'cut' }]);
const afterBool = await call('summary');
check('boolean cut', r.ok && afterBool.objects.find((o) => o.id === peg).cutter === true && afterBool.objects.find((o) => o.id === plate).mods.some((m) => m.startsWith('boolean')), j(r.error || ''));
r = await call('apply', [{ op: 'boolean', id: plate, other: plate }]);
check('self-cut rejected', !r.ok, r.error?.message);

// group
r = await call('apply', [{ op: 'group', ids: [plate, peg], name: 'Pair' }]);
check('group', r.ok && (await call('summary')).objects.find((o) => o.id === plate).parent === r.results[0].id, j(r.error || ''));
const gid = r.results[0].id;
r = await call('apply', [{ op: 'ungroup', id: gid }]);
check('ungroup', r.ok && (await call('summary')).objects.find((o) => o.id === plate).parent === null, j(r.error || ''));

// camera / scene / animation / time
r = await call('apply', [{ op: 'camera', pos: [5, 5, 5], target: [0, 0, 0], fov: 50 }, { op: 'scene', ground: false }]);
check('camera + scene', r.ok && (await call('summary')).camera.fov === 50, j(r.error || ''));
r = await call('apply', [{ op: 'animate', id: peg, prop: 'pos', length: 4, keys: [{ t: 0, v: [0, 0.5, 0] }, { t: 2, v: [3, 0.5, 0] }] }, { op: 'time', t: 1 }]);
check('animate + time', r.ok && (await call('summary')).objects.find((o) => o.id === peg).animated === true, j(r.error || ''));
r = await call('apply', [{ op: 'animate', id: peg, prop: 'nope', keys: [] }]);
check('bad anim prop rejected', !r.ok && /prop must be one of/.test(r.error.message), r.error?.message);

// physics
r = await call('apply', [{ op: 'add', shape: { type: 'sphere' }, name: 'ball', pos: [0, 3, 0] }]);
const ball = r.results?.[0]?.id;
if (!ball) { const sh = (await call('describe')).shapes.filter((x) => /sph|ball/.test(x)); console.log('  (no sphere shape; shapes with sph/ball:', sh.join(','), ')'); }
if (ball) {
  r = await call('apply', [{ op: 'physics', id: ball, kind: 'dynamic', bounce: 0.6 }, { op: 'bake', length: 2 }]);
  check('physics + bake', r.ok && (await call('summary')).objects.find((o) => o.id === ball).animated === true, j(r.error || ''));
  r = await call('apply', [{ op: 'clearPhysics' }]);
  check('clear physics', r.ok, j(r.error || ''));
}

// snapshots, rate, diff, state round trip
const mid = (await call('snapshot', 'mid')).id;
await call('apply', [{ op: 'remove', id: peg }]);
const end = (await call('snapshot', 'end')).id;
r = await call('diff', mid, end);
check('diff sees removal', r.ok && r.diff.removed.includes(peg), j(r.diff?.removed));
check('rate', (await call('rate', end, 0.8, 'good')).ok);
check('human score', (await call('score', 'human', { snapshot: end })).value === 0.8);
check('rate out of range rejected', !(await call('rate', end, 2)).ok);
const st = await call('state');
const nObj = (await call('summary')).count;
await call('newScene', {});
check('newScene empties', (await count()) === 0);
r = await call('loadState', st.doc);
check('loadState round trip', r.ok && (await count()) === nObj, `${nObj} objects`);
check('restore start', (await call('restore', start)).ok && (await count()) === 0);

// scores
await call('apply', [{ op: 'add', shape: { type: 'box' }, name: 'cube' }]);
let sc = await call('score', 'printCheck');
check('score printCheck', sc.ok && sc.value === 1 && sc.detail.closed, j(sc.error || sc.value));
sc = await call('score', 'fits', { box: [1, 1, 1] });
check('score fits (too big)', sc.ok && sc.value < 1, String(sc.value));
sc = await call('score', 'fits', { box: [10, 10, 10] });
check('score fits (fits)', sc.ok && sc.value === 1);
check('unknown score rejected', !(await call('score', 'nope')).ok);

// render / export
const img = await call('render', { w: 256, h: 192 });
check('render', img.ok && img.image.startsWith('data:image/png'));
for (const f of ['glb', 'obj', 'stl']) {
  const e = await call('export', f);
  check('export ' + f, e.ok && e.bytes > 100, e.ok ? e.bytes + ' bytes' : j(e.error));
}
check('bad export format rejected', !(await call('export', 'xyz')).ok);

// explorer: grow a box in steps, keep the best fit inside a 3-wide box
await call('newScene', {});
const base = (await call('apply', [{ op: 'add', shape: { type: 'box' }, name: 'b', scale: [4, 4, 4] }])).results[0].id;
const root = (await call('snapshot', 'explore-root')).id;
const mut = [
  { name: 'half', ops: [{ op: 'set', id: base, prop: 'scale', value: [1.4, 1.4, 1.4] }] },
  { name: 'huge', ops: [{ op: 'set', id: base, prop: 'scale', value: [9, 9, 9] }] },
  { name: 'slightly', ops: [{ op: 'set', id: base, prop: 'scale', value: [3.6, 3.6, 3.6] }] },
  { name: 'broken', ops: [{ op: 'set', id: 'missing', prop: 'pos', value: [0, 0, 0] }] },
];
const res = await explore(call, { start: root, mutations: mut, score: { name: 'fits', args: { box: [3, 3, 3] } }, beam: 2, depth: 2 });
check('explore starts below 1', res.nodes[0].value < 1, String(res.nodes[0].value));
check('explore finds a tree', res.nodes.length > 4 && res.best, `${res.nodes.length} nodes`);
check('explore skips failed mutation', res.nodes.some((n) => n.name === 'broken' && n.error));
check('explore best fits', res.best && res.best.value === 1 && pathTo(res.nodes, res.best.id).includes('half'), res.best && j(pathTo(res.nodes, res.best.id)));
check('explore prunes to beam', res.nodes.filter((n) => n.level === 1 && n.kept).length <= 2);

check('no page errors', s.errors.length === 0, s.errors.slice(0, 3).join(' | '));
await s.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
