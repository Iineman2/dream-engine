// Minimal static server for local use. Binds to 127.0.0.1 only.
// On the phone, `adb reverse tcp:8787 tcp:8787` makes http://localhost:8787 a
// secure context, so the microphone, wake lock and offline install all work
// without publishing anything.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || process.argv[2] || 8787);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8',
};
const DENY = ['node_modules', 'qa', 'tests', '.git'];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT + sep) || DENY.some((d) => file.includes(sep + d + sep))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'microphone=(self), screen-wake-lock=(self), camera=(), geolocation=()',
    });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500).end('Server error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dream Engine on http://localhost:${PORT}`);
});
