// Headless 3dcraft session: launches Chrome, opens the app from disk, injects craftapi.js.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_APP = process.env.CRAFT3D_INDEX || 'C:/Users/raver/3dcraft/index.html';

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

/** Returns { ok:true } or { ok:false, reason } so callers can skip browser tests cleanly. */
export function browserPrereqs(app = DEFAULT_APP) {
  if (!BROWSERS.find(existsSync)) return { ok: false, reason: 'no Chrome/Edge found (set CHROME_PATH)' };
  if (!existsSync(path.resolve(app))) return { ok: false, reason: `3dcraft not found at ${path.resolve(app)} (set CRAFT3D_INDEX)` };
  return { ok: true };
}

export async function openSession({ app = DEFAULT_APP, headless = true } = {}) {
  const exe = BROWSERS.find(existsSync);
  if (!exe) throw new Error('No Chrome or Edge found; set CHROME_PATH');
  const indexPath = path.resolve(app);
  if (!existsSync(indexPath)) throw new Error('3dcraft index.html not found: ' + indexPath);

  const browser = await chromium.launch({ executablePath: exe, headless, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(pathToFileURL(indexPath).href);
  await page.waitForFunction(() => window.E3 && window.E3.newDoc, null, { timeout: 30000 });
  await page.addScriptTag({ content: readFileSync(path.join(here, '../browser/craftapi.js'), 'utf8') });

  const call = (fn, ...args) => page.evaluate(([f, a]) => {
    if (typeof window.craftAPI[f] !== 'function') return { ok: false, error: { code: 'no_command', message: 'No command ' + f } };
    return window.craftAPI[f](...a);
  }, [fn, args]);

  const session = {
    page, errors, call,
    close: () => browser.close(),
  };
  const first = await call('newScene', {});
  if (!first.ok) { await browser.close(); throw new Error('newScene failed: ' + JSON.stringify(first.error)); }
  return session;
}
