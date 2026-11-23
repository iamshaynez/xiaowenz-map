// Put the page online: app/ as it is, as a Worker of files only (wrangler.jsonc at the root of the repository).
// Wrangler does the work (`npx wrangler deploy`, fetched by npx when it is not on the machine); this only checks
// first that the two domains are no longer the examples, makes what .env says of CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID known to wrangler, for a machine where `npx wrangler login` cannot open a browser, and says
// what is being put online.
//
// Usage: npm run deploy                      (node tools/deploy/deploy.mjs; anything after -- is wrangler's)
//        npm run deploy -- --dry-run         what would be put online, and nothing is
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { told } from './env.mjs';
import { ROOT, ids } from './manifest.mjs';

// the one address named in the page's configuration and in wrangler's
const named = (file, pattern) => readFileSync(join(ROOT, file), 'utf8').match(pattern)?.[1];
const domain = named('wrangler.jsonc', /"pattern":\s*"([^"]+)"/);
const data = named(join('app', 'src', 'config.js'), /'(https:\/\/[^']+)'/);
for (const [what, address] of [['the page', domain], ['the data', data]]) {
  if (!address || address.includes('example.com')) {
    console.error(`the domain of ${what} is still the example (${address}): put your own there first, as deploy/README.md says`);
    process.exit(2);
  }
}
const env = { ...process.env }, said = told();
for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) if (!env[name] && said[name]) env[name] = said[name];
console.log(`putting the page online at https://${domain}; its cities' data is fetched from ${data}`);
console.log(`cities the repository defines: ${ids(ROOT).join(' ') || 'none'}`);
const at = process.argv.indexOf('--');
const run = spawnSync('npx', ['--yes', 'wrangler', 'deploy', ...(at < 0 ? [] : process.argv.slice(at + 1))], { cwd: ROOT, stdio: 'inherit', env });
process.exit(run.status ?? 1);
