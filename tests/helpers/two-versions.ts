import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { cp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { extname, join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8'
};

const run = promisify(execFile);

/**
 * Two real static builds of the current source, retaining the selected demo policy when present.
 * B changes the lazy PDF engine (so its hashed file is new and A's is gone from the server)
 * and increases the local database version with nothing to migrate.
 */
export async function twoDeployments(scratch: string) {
  await rm(scratch, { recursive: true, force: true });
  const build = async (name: string, edit?: (source: string) => Promise<void>) => {
    // Release builds are named by commit, so two builds of one source would share a name.
    // These look like real release names: a 40-digit hex commit id.
    const env = { ...process.env, KIT_VERSION_NAME: createHash('sha1').update(`two-versions-${name}`).digest('hex') };
    const source = join(scratch, `${name}-source`);
    for (const entry of ['src', 'static', 'brand/symbol', 'data/authority-directory', 'data/rule-sets', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json', 'package.json']) {
      await cp(join(root, entry), join(source, entry), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(source, 'node_modules'));
    await edit?.(source);
    await run('npx', ['vite', 'build', ...(process.env.VITE_DEMO_TEST_RECIPIENT ? ['--mode', 'staging'] : [])], { cwd: source, env });
    return join(source, 'build');
  };
  const change = async (path: string, from: string, to: string) => {
    const text = await readFile(path, 'utf8');
    if (!text.includes(from)) throw new Error(`${from} not found in ${path}`);
    await writeFile(path, text.replace(from, to));
  };
  const a = await build('a');
  const b = await build('b', async source => {
    await change(join(source, 'src/lib/local-store.ts'), "openDB<Store>('bor-czuwa', 6,", "openDB<Store>('bor-czuwa', 7,");
    await writeFile(join(source, 'src/lib/notice-pdf.ts'), `${await readFile(join(source, 'src/lib/notice-pdf.ts'), 'utf8')}\nexport const release = 'b';\n`);
  });
  const facts = async (dir: string) => {
    const worker = await readFile(join(dir, 'service-worker.js'), 'utf8');
    return {
      version: JSON.parse(await readFile(join(dir, '_app/version.json'), 'utf8')).version as string,
      pdf: `/${/"src\/lib\/notice-pdf\.ts":\{file:"([^"]+)"/.exec(worker)![1]}`
    };
  };
  const [factsA, factsB] = await Promise.all([facts(a), facts(b)]);
  if (factsA.version === factsB.version || factsA.pdf === factsB.pdf) throw new Error('The two builds are not distinct releases.');
  return { a, b, versionA: factsA.version, versionB: factsB.version, pdfA: factsA.pdf, pdfB: factsB.pdf };
}

/** Serves one deployment at a time on a fixed origin. The API is down, so Reports stay queued. */
export async function deploymentServer(initial: string) {
  const state = { root: initial };
  const server: Server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    if (path.startsWith('/api/')) {
      response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}');
      return;
    }
    const file = join(state.root, path.endsWith('/') ? `${path}index.html` : path);
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    deploy(dir: string) { state.root = dir; },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}
