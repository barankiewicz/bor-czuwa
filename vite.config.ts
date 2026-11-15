import { createHash } from 'node:crypto';
import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { resolveDemoTestRecipient, validateDemoApiOrigin } from './src/lib/demo-policy';
import { releaseVersionShape } from './src/lib/version-shapes';

export default defineConfig(({ mode, command }) => {
  const environment = loadEnv(mode, process.cwd(), 'VITE_');
  const recipient = resolveDemoTestRecipient(mode, environment.VITE_DEMO_TEST_RECIPIENT);
  if (recipient && environment.VITE_API_ORIGIN) validateDemoApiOrigin(environment.VITE_API_ORIGIN);
  const source = `export const buildConfiguration = ${JSON.stringify({ mode,
    apiOrigin: environment.VITE_API_ORIGIN ?? '', demoTestRecipient: recipient ?? '' })};\n`;
  const filename = `_app/immutable/bor-build-configuration-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.js`;
  // The server accepts only an N.N.N app_version, so a package.json version of another shape must stop the build.
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
  if (!releaseVersionShape(version)) throw new Error(`package.json version ${version} is not N.N.N`);
  let serverBuild = false;
  return {
  plugins: [{
    name: 'bor-build-configuration',
    enforce: 'pre',
    configResolved(config) { serverBuild = !!config.build.ssr; },
    resolveId(id, importer, options) {
      if (command === 'build' && !options.ssr && id === './build-configuration.js'
        && importer && path.dirname(importer) === path.resolve('src/lib')) {
        return { id: `/${filename}`, external: 'absolute' };
      }
    },
    outputOptions(options) {
      if (!serverBuild) return { ...options, minifyInternalExports: false, onlyExplicitManualChunks: true,
        chunkFileNames(chunk) {
          if (['bor-api-url', 'bor-demo-handoff'].includes(chunk.name)) return `_app/immutable/chunks/${chunk.name}.[hash].js`;
          return typeof options.chunkFileNames === 'function' ? options.chunkFileNames(chunk) : options.chunkFileNames!;
        },
        manualChunks(id) {
          if (id === path.resolve('src/lib/api-url.ts')) return 'bor-api-url';
          if (id === path.resolve('src/lib/demo-handoff.ts') || id === path.resolve('src/lib/demo-policy.ts')) return 'bor-demo-handoff';
        }
      };
    },
    generateBundle() {
      if (!serverBuild) this.emitFile({ type: 'asset', fileName: filename, source });
    }
  }, sveltekit()],
  // Keep Chromium aligned with capacitor.config.ts's minimum WebView.
  build: { target: ['chrome107', 'edge107', 'firefox104', 'safari16'] },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
    'import.meta.env.VITE_BUILD_CONFIGURATION_PATH': JSON.stringify(`/${filename}`),
    'import.meta.env.VITE_STAGING_BUILD': JSON.stringify(command === 'serve' || mode === 'staging'),
    'import.meta.env.VITE_DEMO_TEST_RECIPIENT': JSON.stringify(recipient ?? '')
  },
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } }
  };
});
