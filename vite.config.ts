import path from 'node:path';
import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(__dirname, 'src/renderer'),
  plugins: [vue()],
  resolve: {
    alias: {
      '@renderer': path.join(__dirname, 'src/renderer/src'),
      '@shared': path.join(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true
  }
});
