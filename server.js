import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '0.0.0.0';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    const filePath = path.normalize(path.join(root, pathname));
    if (!filePath.startsWith(root + path.sep) && filePath !== path.join(root, 'index.html')) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      res.writeHead(302, { location: '/index.html' }).end();
      return;
    }

    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Internal server error');
  }
});

server.listen(port, host, () => {
  console.log(`错误预算计算器已启动：http://127.0.0.1:${port}（监听 ${host}）`);
});
