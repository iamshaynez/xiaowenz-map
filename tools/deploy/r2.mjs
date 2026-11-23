// R2 as S3: the three requests publishing needs -- put, head and get an object -- signed the way S3 asks (Signature
// Version 4). R2 speaks S3 at https://<account>.r2.cloudflarestorage.com/<bucket>/<key>. No dependency: a signature is
// a chain of HMAC-SHA256s, and the request is a fetch. tools/tests/r2-signing.cjs checks the signing against the
// examples AWS publishes with the algorithm.
import { createHash, createHmac } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
// a path as a request carries it and as it is signed: each segment encoded once, the slashes kept
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');

// -> every header of the request, signed: { lower-case name: value }, `host` among them (it is signed, but fetch sets
// it itself, so it is taken out before the request is sent). `now` is a parameter so that a published example can be
// reproduced; `headers` are the others that are signed, as they are sent. S3 asks for one more signed header than
// the algorithm does, x-amz-content-sha256 (hashHeader); the examples AWS publishes are of the algorithm without it.
export function signedHeaders({ method, host, path, query = '', headers = {}, payload = new Uint8Array(), accessKeyId, secretAccessKey, service = 's3', region = 'auto', now = new Date(), hashHeader = true }) {
  const when = now.toISOString().replace(/[:-]|\.\d{3}/g, '');            // 20261123T093000Z
  const day = when.slice(0, 8);
  const digest = sha256(payload);
  const all = { host, ...headers, ...(hashHeader ? { 'x-amz-content-sha256': digest } : {}), 'x-amz-date': when };
  const names = Object.keys(all).sort();
  // the canonical request: the method, the path, the query string, the signed headers in order of their names (each
  // ending in a newline, and then one more), their names, and the hash of what is sent
  const canonical = [method, encodePath(path), query, names.map(name => `${name}:${String(all[name]).trim()}\n`).join(''), names.join(';'), digest].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', when, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  all.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(key, toSign).toString('hex')}`;
  return all;
}

export class R2 {
  // endpoint: for a server of this project's own that speaks S3 (tools/tests/deploy.cjs); without it, R2 itself.
  // now: what the request is dated, for the tests.
  constructor({ accountId, bucket, accessKeyId, secretAccessKey, endpoint, send = fetch, now }) {
    if (!bucket || !accessKeyId || !secretAccessKey) throw new Error('R2 wants a bucket, an access key id and a secret access key (deploy/.env.example says where they come from)');
    if (!endpoint && !accountId) throw new Error('R2 wants the account id (or an endpoint)');
    this.base = (endpoint || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');
    this.host = new URL(this.base).host;
    this.bucket = bucket;
    this.keys = { accessKeyId, secretAccessKey };
    this.send = send;
    this.now = now;
  }

  async request(method, key, { body = null, headers = {} } = {}) {
    const path = `/${this.bucket}/${key}`;
    const signed = signedHeaders({ method, host: this.host, path, headers, payload: body ?? new Uint8Array(), now: this.now, ...this.keys });
    delete signed.host;                                                      // fetch sets it from the address
    return this.send(this.base + encodePath(path), { method, headers: signed, body });
  }

  // body: bytes. type: the content type the object is served with; cacheControl and contentEncoding: the same, as
  // HTTP headers when it is fetched. What is stored is what is sent to a browser: publish.mjs puts a file here
  // gzipped, with contentEncoding 'gzip', and the browser unpacks it itself.
  async put(key, body, { type, cacheControl, contentEncoding } = {}) {
    const headers = Object.fromEntries(Object.entries({ 'content-type': type, 'cache-control': cacheControl, 'content-encoding': contentEncoding }).filter(([, value]) => value));
    const response = await this.request('PUT', key, { body, headers });
    if (!response.ok) throw new Error(`putting ${key}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }

  // -> { bytes, etag, type, encoding, cacheControl } or null when there is no such object
  async head(key) {
    const response = await this.request('HEAD', key);
    if (response.ok) return { bytes: Number(response.headers.get('content-length')), etag: response.headers.get('etag'), type: response.headers.get('content-type'),
                              encoding: response.headers.get('content-encoding'), cacheControl: response.headers.get('cache-control') };
    if (response.status === 404) return null;
    throw new Error(`asking after ${key}: ${response.status}`);
  }

  // -> the object's bytes, or null when there is no such object: what was put here before it was compressed, as fetch
  // unpacks what it is served with Content-Encoding
  async get(key) {
    const response = await this.request('GET', key);
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (response.status === 404) return null;
    throw new Error(`getting ${key}: ${response.status}`);
  }

  // -> the object's bytes as JSON, or null when there is no such object. A list in the bucket is compressed like
  // every file; fetch unpacks it, and should it come as it was put here (fetch keeps the header either way), it is
  // unpacked here.
  async json(key) {
    const response = await this.request('GET', key);
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`getting ${key}: ${response.status}`);
    }
    let bytes = Buffer.from(await response.arrayBuffer());
    const parse = () => JSON.parse(bytes.toString('utf8'));
    try {
      return parse();
    } catch (notJson) {
      const encoding = response.headers.get('content-encoding');
      if (encoding !== 'br' && encoding !== 'gzip') throw notJson;
      bytes = encoding === 'br' ? brotliDecompressSync(bytes) : gunzipSync(bytes);
      return parse();
    }
  }
}
