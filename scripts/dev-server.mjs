// Serves dist/ on http://localhost:4173 (run `npm run build:web` first).
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/testnet.mjs';

const port = Number(process.env.PORT || 4173);
createServer((req, res) => {
  const file = join(ROOT, 'dist', 'index.html');
  if (!existsSync(file)) return res.writeHead(500).end('run: npm run build:web');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(readFileSync(file));
}).listen(port, () => console.log(`Arf is at http://localhost:${port}`));
