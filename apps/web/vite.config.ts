import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [tailwindcss()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
});
