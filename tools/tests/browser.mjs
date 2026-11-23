// The browser tests, one after another (they share the graphics card), each one's output kept in out/test-runs/<name>.log,
// and a summary at the end. They each start a dev server of their own on a port of their own.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/browser.mjs [name ...]     no names: every one but fidelity
//        fidelity.cjs is left out on purpose: it is slow, and its exit code is 1 by design (README, "测试")
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('../../', import.meta.url));
const out = join(here, 'out', 'test-runs');
const EVERY = ['smoke', 'home', 'search', 'tour', 'landmark-views', 'mobile', 'mouse', 'zoom-anchor', 'cities', 'flight', 'published'];
const asked = process.argv.slice(2).map(name => name.replace(/\.cjs$/, '').replace(/^tools\/tests\//, ''));
const names = asked.length ? asked : EVERY;
const rows = [];

mkdirSync(out, { recursive: true });
for (const name of names) {
  const file = join(here, 'tools', 'tests', `${name}.cjs`);
  const start = Date.now();
  const run = spawnSync(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const log = (run.stdout || '') + (run.stderr || '');
  writeFileSync(join(out, `${name}.log`), log);
  const last = log.trimEnd().split('\n').at(-1) || '';
  rows.push(`${name.padEnd(16)} ${run.status === 0 ? 'ok  ' : 'FAIL'}  ${String(Math.round((Date.now() - start) / 1000)).padStart(4)} s   ${run.status === 0 ? last.slice(0, 90) : last.split('\n').filter(Boolean).at(-1)?.slice(0, 150)}`);
  console.log(rows.at(-1));
}
const failed = rows.filter(row => row.includes(' FAIL ')).length;
writeFileSync(join(out, 'summary.txt'), rows.join('\n') + '\n');
console.log(failed ? `${failed} of ${rows.length} FAILED (logs in out/test-runs/)` : `${rows.length} browser tests, all ok`);
process.exitCode = failed ? 1 : 0;
