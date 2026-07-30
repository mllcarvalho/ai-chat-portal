import { spawn } from 'node:child_process';
import type { ChatErrorCode, ModelInfo, ProviderInfo } from '@aiportal/shared';
import { netProcessEnv } from '../../tools/netEnv';
import type { ChatProvider, TurnContext, TurnResult } from './types';

/**
 * Devin ainda não responde conversas — este provider existe só para detectar
 * a CLI na máquina e dizer ao usuário em que pé está.
 *
 * Por que ainda não dá para reaproveitar o desenho do Claude Code: o `devin`
 * NÃO tem `--output-format stream-json`. O `devin -p` devolve texto puro, sem
 * eventos, então não há o que traduzir para tool_call/tool_result.
 *
 * O caminho é o subcomando `devin acp`, que roda a CLI como servidor do Agent
 * Client Protocol (JSON-RPC sobre stdio). Esse protocolo mapeia melhor no
 * portal do que o próprio stream-json — inclusive `session/request_permission`,
 * que ligaria a UI de aprovação que o Claude Code não usa. Falta capturar o
 * tráfego real numa máquina com a CLI: ver scripts/probe-devin-acp.mjs.
 */

const BIN = 'devin';

/** `-V/--version` e o subcomando `version` existem; `--help` fica de reserva. */
const PROBES = [['--version'], ['version'], ['--help']];

function probe(args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(BIN, args, { env: { ...process.env, ...netProcessEnv() } });
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 8000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split('\n')[0]?.trim() || 'instalada' : undefined);
    });
  });
}

async function detect(): Promise<string | undefined> {
  for (const args of PROBES) {
    const found = await probe(args);
    if (found) return found;
  }
  return undefined;
}

const CAPABILITIES = {
  skills: false,
  knowledge: false,
  mcp: false,
  toolToggles: false,
  agents: false,
  modes: false,
  contextFiles: false,
  cost: false,
} as const;

async function runTurn(_ctx: TurnContext): Promise<TurnResult> {
  throw new Error(
    'A integração com o Devin ainda não está implementada — falta capturar o tráfego do ' +
      '`devin acp` (rode scripts/probe-devin-acp.mjs numa máquina com a CLI).',
  );
}

function mapError(err: unknown): { code: ChatErrorCode; message: string } {
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

export const devinProvider: ChatProvider = {
  id: 'devin',
  runTurn,
  mapError,
  async listModels(): Promise<ModelInfo[]> {
    return [];
  },
  async describe(): Promise<ProviderInfo> {
    const version = await detect();
    return {
      id: 'devin',
      label: 'Devin',
      // detectado ≠ utilizável: sem o tradutor de eventos ele não responde
      available: false,
      detail: version
        ? `CLI encontrada (${version}), mas a integração ainda não está implementada.`
        : 'CLI não encontrada. Instale o Devin e confirme que `devin` responde no terminal.',
      capabilities: { ...CAPABILITIES },
    };
  },
};
