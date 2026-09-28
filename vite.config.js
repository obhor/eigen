import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      }
    }
  },
  server: {
    port: 5173
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
    // the dep optimizer mishandles onnxruntime's wasm/.mjs asset URLs
    exclude: ['@huggingface/transformers']
  },
  worker: {
    format: 'es'   // the worker dynamic-imports ORT internals; iife cannot
  }
});
