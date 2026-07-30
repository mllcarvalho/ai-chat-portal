/**
 * Servidor MCP do portal — processo separado, spawnado pelas CLIs agênticas
 * (Claude Code via --mcp-config, Devin via mcpServers do ACP).
 *
 * Existe para uma coisa: dar a essas CLIs as MESMAS ferramentas do loop do
 * Copilot, com os mesmos nomes. O adaptador do BMAD instrui as personas a
 * chamar `bmad_read_file`, `portal_write_file`, `portal_run_command` pelo
 * nome — expor as ferramentas mantém UM dialeto de BMAD em vez de três.
 *
 * Não implementa nada: proxia para a API local do portal
 * (routes/portalTools), que resolve a pasta de trabalho pela sessão e aplica
 * aprovação e checkpoints exatamente como no Copilot.
 *
 * Configuração vem toda por env, porque é assim que as duas CLIs passam
 * parâmetros para um servidor MCP stdio:
 *   PORTAL_URL         base do servidor local (ex.: http://127.0.0.1:4719)
 *   PORTAL_TOKEN       token de acesso à API
 *   PORTAL_SESSION_ID  conversa a que estas ferramentas pertencem
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PORTAL_URL = process.env.PORTAL_URL ?? '';
const PORTAL_TOKEN = process.env.PORTAL_TOKEN ?? '';
const SESSION_ID = process.env.PORTAL_SESSION_ID ?? '';
/**
 * `subagent` publica só as ferramentas de leitura — é o que um subagente do
 * party mode enxerga, igual ao subagente do Copilot.
 */
const SCOPE = process.env.PORTAL_TOOL_SCOPE ?? '';
/** Mesmo header que o resto da API do portal exige. */
const TOKEN_HEADER = 'X-Portal-Token';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

async function portalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PORTAL_URL}${path}`, {
    ...init,
    headers: {
      [TOKEN_HEADER]: PORTAL_TOKEN,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* resposta sem corpo JSON */
    }
    throw new Error(`Portal: ${detail}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  if (!PORTAL_URL || !PORTAL_TOKEN || !SESSION_ID) {
    // stderr, nunca stdout: stdout é o canal do protocolo
    process.stderr.write(
      'portal-mcp: PORTAL_URL, PORTAL_TOKEN e PORTAL_SESSION_ID são obrigatórios.\n',
    );
    process.exit(1);
  }

  const server = new Server(
    { name: 'portal', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // buscado a cada listagem: o liga/desliga de ferramentas da conversa pode
    // ter mudado desde que o processo subiu
    const tools = await portalFetch<ToolDef[]>(
      `/api/portal-tools?sessionId=${encodeURIComponent(SESSION_ID)}` +
        (SCOPE ? `&scope=${encodeURIComponent(SCOPE)}` : ''),
    );
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const outcome = await portalFetch<{ ok: boolean; content: string }>(
        '/api/portal-tools/call',
        {
          method: 'POST',
          body: JSON.stringify({
            sessionId: SESSION_ID,
            name,
            input: args ?? {},
            ...(SCOPE ? { scope: SCOPE } : {}),
          }),
        },
      );
      return {
        content: [{ type: 'text' as const, text: outcome.content }],
        isError: !outcome.ok,
      };
    } catch (err) {
      // erro de transporte vira resultado de ferramenta, não exceção do
      // protocolo: o agente consegue ler a mensagem e se adaptar
      return {
        content: [
          { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
        ],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`portal-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
