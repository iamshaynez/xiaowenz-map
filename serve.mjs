// Local static server for the project. No dependencies: `node serve.mjs`, then open http://127.0.0.1:5300/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 5300;
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(400, 'bad request');
  }
  if (pathname === '/') {
    res.writeHead(302, { location: '/app/' });
    return res.end();
  }
  const target = resolve(root, '.' + pathname);
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) return send(403, 'forbidden');
  try {
    let file = target;
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    send(404, 'not found');
  }
}).listen(port, host, () => {
  console.log(`serving ${root} at http://${host}:${port}/app/`);
});
