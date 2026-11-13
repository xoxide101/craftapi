// Runs the browser smoke tests (real 3dcraft in headless Chrome) or skips them cleanly when the prerequisites are missing.
// CRAFT_REQUIRE_BROWSER=1 turns a skip into a failure (use in CI where Chrome is expected).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserPrereqs } from './session.mjs';

const pre = browserPrereqs();
if (!pre.ok) {
  console.log(`SKIPPED browser smoke tests (smoke.mjs, mcp-smoke.mjs): ${pre.reason}`);
  process.exit(process.env.CRAFT_REQUIRE_BROWSER === '1' ? 1 : 0);
}
for (const f of ['smoke.mjs', 'mcp-smoke.mjs']) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(f, import.meta.url))], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
