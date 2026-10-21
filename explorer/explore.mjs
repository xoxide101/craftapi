// Branch explorer: beam search over snapshots. A node is a state; a mutation is a list of ops.
// Scores must come from outside the agent (printCheck, fits, human, ...), see docs/SPEC.md section 3.

/**
 * @param call      session.call(fn, ...args)
 * @param start     snapshot id to start from
 * @param mutations array of { name, ops } or a function (node) => array of { name, ops }
 * @param score     { name, args } an external score; higher value is better
 * @param beam      how many states to keep per level
 * @param depth     how many levels
 * @returns { nodes, best } nodes: [{ id, parent, name, ops, level, value, detail, kept, error? }]
 */
export async function explore(call, { start, mutations, score = { name: 'printCheck' }, beam = 3, depth = 2, log = () => {} }) {
  const nodes = [];
  const root = { id: start, parent: null, name: 'start', ops: [], level: 0, kept: true };
  await call('restore', start);
  const r0 = await call('score', score.name, score.args || {});
  root.value = r0.ok ? r0.value : null;
  root.detail = r0.ok ? r0.detail : r0.error;
  nodes.push(root);

  let frontier = [root];
  for (let level = 1; level <= depth; level++) {
    const children = [];
    for (const parent of frontier) {
      const list = typeof mutations === 'function' ? mutations(parent) : mutations;
      for (const mu of list) {
        const res = await call('restore', parent.id);
        if (!res.ok) throw new Error('restore failed: ' + JSON.stringify(res.error));
        const applied = await call('apply', mu.ops);
        const node = { id: null, parent: parent.id, name: mu.name, ops: mu.ops, level, kept: false };
        if (!applied.ok) { node.error = applied.error; nodes.push(node); continue; }
        const snap = await call('snapshot', `L${level} ${mu.name}`);
        node.id = snap.id;
        const sc = await call('score', score.name, score.args || {});
        if (sc.ok) { node.value = sc.value; node.detail = sc.detail; } else { node.error = sc.error; }
        nodes.push(node);
        if (sc.ok) children.push(node);
        log(`L${level} ${mu.name}: ${sc.ok ? sc.value.toFixed(3) : 'score failed'}`);
      }
    }
    children.sort((a, b) => b.value - a.value);
    frontier = children.slice(0, beam);
    frontier.forEach((n) => { n.kept = true; });
    if (!frontier.length) break;
  }

  const scored = nodes.filter((n) => n.value !== undefined && n.value !== null && n.id);
  const best = scored.reduce((b, n) => (!b || n.value > b.value ? n : b), null);
  return { nodes, best };
}

// Path of op names from the start to a node: this is the "perspective" a branch represents.
export function pathTo(nodes, id) {
  const byId = new Map(nodes.filter((n) => n.id).map((n) => [n.id, n]));
  const out = [];
  for (let n = byId.get(id); n && n.parent; n = byId.get(n.parent)) out.unshift(n.name);
  return out;
}
