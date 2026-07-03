import { Router, sendError, sendJson } from '../router';
import { getConfig, patchConfig } from '../../storage/configStore';
import {
  applyNpmrcSettings,
  applyProxyToProcessEnv,
  applyProxyToRcFiles,
  applyProxyToVsCode,
} from '../../tools/proxySetup';

export function registerConfigRoutes(router: Router): void {
  router.get('/api/config', ({ res }) => {
    const { token: _token, ...safe } = getConfig();
    sendJson(res, 200, safe);
  });

  router.patch('/api/config', async ({ res, body }) => {
    const patch = (body ?? {}) as {
      projectsRoot?: string;
      network?: {
        httpsProxy?: string;
        httpProxy?: string;
        noProxy?: string;
        extraCaCerts?: string;
      };
      microsoft?: { clientId?: string; tenant?: string };
    };
    if (patch.projectsRoot !== undefined && !patch.projectsRoot.trim()) {
      sendError(res, 400, 'projectsRoot não pode ser vazio');
      return;
    }
    const httpsProxy = patch.network?.httpsProxy?.trim() || undefined;
    const network =
      patch.network !== undefined
        ? {
            httpsProxy,
            // HTTP_PROXY vazio segue o HTTPS_PROXY — em geral são o mesmo valor
            httpProxy: patch.network.httpProxy?.trim() || httpsProxy,
            noProxy: patch.network.noProxy?.trim() || undefined,
            extraCaCerts: patch.network.extraCaCerts?.trim() || undefined,
          }
        : undefined;
    const microsoft =
      patch.microsoft !== undefined
        ? {
            clientId: patch.microsoft.clientId?.trim() || undefined,
            tenant: patch.microsoft.tenant?.trim() || undefined,
          }
        : undefined;
    const previous = getConfig().network;
    const updated = patchConfig({
      ...(patch.projectsRoot ? { projectsRoot: patch.projectsRoot.trim() } : {}),
      ...(network ? { network } : {}),
      ...(microsoft ? { microsoft } : {}),
    });
    // mantém em sincronia os arquivos gravados no login (settings.json do
    // VS Code, .bashrc/.zshrc e ~/.npmrc) quando a rede muda por esta tela
    if (network) {
      try {
        const proxyChanged =
          network.httpsProxy !== previous?.httpsProxy || network.httpProxy !== previous?.httpProxy;
        if (proxyChanged && (network.httpsProxy || network.httpProxy)) {
          const https = network.httpsProxy ?? network.httpProxy ?? '';
          const http = network.httpProxy ?? https;
          await applyProxyToVsCode(https);
          applyProxyToRcFiles(http, https);
          applyProxyToProcessEnv(http, https);
        }
        if (network.extraCaCerts !== previous?.extraCaCerts) {
          applyNpmrcSettings(network.extraCaCerts);
        }
      } catch (err) {
        sendError(
          res,
          500,
          `Configuração salva, mas falhou ao reaplicar nos arquivos da máquina: ${(err as Error).message}`,
        );
        return;
      }
    }
    const { token: _token, ...safe } = updated;
    sendJson(res, 200, safe);
  });
}
