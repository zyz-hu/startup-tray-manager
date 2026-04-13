import path from 'node:path';
import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      emptyOutDir: true
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      emptyOutDir: false
    }
  },
  renderer: {
    root: path.join(__dirname, 'src/renderer'),
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': path.join(__dirname, 'src/renderer/src'),
        '@shared': path.join(__dirname, 'src/shared')
      }
    },
    build: {
      outDir: path.join(__dirname, 'out/renderer'),
      emptyOutDir: false
    }
  }
});
