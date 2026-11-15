import { execFileSync } from 'node:child_process';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// SvelteKit's default version name is the build start time, which flows into every hashed chunk
// and makes two builds of one commit differ. A clean checkout names the build by its commit so
// anyone can rebuild a release and get the same bytes. A dirty tree, a build without git (the
// container build context excludes .git) and a missing git binary keep the default. The override
// lets a test build two releases from one commit.
function versionName() {
  if (process.env.KIT_VERSION_NAME) return process.env.KIT_VERSION_NAME;
  try {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (git('rev-parse', '--show-toplevel') !== process.cwd()) return undefined;
    if (git('status', '--porcelain')) return undefined;
    return git('rev-parse', 'HEAD');
  } catch { return undefined; }
}

const name = versionName();

export default {
  preprocess: vitePreprocess(),
  kit: { adapter: adapter(), ...(name ? { version: { name } } : {}) }
};
