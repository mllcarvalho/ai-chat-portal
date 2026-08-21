import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { readRuntime } from '../../authToken';
import { getConfig } from '../../storage/configStore';
import { portalMcpServerPath } from '../../extensionContext';
import { portalToolsFetchedAt } from '../portalMcpPing';
import { findBin } from '../../tools/findBin';
import { MAX_MODEL_TOOLS, getEnabledToolDefs } from '../../tools/toolRegistry';
import type { TurnContext } from './types';

/**
 * Configuração do servidor MCP do portal para uma conversa.
 *
 * É o que faz o BMAD funcionar fora do Copilot: as CLIs agênticas sobem este
 * processo e passam a enxergar `bmad_read_file`, `portal_write_file`,
 * `portal_run_command` etc. com os mesmos nomes que o adaptador das personas
 * usa — sem precisar reescrever os assets do BMAD por motor.
 */

export interface PortalMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * undefined quando não dá para montar (extensão não ativada, servidor ainda
 * sem porta, ou bundle ausente num build parcial). O chamador segue sem as
 * ferramentas do portal em vez de derrubar a conversa.
 */
export interface PortalMcpOptions {
  /** `subagent` publica só as ferramentas de leitura. */
  scope?: 'subagent';
  /**
   * Node "de verdade" a usar como `command` no lugar do Electron do VS Code.
   * Ver `plainNodeBin()` — quem passa isto é o Devin.
   */
  nodeBin?: string;
}

export function portalMcpServer(
  sessionId: string,
  opts: PortalMcpOptions = {},
): PortalMcpServer | undefined {
  const { scope, nodeBin } = opts;
  const serverPath = portalMcpServerPath();
  if (!serverPath || !fs.existsSync(serverPath)) return undefined;
  const runtime = readRuntime();
  if (!runtime?.port) return undefined;
  const token = getConfig().token;
  if (!token) return undefined;
  return {
    // o mesmo node que roda a extensão: evita depender do PATH do usuário
    command: nodeBin ?? process.execPath,
    args: [serverPath],
    env: {
      /**
       * OBRIGATÓRIO — e não é detalhe: `process.execPath` aqui é o binário do
       * Electron do VS Code, que só executa um .js quando esta variável está
       * setada. Sem ela o processo abre o editor (ou não faz nada) e MORRE em
       * silêncio, sem falar JSON-RPC: o cliente conclui que o servidor não
       * existe e o agente fica com a lista de MCP VAZIA.
       *
       * O host da extensão já roda com ela, então quem herda o ambiente do
       * portal (Claude Code, que faz merge com o process.env dele) funcionava
       * por acidente. O Devin recebe o `env` do ACP como ambiente COMPLETO do
       * filho — nada é herdado —, então a variável precisa vir declarada.
       */
      ELECTRON_RUN_AS_NODE: '1',
      // idem: num ambiente substituído, o filho ficaria sem PATH/HOME
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      PORTAL_URL: `http://127.0.0.1:${runtime.port}`,
      PORTAL_TOKEN: token,
      PORTAL_SESSION_ID: sessionId,
      ...(scope ? { PORTAL_TOOL_SCOPE: scope } : {}),
    },
  };
}

/**
 * Um `node` de verdade na máquina, para usar como `command` no lugar do
 * Electron do VS Code.
 *
 * Motivo: `process.execPath` no host da extensão é
 * `.../Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)` (ou
 * `...\Microsoft VS Code\Code.exe` no Windows) — caminho com ESPAÇOS e
 * parênteses. Quem spawna com execve não se importa; quem monta uma linha de
 * comando e deixa o shell separar por espaço tenta executar `/Applications/Visual`
 * e falha. O Claude Code spawna direto e funciona; o Devin, não — e o sintoma é
 * indistinguível de servidor inexistente ("Server `portal` not found in
 * configuration").
 *
 * Exige Node >= 18: o servidor MCP do portal usa `fetch` global. Um node antigo
 * trocaria uma falha silenciosa por outra, então nesse caso preferimos o
 * Electron, que é a versão que a extensão já roda.
 */
const NODE_TTL_MS = 60_000;
let nodeBinCache: { at: number; value: string | undefined } | undefined;

export async function plainNodeBin(): Promise<string | undefined> {
  if (nodeBinCache && Date.now() - nodeBinCache.at < NODE_TTL_MS) return nodeBinCache.value;
  const bin = await findBin('node');
  const value = bin && (await nodeMajor(bin)) >= 18 ? bin : undefined;
  nodeBinCache = { at: Date.now(), value };
  return value;
}

function nodeMajor(bin: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(bin, ['-p', 'process.versions.node'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? 0 : Number.parseInt(stdout.trim().split('.')[0] ?? '', 10) || 0);
    });
  });
}

/**
 * Últimas linhas do stderr da CLI, preferindo as que falam de MCP — é onde o
 * motivo real aparece ("failed to start server portal: ...", "no such file").
 * Sem isto o aviso diria QUE falhou sem dizer POR QUÊ, e a única forma de
 * descobrir seria abrir o log da CLI na mão.
 */
export function mcpStderrHint(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const aboutMcp = lines.filter((l) => /mcp|portal/i.test(l));
  const picked = (aboutMcp.length ? aboutMcp : lines).slice(-3);
  return picked.length ? `Últimas mensagens da CLI:\n${picked.join('\n')}` : '';
}

/**
 * Vigia se o servidor MCP do portal chegou a subir NESTE turno; devolve o que
 * chamar no fim dele.
 *
 * A CLI é quem spawna o processo, então uma falha de spawn morre no log dela e
 * o portal não fica sabendo — o usuário só vê o agente dizendo que não tem
 * acesso a nada, exatamente como se as ferramentas não existissem. O catálogo
 * é obrigatório antes de qualquer chamada de ferramenta, então "não pediu o
 * catálogo" é prova de que a resposta saiu sem as ferramentas do portal.
 */
export function watchPortalMcp(ctx: TurnContext, detail?: () => string): () => void {
  if (!portalMcpServer(ctx.session.id)) return () => undefined;
  const before = portalToolsFetchedAt(ctx.session.id) ?? 0;
  return () => {
    if ((portalToolsFetchedAt(ctx.session.id) ?? 0) > before) return;
    const why = detail?.().trim();
    ctx.sse.send('notice', {
      message:
        'O servidor MCP do portal não subiu nesta resposta — o agente respondeu sem as ' +
        'ferramentas do portal (BMAD, arquivos, comandos e os servidores MCP cadastrados).' +
        (why ? `\n\n${why}` : ''),
    });
  };
}

/**
 * Avisa que um servidor MCP ficou de fora do catálogo publicado para a CLI.
 *
 * O catálogo do servidor MCP do portal é o mesmo do Copilot (getEnabledToolDefs),
 * teto de 128 ferramentas incluído — servidor que não cabe inteiro é descartado.
 * O Copilot já avisa quando isso acontece; aqui não avisava ninguém, e o efeito
 * era o pior possível: o agente simplesmente não enxergava o MCP e respondia que
 * "não tem acesso", sem nada indicando que faltou espaço no catálogo.
 *
 * Só faz sentido quando o servidor MCP do portal está de pé: sem ele a CLI não
 * recebe ferramenta nenhuma do portal, e culpar o teto seria mentira.
 */
export function warnDroppedMcpServers(ctx: TurnContext): void {
  if (!portalMcpServer(ctx.session.id)) return;
  const { droppedServers } = getEnabledToolDefs(ctx.session, ctx.agent);
  if (!droppedServers.length) return;
  ctx.sse.send('notice', {
    message:
      `O portal publica no máximo ${MAX_MODEL_TOOLS} ferramentas por conversa — ` +
      `os MCPs ${droppedServers.join(', ')} ficaram de fora desta resposta. ` +
      `Desligue outros servidores MCP na página de MCPs para usá-los.`,
  });
}
