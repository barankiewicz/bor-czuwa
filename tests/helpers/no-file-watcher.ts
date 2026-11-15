import type { Plugin } from 'vite';

// Tests only SSR-load modules from a Vite dev server, so they need no file watcher. Without this,
// chokidar takes about 2,600 inotify watches per server, and a busy host's limit fails the test
// with ENOSPC. Vite's mergeConfig drops null values, so `server.watch: null` in inline config
// never arrives; setting it in a config hook does.
export const noFileWatcher: Plugin = {
  name: 'no-file-watcher',
  config(config) {
    config.server = { ...config.server, watch: null };
  },
};
