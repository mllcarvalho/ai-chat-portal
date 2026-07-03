import { Router, sendError, sendJson } from '../router';
import { getConfig, patchConfig } from '../../storage/configStore';
import {
  applyNpmrcSettings,
  applyProxyToProcessEnv,
  applyProxyToRcFiles,
  applyProxyToVsCode,
  buildProxyUrl,
  proxyHost,
} from '../../tools/proxySetup';

/**
 * Login do portal (usuário RACF + senha). Não é autenticação do servidor — o
 * acesso à API continua pelo token. O login existe para configurar o proxy
 * corporativo da máquina: settings.json do VS Code + rc do shell + env atual.
 */
export function registerLoginRoutes(router: Router): void {
  // estado para a tela de login (pré-preenche o último RACF; senha nunca volta)
  router.get('/api/login', ({ res }) => {
    const cfg = getConfig();
    sendJson(res, 200, {
      username: cfg.racfUser,
      configured: !!cfg.racfUser,
      proxyHost: proxyHost(),
    });
  });

  router.post('/api/login', async ({ res, body }) => {
    const input = (body ?? {}) as { username?: string; password?: string };
    const username = input.username?.trim();
    const password = input.password ?? '';
    if (!username || !password) {
      // em branco a UI nem chama esta rota (entra sem configurar proxy) —
      // aqui só chega submissão incompleta
      sendError(res, 400, 'Informe o usuário (RACF) e a senha para configurar o proxy');
      return;
    }
    const proxyUrl = buildProxyUrl(username, password);
    try {
      await applyProxyToVsCode(proxyUrl);
    } catch (err) {
      sendError(res, 500, `Falha ao gravar http.proxy no VS Code: ${(err as Error).message}`);
      return;
    }
    let rcFiles: string[] = [];
    try {
      rcFiles = applyProxyToRcFiles(proxyUrl, proxyUrl).updated;
    } catch (err) {
      sendError(
        res,
        500,
        `http.proxy do VS Code atualizado, mas falhou ao gravar os rc do shell: ${(err as Error).message}`,
      );
      return;
    }
    const network = getConfig().network;
    try {
      rcFiles.push(applyNpmrcSettings(network?.extraCaCerts));
    } catch (err) {
      sendError(
        res,
        500,
        `Proxy configurado no VS Code e no shell, mas falhou ao gravar o ~/.npmrc: ${(err as Error).message}`,
      );
      return;
    }
    applyProxyToProcessEnv(proxyUrl, proxyUrl);
    // os valores ficam visíveis/editáveis na tela de Configurações (rede)
    patchConfig({
      racfUser: username,
      network: { ...network, httpProxy: proxyUrl, httpsProxy: proxyUrl },
    });
    sendJson(res, 200, { ok: true, username, proxyHost: proxyHost(), rcFiles });
  });
}
