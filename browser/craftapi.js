// craftapi for 3dcraft. Load after the app scripts so window.E3 exists. Spec: docs/SPEC.md.
// Everything goes through the same engine calls the GUI uses (E3.setValue, E3.setKey, E3.rebuild, ...).
(() => {
  const E = window.E3;
  const VERSION = '0.2';
  const snaps = new Map();
  let snapN = 0;

  const ok = (data = {}) => ({ ok: true, ...data });
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const need = () => (E.doc ? null : fail('no_doc', 'No scene is open'));
  const obj = (id) => { const m = E.find(id); if (!m) throw new Error('no object ' + id); return m; };
  const isVec = (v, n = 3) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  const vec = (v, name) => { if (!isVec(v)) throw new Error(name + ' must be [x,y,z] numbers'); return v; };

  // Same sequence the UI uses when it opens a scene.
  async function load(doc) {
    E.doc = doc;
    E.time = 0;
    E.applyCamera();
    E.applyScene();
    await E.rebuild();
  }

  const descendants = (id) => {
    const out = [];
    const walk = (p) => E.doc.objects.filter((o) => o.parent === p).forEach((o) => { out.push(o.id); walk(o.id); });
    walk(id);
    return out;
  };

  // ------------------------------------------------------------------ operations (for apply)
  const ops = {
    async add(a) {
      if (!a.shape || !a.shape.type) throw new Error('add needs shape.type (see describe().shapes)');
      if (!E.SHAPES[a.shape.type]) throw new Error('unknown shape ' + a.shape.type);
      const m = { kind: a.kind || 'shape', shape: a.shape, name: a.name || a.shape.type,
        pos: a.pos ? vec(a.pos, 'pos') : [0, 0, 0], rot: a.rot ? vec(a.rot, 'rot') : [0, 0, 0], scale: a.scale ? vec(a.scale, 'scale') : [1, 1, 1],
        id: E.uid(), parent: a.parent || null, visible: true, locked: false,
        mat: E.defaultMat(a.color || '#3f7fe0', a.material || 'plastic') };
      if (a.parent) obj(a.parent);
      E.doc.objects.push(m);
      await E.rebuild();
      return { id: m.id };
    },

    async remove({ id }) {
      obj(id);
      const gone = new Set([id, ...descendants(id)]);
      E.doc.objects = E.doc.objects.filter((o) => !gone.has(o.id));
      if (E.doc.anim) gone.forEach((g) => { delete E.doc.anim.tracks[g]; });
      await E.rebuild();
      return { removed: [...gone] };
    },

    async rename({ id, name }) { obj(id).name = String(name); },

    async set({ id, prop, value }) {
      const m = obj(id);
      if (['pos', 'rot', 'scale'].includes(prop)) vec(value, prop);
      if (!['pos', 'rot', 'scale', 'color', 'opacity', 'visible', 'locked'].includes(prop)) throw new Error('cannot set ' + prop + ' (use setMaterial / modifier / physics)');
      E.setValue(m, prop, value);
      E.placeOne(id);
    },

    async setMaterial({ id, preset, color, opacity, props }) {
      const m = obj(id);
      if (preset) {
        if (!E.MATERIALS[preset]) throw new Error('unknown material ' + preset);
        m.mat = { ...E.defaultMat(color || m.mat.color, preset), opacity: m.mat.opacity, faces: m.mat.faces || {} };
      }
      if (color) m.mat.color = color;
      if (opacity !== undefined) m.mat.opacity = opacity;
      if (props) Object.assign(m.mat, props);
      await E.rebuild();
    },

    async group({ ids, name }) {
      if (!Array.isArray(ids) || !ids.length) throw new Error('group needs ids[]');
      ids.forEach(obj);
      const g = { id: E.uid(), kind: 'group', name: name || 'Group', parent: obj(ids[0]).parent || null, visible: true, locked: false,
        pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], mat: E.defaultMat('#888888') };
      E.doc.objects.push(g);
      ids.forEach((id) => { obj(id).parent = g.id; });
      await E.rebuild();
      return { id: g.id };
    },

    async ungroup({ id }) {
      const g = obj(id);
      if (g.kind !== 'group') throw new Error(id + ' is not a group');
      E.doc.objects.filter((o) => o.parent === id).forEach((o) => { o.parent = g.parent || null; });
      E.doc.objects = E.doc.objects.filter((o) => o.id !== id);
      await E.rebuild();
    },

    // action: add | set | remove | move | toggle. Types are the keys of MODS.LIST.
    async modifier({ id, action = 'add', type, index, params, to }) {
      const m = obj(id);
      m.mods = m.mods || [];
      const L = window.MODS.LIST;
      if (action === 'add') {
        if (!L[type]) throw new Error('unknown modifier ' + type + ' (have: ' + Object.keys(L).join(', ') + ')');
        m.mods.push({ type, on: true, ...clone(L[type][1]), ...(params || {}) });
      } else {
        const mod = m.mods[index];
        if (!mod) throw new Error('no modifier at index ' + index);
        if (action === 'set') Object.assign(mod, params || {});
        else if (action === 'toggle') mod.on = !mod.on;
        else if (action === 'remove') m.mods.splice(index, 1);
        else if (action === 'move') { m.mods.splice(index, 1); m.mods.splice(Math.max(0, Math.min(m.mods.length, to)), 0, mod); }
        else throw new Error('unknown modifier action ' + action);
      }
      await E.rebuild();
      return { count: m.mods.length };
    },

    // mode: cut | join | overlap. The other object becomes a ghost cutter when cutting.
    async boolean({ id, other, mode = 'cut', ghost = true }) {
      const m = obj(id), o = obj(other);
      const op = { cut: 'subtract', join: 'union', overlap: 'intersect' }[mode];
      if (!op) throw new Error('mode must be cut, join or overlap');
      if (id === other) throw new Error('an object cannot cut itself');
      m.mods = m.mods || [];
      m.mods.push({ type: 'boolean', on: true, op, with: other });
      if (mode === 'cut' && ghost) o.cutter = true;
      await E.rebuild();
    },

    // Set the physics of an object; the separate bake op works the motion out onto the timeline.
    async physics({ id, kind = 'dynamic', bounce, slip, weight, push, spin, onHit }) {
      const m = obj(id);
      m.phys = { ...(window.PHYS.DEFAULTS || {}), ...(m.phys || {}), kind };
      if (bounce !== undefined) m.phys.bounce = bounce;
      if (slip !== undefined) m.phys.slip = slip;
      if (weight !== undefined) m.phys.weight = weight;
      if (push) m.phys.push = vec(push, 'push');
      if (spin) m.phys.spin = vec(spin, 'spin');
      if (onHit) m.phys.onHit = onHit;
    },

    async bake({ length, gravity } = {}) {
      const res = window.PHYS.bake({ length, gravity });
      E.evalAt(E.time || 0, true);
      return { hits: (res.hits || []).length };
    },

    async clearPhysics() { return { cleared: window.PHYS.clear() }; },

    async camera({ pos, target, fov }) {
      const c = E.doc.camera;
      if (pos) c.pos = vec(pos, 'pos');
      if (target) c.target = vec(target, 'target');
      if (fov !== undefined) c.fov = fov;
      E.applyCamera();
    },

    async scene(a) {
      Object.assign(E.doc.scene, a || {});
      E.applyScene();
    },

    // keys: [{ t, v, ease? }]; prop: pos | rot | scale | color | opacity
    async animate({ id, prop, keys, length, fps, loop }) {
      const m = obj(id);
      if (!Object.keys(E.ANIM_PROPS).includes(prop)) throw new Error('prop must be one of ' + Object.keys(E.ANIM_PROPS).join(', '));
      const a = E.anim();
      if (length) a.length = length;
      if (fps) a.fps = fps;
      if (loop !== undefined) a.loop = loop;
      (keys || []).forEach((k) => E.setKey(m, prop, k.t, k.v, k.ease));
    },

    async time({ t }) { E.evalAt(t, true); E.time = t; },
  };

  // ------------------------------------------------------------------ diff
  const byId = (doc) => new Map(doc.objects.map((o) => [o.id, o]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function diffDocs(a, b) {
    const A = byId(a), B = byId(b), out = { added: [], removed: [], changed: [], scene: !same(a.scene, b.scene), camera: !same(a.camera, b.camera), anim: !same(a.anim, b.anim) };
    B.forEach((o, id) => { if (!A.has(id)) out.added.push(id); });
    A.forEach((o, id) => {
      if (!B.has(id)) { out.removed.push(id); return; }
      const p = B.get(id), props = [...new Set([...Object.keys(o), ...Object.keys(p)])].filter((k) => !same(o[k], p[k]));
      if (props.length) out.changed.push({ id, props });
    });
    return out;
  }

  // ------------------------------------------------------------------ scores
  // Each score returns { value, detail }. value is 0..1 where higher is better.
  const scores = {
    printCheck(a = {}) {
      const r = E.printCheck(false, a.minWall);
      if (!r) throw new Error('nothing to check');
      const penalty = (r.closed ? 0 : 0.5) + Math.min(0.5, r.thinShare || 0);
      return { value: Math.max(0, 1 - penalty), detail: r };
    },
    fits({ box }) {
      const r = E.printCheck(false);
      if (!r) throw new Error('nothing to measure');
      const box3 = vec(box, 'box');
      const over = r.size.map((s, i) => Math.max(0, s / box3[i] - 1));
      return { value: Math.max(0, 1 - Math.max(...over)), detail: { size: r.size, box: box3 } };
    },
    triangles({ target = 20000 } = {}) {
      const r = E.printCheck(false);
      if (!r) throw new Error('nothing to measure');
      return { value: Math.min(1, target / Math.max(1, r.tris)), detail: { tris: r.tris, target } };
    },
    human({ snapshot }) {
      const s = snaps.get(snapshot);
      if (!s || s.human === undefined) throw new Error('no human rating on ' + snapshot);
      return { value: s.human, detail: { rated: true } };
    },
  };

  // ------------------------------------------------------------------ public API
  const api = {
    version: VERSION,

    describe() {
      return ok({
        app: '3DCraft', version: VERSION,
        ops: Object.keys(ops),
        shapes: Object.keys(E.SHAPES || {}),
        materials: Object.keys(E.MATERIALS || {}),
        modifiers: Object.keys((window.MODS && window.MODS.LIST) || {}),
        animProps: Object.keys(E.ANIM_PROPS || {}),
        eases: Object.keys(E.EASES || {}),
        scores: Object.keys(scores),
        formats: ['glb', 'obj', 'stl'],
      });
    },

    async newScene(opts = {}) { await load(E.newDoc(opts)); return ok({}); },

    async loadState(doc) {
      if (!doc || !Array.isArray(doc.objects)) return fail('bad_doc', 'Not a 3DCraft document');
      await load(clone(doc));
      return ok({});
    },

    state() { return need() || ok({ doc: clone(E.doc) }); },

    summary() {
      const bad = need(); if (bad) return bad;
      const objects = E.doc.objects.map((m) => {
        let size = null;
        try { if (m.kind === 'shape') size = E.shapeSize(m.shape).toArray(); } catch (e) { /* not every shape sizes on its own */ }
        return { id: m.id, name: m.name, kind: m.kind, shape: m.shape && m.shape.type, parent: m.parent, pos: m.pos, rot: m.rot, scale: m.scale, size,
          material: m.mat && m.mat.preset, color: m.mat && m.mat.color, visible: m.visible !== false, cutter: !!m.cutter,
          mods: (m.mods || []).map((x) => x.type + (x.on === false ? ' (off)' : '')), physics: m.phys ? m.phys.kind : null,
          animated: !!(E.doc.anim && E.doc.anim.tracks[m.id] && Object.keys(E.doc.anim.tracks[m.id].keys || {}).length) };
      });
      const check = (() => { try { return E.printCheck(false); } catch (e) { return null; } })();
      return ok({ name: E.doc.name, count: objects.length, camera: E.doc.camera, time: E.time || 0, anim: E.doc.anim ? { length: E.doc.anim.length, fps: E.doc.anim.fps } : null,
        problems: check ? { closed: check.closed, open: check.open, degenerate: check.degenerate, thinShare: check.thinShare } : null, objects });
    },

    // Runs ops in order; any failure restores the document as it was before the batch.
    async apply(list) {
      const bad = need(); if (bad) return bad;
      if (!Array.isArray(list)) return fail('bad_input', 'apply takes an array of ops');
      const before = clone(E.doc), results = [];
      try {
        for (const o of list) {
          if (!ops[o.op]) throw new Error('unknown op ' + o.op);
          results.push((await ops[o.op](o)) || {});
        }
        return ok({ results });
      } catch (e) {
        await load(before);
        return fail('apply_failed', e.message);
      }
    },

    snapshot(label) {
      const bad = need(); if (bad) return bad;
      const id = 's' + ++snapN;
      snaps.set(id, { label: label || '', doc: clone(E.doc) });
      return ok({ id });
    },

    async restore(id) {
      const s = snaps.get(id);
      if (!s) return fail('no_snapshot', 'No snapshot ' + id);
      await load(clone(s.doc));
      return ok({});
    },

    rate(id, value, note) {
      const s = snaps.get(id);
      if (!s) return fail('no_snapshot', 'No snapshot ' + id);
      if (!(value >= 0 && value <= 1)) return fail('bad_input', 'rating must be 0..1');
      s.human = value; s.note = note || '';
      return ok({});
    },

    snapshots() { return ok({ snapshots: [...snaps].map(([id, s]) => ({ id, label: s.label, human: s.human })) }); },

    diff(a, b) {
      const A = snaps.get(a), B = snaps.get(b);
      if (!A || !B) return fail('no_snapshot', 'Unknown snapshot');
      return ok({ diff: diffDocs(A.doc, B.doc) });
    },

    score(name, args = {}) {
      const bad = need(); if (bad) return bad;
      if (!scores[name]) return fail('unknown_score', name);
      try { return ok(scores[name](args)); } catch (e) { return fail('score_failed', e.message); }
    },

    render({ w = 512, h = 384, transparent = false, view } = {}) {
      const bad = need(); if (bad) return bad;
      if (view) { try { E.viewFrom(view); } catch (e) { return fail('bad_view', e.message); } }
      return ok({ image: E.renderImage(w, h, { transparent }).toDataURL('image/png') });
    },

    async export(fmt = 'glb', { scale = 1 } = {}) {
      const bad = need(); if (bad) return bad;
      if (!['glb', 'obj', 'stl'].includes(fmt)) return fail('bad_format', fmt);
      const blob = await E.exportModel(fmt, false, scale);
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return ok({ format: fmt, bytes: buf.length, base64: btoa(s) });
    },
  };

  window.craftAPI = api;
})();
