import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
    chunkSizeWarningLimit: 900,
  },
  server: { port: 5199, strictPort: true },
});
