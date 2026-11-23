// The signing of R2 requests, checked against three of the examples AWS publishes with Signature Version 4 -- the
// ones botocore's own signing is tested with: a plain GET, a GET with a query string, and a POST. Then the requests
// themselves, as they go out: what is signed is what is sent.
//
// Usage: node tools/tests/r2-signing.cjs
const assert = require('node:assert');
const { createHash } = require('node:crypto');

const EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', service: 'service', region: 'us-east-1', host: 'example.amazonaws.com' };
const WHEN = new Date('2015-08-30T12:36:00Z');
const LONG = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

async function main() {
  const { R2, signedHeaders } = await import('../deploy/r2.mjs');
  // the examples sign the host and the date, as the algorithm has it; S3's extra header is R2's, and is checked below
  const signature = request => signedHeaders({ ...EXAMPLE, now: WHEN, hashHeader: false, ...request }).authorization;
  const said = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', service: 'service', region: 'us-east-1' };

  // ---- the published examples ------------------------------------------------------------------------------------
  // GET / : the headers signed are host and x-amz-date, and nothing is sent
  assert.strictEqual(signature({ method: 'GET', path: '/' }),
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  // GET /?Param1=value1, with every character left as it is in a query string
  assert.strictEqual(signature({ method: 'GET', path: '/', query: `${LONG}=${LONG}` }),
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197');
  // POST /
  assert.strictEqual(signature({ method: 'POST', path: '/' }),
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');
  // the whole header: what is signed is named, the scope is the day, the region, the service
  const whole = signedHeaders({ ...EXAMPLE, now: WHEN, method: 'PUT', path: '/bucket/a.bin', headers: { 'content-type': 'application/octet-stream' }, payload: new TextEncoder().encode('data') });
  assert.deepStrictEqual(Object.keys(whole), ['host', 'content-type', 'x-amz-content-sha256', 'x-amz-date', 'authorization']);
  assert.strictEqual(whole['x-amz-date'], '20150830T123600Z');
  assert.strictEqual(whole['x-amz-content-sha256'], createHash('sha256').update('data').digest('hex'));
  assert.ok(whole.authorization.includes('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,'), whole.authorization);

  // ---- the requests as they go out --------------------------------------------------------------------------------
  const sent = [];
  const reply = (status, headers = {}, body = null) => new Response(body, { status, headers });
  const r2 = new R2({ ...said, accountId: 'account', bucket: 'bucket', now: WHEN, send: async (url, init) => { sent.push({ url, ...init }); return reply(200, { 'content-length': String(init.body?.length || 0), etag: '"abc"' }); } });

  await r2.put('hz/objects/0123abcd.bin', new TextEncoder().encode('bytes'), { type: 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable', contentEncoding: 'gzip' });
  assert.strictEqual(sent[0].url, 'https://account.r2.cloudflarestorage.com/bucket/hz/objects/0123abcd.bin');
  assert.strictEqual(sent[0].method, 'PUT');
  assert.strictEqual(sent[0].headers['content-encoding'], 'gzip');
  assert.strictEqual(sent[0].headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.strictEqual(sent[0].headers['content-type'], 'application/octet-stream');
  assert.ok(sent[0].headers.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/auto/s3/aws4_request, SignedHeaders=cache-control;content-encoding;content-type;host;x-amz-content-sha256;x-amz-date, Signature='), sent[0].headers.authorization);
  assert.strictEqual(sent[0].headers['x-amz-content-sha256'], createHash('sha256').update('bytes').digest('hex'));
  assert.strictEqual(sent[0].headers.host, undefined, 'fetch sets the host itself: it is signed but not sent by hand');

  // a name with characters a path has to have encoded: encoded once in the address, and once in what is signed
  await r2.put('a b/c+d.bin', new Uint8Array());
  assert.strictEqual(sent[1].url, 'https://account.r2.cloudflarestorage.com/bucket/a%20b/c%2Bd.bin');
  // signed as the request is: S3 in R2's region, over the path before it was encoded
  assert.strictEqual(sent[1].headers.authorization, signedHeaders({ accessKeyId: said.accessKeyId, secretAccessKey: said.secretAccessKey, now: WHEN, method: 'PUT',
    host: 'account.r2.cloudflarestorage.com', path: '/bucket/a b/c+d.bin', payload: new Uint8Array() }).authorization);

  // head: what is there, or null
  assert.deepStrictEqual(await r2.head('hz/manifest.json'), { bytes: 0, etag: '"abc"', type: null, encoding: null, cacheControl: null });
  assert.strictEqual(sent[2].method, 'HEAD');
  const missing = new R2({ ...said, accountId: 'account', bucket: 'bucket', send: async () => reply(404) });
  assert.strictEqual(await missing.head('nope'), null);
  assert.strictEqual(await missing.get('nope'), null);
  assert.strictEqual(await missing.json('nope'), null);

  // get and json: the bytes, as they are
  const store = new R2({ ...said, accountId: 'account', bucket: 'bucket', send: async () => reply(200, {}, '{"cities":[]}') });
  assert.deepStrictEqual(await store.json('cities.json'), { cities: [] });
  assert.deepStrictEqual([...await store.get('cities.json')], [...new TextEncoder().encode('{"cities":[]}')]);

  // what is refused: a PUT answered with an error says so, and R2 wants its keys
  const refusing = new R2({ ...said, accountId: 'account', bucket: 'bucket', send: async () => reply(403, {}, 'SignatureDoesNotMatch') });
  await assert.rejects(refusing.put('k', new Uint8Array()), /putting k: 403 SignatureDoesNotMatch/);
  assert.throws(() => new R2({ accountId: 'a', bucket: 'b' }), /access key/);
  assert.throws(() => new R2({ bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }), /account id/);

  // ---- what was not checked ---------------------------------------------------------------------------------------
  // The examples are of the algorithm, not of R2: that R2 takes these requests is checked the first time publishing
  // is run against a real bucket (deploy/README.md).
  console.log('r2 signing: 3 published examples, 9 checks on the requests as they go out: all as expected');
}

main().catch(error => { console.error(error); process.exit(1); });
