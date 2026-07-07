import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildPortalUrl, clearRuntime, readRuntime, writeRuntime } from './authToken';
import { startServer } from './server/httpServer';
import { buildRouter } from './server/routes/index';
import { registerBmadAssets, startBmadInstall } from './storage/bmadStore';
import { loadConfig } from './storage/configStore';
import { setSecretStore } from './storage/mcpProxyStore';
import { getPortalRoot, initPortalRoot, isBmadInstalled } from './storage/paths';
import { seedDefaultSkills } from './storage/skillStore';
import { checkEnvironment } from './tools/envCheck';
import { autoStartEnabled, stopAll } from './tools/mcpManager';
import { prepareUvOnStartup } from './tools/consumerLabSetup';
import { resolveShellEnv } from './tools/netEnv';
import { withTimeout } from './util';

/**
 * Localiza, entre as pastas abertas no workspace, a raiz do repositório do
 * portal (package.json com name "ai-chat-portal"). É dela que vêm os MCPs
 * (.vscode/mcp.json) e onde os dados da UI são gravados (portal-data/).
 */
function findPortalRoot(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(folder.uri.fsPath, 'package.json'), 'utf8'),
      ) as { name?: string };
      if (pkg.name === 'ai-chat-portal') return folder.uri.fsPath;
    } catch {
      // pasta sem package.json
    }
  }
  return undefined;
}

let portalUrl: string | undefined;

/**
 * Identifica o build carregado nesta janela (mtime do bundle instalado).
 * Janelas comparam buildIds via /api/health: a de build mais novo assume o
 * portal e pede o shutdown das demais, mesmo sem bump de versão.
 */
function computeBuildId(context: vscode.ExtensionContext): number {
  try {
    const main = (context.extension.packageJSON as { main?: string }).main ?? 'dist/extension.js';
    return Math.round(fs.statSync(path.join(context.extensionPath, main)).mtimeMs);
  } catch {
    return 0;
  }
}

/** URL canônica do portal: o runtime.json é escrito por quem está servindo agora. */
function canonicalPortalUrl(): string | undefined {
  return readRuntime()?.portalUrl ?? portalUrl;
}

async function doWarmup(context: vscode.ExtensionContext): Promise<void> {
  const models = await withTimeout(
    vscode.lm.selectChatModels({ vendor: 'copilot' }),
    10000,
    [] as readonly vscode.LanguageModelChat[],
  );
  if (!models.length) {
    void vscode.window.showWarningMessage(
      'AI Product BMAD Chat: nenhum modelo do Copilot disponível. Verifique se o GitHub Copilot Chat está instalado e logado.',
    );
    return;
  }
  try {
    // requisição mínima só para disparar o diálogo de consentimento do VS Code
    const response = await models[0].sendRequest(
      [vscode.LanguageModelChatMessage.User('Responda apenas: ok')],
      { justification: 'Autorizar o AI Product BMAD Chat a usar o Copilot' },
    );
    for await (const _ of response.text) {
      break;
    }
    await context.globalState.update('warmupDone', true);
    void vscode.window.showInformationMessage(
      'AI Product BMAD Chat autorizado a usar o Copilot. Pode voltar para o navegador.',
    );
  } catch (err) {
    if (err instanceof vscode.LanguageModelError && err.code === 'NoPermissions') {
      void vscode.window.showWarningMessage(
        'AI Product BMAD Chat: permissão negada para usar o Copilot.',
      );
    } else {
      throw err;
    }
  }
}

function maybeOfferWarmup(context: vscode.ExtensionContext): void {
  if (context.globalState.get('warmupDone')) return;
  const offer = async () => {
    const models = await withTimeout(
      vscode.lm.selectChatModels({ vendor: 'copilot' }),
      10000,
      [] as readonly vscode.LanguageModelChat[],
    );
    if (!models.length) return false;
    if (models.some((m) => context.languageModelAccessInformation.canSendRequest(m) === true)) {
      await context.globalState.update('warmupDone', true);
      return true;
    }
    const choice = await vscode.window.showInformationMessage(
      'O AI Product BMAD Chat precisa da sua autorização para usar os modelos do Copilot.',
      'Autorizar',
    );
    if (choice === 'Autorizar') await doWarmup(context);
    return true;
  };
  void offer().then((hadModels) => {
    if (!hadModels) {
      // modelos podem demorar a aparecer após o startup
      const listener = vscode.lm.onDidChangeChatModels(() => {
        listener.dispose();
        void offer();
      });
      context.subscriptions.push(listener);
    }
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initPortalRoot(findPortalRoot());
  let skillCreatorMd: string | undefined;
  try {
    skillCreatorMd = fs.readFileSync(
      path.join(context.extensionPath, 'assets', 'skill-creator', 'SKILL.md'),
      'utf8',
    );
  } catch {
    // VSIX sem o asset: segue sem o comando /criar-skill
  }
  seedDefaultSkills(skillCreatorMd);
  // detecta node/bash/python e SÓ ENTÃO registra o BMAD: o adaptador das
  // skills depende do ambiente (rodar comandos vs fallback manual)
  void checkEnvironment().then((env) => {
    if (!env.node) {
      void vscode.window.showWarningMessage(
        'AI Product BMAD Chat: Node.js não foi encontrado no PATH. A instalação do BMAD (npx) e servidores MCP stdio não vão funcionar.',
      );
    }
    try {
      if (isBmadInstalled()) registerBmadAssets();
    } catch {
      // melhor-esforço; o painel BMAD re-registra na primeira consulta
    }
  });
  const config = loadConfig();
  const version = (context.extension.packageJSON as { version: string }).version;

  // SecretStorage do VS Code guarda os client_secret dos proxies MCP (cifrado em repouso)
  setSecretStore(context.secrets);
  context.subscriptions.push({ dispose: () => void stopAll() });

  const buildId = computeBuildId(context);
  // chamado pela rota /api/shutdown quando outra janela assume o portal
  const shutdownRef = { close: () => {} };
  const router = buildRouter({
    context,
    version,
    buildId,
    requestShutdown: () => shutdownRef.close(),
  });
  const mediaDir = path.join(context.extensionPath, 'media');

  let serving = false;
  const tryBecomeServer = async (): Promise<void> => {
    if (serving) return;
    serving = true;
    const result = await startServer(router, {
      config,
      version,
      buildId,
      hasPortalRoot: !!getPortalRoot(),
      mediaDir,
    });
    if (!result) {
      serving = false;
      return;
    }
    portalUrl = buildPortalUrl(result.port, config.token);
    writeRuntime(result.port, config.token, version);
    // MCPs sobem SÓ na janela que serve o portal: cada janela subindo os
    // próprios stdio duplicava todos os processos. Antes de religar, importa
    // proxy/CA do shell de login (o host da extensão via GUI não herda).
    void resolveShellEnv().finally(() => {
      void autoStartEnabled();
      // deixa o uv pronto e no PATH permanente (transparente; ConsumerLab precisa dele)
      void prepareUvOnStartup();
    });
    shutdownRef.close = () => {
      shutdownRef.close = () => {};
      result.server.closeAllConnections();
      result.server.close();
      clearRuntime();
      portalUrl = undefined;
      serving = false;
      // esta janela cedeu o portal: os MCPs dela não servem mais ninguém
      void stopAll();
    };
  };

  await tryBecomeServer();
  // BMAD embutido: instala sozinho na primeira vez, sem clique. Só a janela
  // que está servindo o portal instala (duas janelas rodando npx na mesma
  // pasta ao mesmo tempo corromperiam a instalação global).
  if (serving && !isBmadInstalled()) {
    void checkEnvironment().then((env) => {
      if (env.node) startBmadInstall();
    });
  }
  // janelas que cederam ficam de prontidão: se o portal canônico sumir
  // (janela fechada/recarregada), a primeira que notar assume
  const watchdog = setInterval(() => void tryBecomeServer(), 30000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(watchdog);
      shutdownRef.close();
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('aiChatPortal.openInBrowser', () => {
      const url = canonicalPortalUrl();
      if (url) {
        void vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        void vscode.window.showWarningMessage(
          'AI Product BMAD Chat: nenhum servidor ativo no momento.',
        );
      }
    }),
    vscode.commands.registerCommand('aiChatPortal.copyUrl', async () => {
      const url = canonicalPortalUrl();
      if (url) {
        await vscode.env.clipboard.writeText(url);
        void vscode.window.showInformationMessage('URL do portal copiada.');
      } else {
        void vscode.window.showWarningMessage(
          'AI Product BMAD Chat: nenhum servidor ativo no momento.',
        );
      }
    }),
    vscode.commands.registerCommand('aiChatPortal.warmup', () => doWarmup(context)),
  );

  maybeOfferWarmup(context);
}

export function deactivate(): Promise<void> {
  clearRuntime();
  // aguardado pelo VS Code: dá tempo de matar os processos MCP filhos
  // (o dispose síncrono das subscriptions não espera o close de cada um)
  return stopAll();
}
