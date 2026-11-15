import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

// Serves a built directory from disk on a loopback port, with directory index files.
export async function serve(root: string): Promise<{ origin: string; server: Server }> {
  if (!existsSync(root)) throw new Error(`${root} is missing; run npm run test:landing, which builds both sites first`);
  const server = createServer((request, response) => {
    let file = root;
    try { file = path.join(root, decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)); } catch { file = ''; }
    if (file && existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(root + path.sep) || !existsSync(file)) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
    response.end(readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
