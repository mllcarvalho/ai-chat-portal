import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const readPkg = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
// a UI hospedada é sempre a mais nova; ela compara com a versão da extensão
// local (health) para avisar quem está atrasado — e sabe o comando de atualizar
const extensionVersion: string = readPkg('../extension/package.json').version;
const installerPkg: string = readPkg('../installer/package.json').name;

export default defineConfig({
  plugins: [react()],
  define: {
    __PORTAL_VERSION__: JSON.stringify(extensionVersion),
    __INSTALLER_PKG__: JSON.stringify(installerPkg),
  },
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
