import * as vscode from 'vscode';
import type { SharedLibrary } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import {
  libraryStatus,
  listLibraries,
  saveLibraries,
  sharedRevision,
} from '../../storage/sharedLibrary';
import { getConfig, patchConfig } from '../../storage/configStore';
import {
  applyNpmrcSettings,
  applyProxyToProcessEnv,
  applyProxyToRcFiles,
  applyProxyToVsCode,
  detectNpmrcCafile,
} from '../../tools/proxySetup';

export function registerConfigRoutes(router: Router): void {
  // bibliotecas compartilhadas (pastas de rede com skills/agentes/bases)
  /**
   * Impressão digital das pastas compartilhadas. A UI faz poll aqui (barato: o
   * valor sai de cache) e recarrega a lista quando o hash do tipo muda — é
   * assim que a alteração feita por OUTRA pessoa aparece sem ninguém apertar
   * "atualizar".
   */
  router.get('/api/shared-libraries/revision', ({ res }) => {
    sendJson(res, 200, sharedRevision());
  });

  router.get('/api/shared-libraries', ({ res }) => {
    sendJson(res, 200, listLibraries().map(libraryStatus));
  });

  router.put('/api/shared-libraries', ({ res, body }) => {
    const input = (body ?? {}) as { libraries?: Array<Partial<SharedLibrary>> };
    if (!Array.isArray(input.libraries)) {
      sendError(res, 400, 'Informe a lista de bibliotecas');
      return;
    }
    try {
      const saved = saveLibraries(input.libraries);
      sendJson(res, 200, saved.map(libraryStatus));
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  // abre o seletor nativo de pastas na janela do VS Code (caminho de rede
  // digitado à mão também vale — o PUT aceita qualquer string)
  router.post('/api/shared-libraries/pick', async ({ res }) => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Usar esta pasta',
      title: 'Escolha a pasta compartilhada da equipe',
    });
    if (!picked?.length) {
      sendJson(res, 200, { ok: false, cancelled: true });
      return;
    }
    sendJson(res, 200, { ok: true, path: picked[0].fsPath });
  });

  router.get('/api/config', ({ res }) => {
    const { token: _token, ...safe } = getConfig();
    // se há um cafile no ~/.npmrc mas o campo "CA interna" nunca foi preenchido
    // aqui, exibe o do arquivo — assim o usuário vê o cert dele e não o perde
    if (!safe.network?.extraCaCerts) {
      const detected = detectNpmrcCafile();
      if (detected) safe.network = { ...(safe.network ?? {}), extraCaCerts: detected };
    }
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
      commandAllowlist?: string[];
      captureBrowser?: string;
    };
    // navegador da captura SSO: só os que falam CDP (Firefox não fala)
    const CAPTURE_BROWSERS = ['Chrome', 'Edge', 'Brave'] as const;
    type CaptureBrowser = (typeof CAPTURE_BROWSERS)[number];
    const captureBrowser =
      patch.captureBrowser === undefined
        ? undefined
        : ((CAPTURE_BROWSERS as readonly string[]).includes(patch.captureBrowser)
            ? (patch.captureBrowser as CaptureBrowser)
            : // string vazia (ou lixo) volta ao automático
              null);
    // lista de executáveis liberados sem aprovação: só tokens simples
    const commandAllowlist =
      patch.commandAllowlist !== undefined
        ? [
            ...new Set(
              patch.commandAllowlist
                .filter((c): c is string => typeof c === 'string')
                .map((c) => c.trim())
                .filter((c) => c && !/\s/.test(c) && c.length <= 64),
            ),
          ].slice(0, 100)
        : undefined;
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
    // aplica primeiro nos arquivos da máquina (settings.json do VS Code,
    // .bashrc/.zshrc e ~/.npmrc); só persiste a config se tudo deu certo —
    // evita config salva divergente do que está gravado na máquina
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
          `Nada foi salvo: falhou ao aplicar a rede nos arquivos da máquina: ${(err as Error).message}`,
        );
        return;
      }
    }
    const updated = patchConfig({
      ...(patch.projectsRoot ? { projectsRoot: patch.projectsRoot.trim() } : {}),
      ...(network ? { network } : {}),
      ...(microsoft ? { microsoft } : {}),
      ...(commandAllowlist !== undefined ? { commandAllowlist } : {}),
      ...(captureBrowser !== undefined ? { captureBrowser: captureBrowser ?? undefined } : {}),
    });
    const { token: _token, ...safe } = updated;
    sendJson(res, 200, safe);
  });
}
