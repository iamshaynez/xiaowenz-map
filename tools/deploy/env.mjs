// What publishing and deploying need to be told. They come from the environment or from a .env file at the root of
// the repository, which is not kept in git (.env.example at the root lists what goes in it): the R2 account, the
// bucket, and the keys of a token that may write to it, for publishing and checking; and for wrangler, where
// `npx wrangler login` cannot open a browser, an API token. What the environment says comes first.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './manifest.mjs';
import { R2 } from './r2.mjs';

export const NEEDED = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const OURS = /^(R2_|CLOUDFLARE_)/;

// -> { name: value }: what the environment and .env say of what is ours
export function told(root = ROOT) {
  const file = join(root, '.env'), said = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !line.trim().startsWith('#')) said[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const saidByTheEnvironment = Object.entries(process.env).filter(([name, value]) => OURS.test(name) && value);
  return { ...said, ...Object.fromEntries(saidByTheEnvironment) };
}

// -> what publishing needs, or a message naming what it was not told
export function settings(said = told()) {
  const missing = NEEDED.filter(name => !said[name]);
  if (missing.length) throw new Error(`not told ${missing.join(', ')}: put them in .env at the root of the repository, as .env.example shows`);
  return Object.fromEntries([...NEEDED, 'R2_ENDPOINT'].filter(name => said[name]).map(name => [name, said[name]]));
}

// -> R2: the bucket those tell of. endpoint and send are for a server of this project's own.
export function client(said = settings(), { endpoint = said.R2_ENDPOINT, send } = {}) {
  return new R2({ accountId: said.R2_ACCOUNT_ID, bucket: said.R2_BUCKET, accessKeyId: said.R2_ACCESS_KEY_ID, secretAccessKey: said.R2_SECRET_ACCESS_KEY, endpoint, send });
}
