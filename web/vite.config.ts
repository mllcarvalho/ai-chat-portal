import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // o portal sobe em 4717 e vai subindo se a porta estiver ocupada — em dev,
      // aponte para a instância real com PORTAL_PORT=4718 npm run dev:web
      '/api': {
        target: `http://127.0.0.1:${process.env.PORTAL_PORT ?? 4717}`,
        // reescreve o Host: o servidor do portal recusa qualquer Host que não
        // seja o dele (proteção anti DNS-rebinding) e o dev server é :5173
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
