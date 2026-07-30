#!/usr/bin/env node
/**
 * Sonda o `devin acp` para descobrir o formato real do tráfego antes de
 * escrever o provider. Mesmo método usado para o Claude Code: em vez de
 * implementar contra a especificação e descobrir as diferenças em produção,
 * captura o que a CLI realmente fala.
 *
 * Rode na máquina que tem o devin instalado:
 *
 *   node scripts/probe-devin-acp.mjs                      # usa /tmp/devin-probe
 *   node scripts/probe-devin-acp.mjs "liste os arquivos"  # prompt próprio
 *
 * Ao final grava devin-acp-trace.json na pasta atual — é esse arquivo que
 * preciso para escrever o provider.
 *
 * Não depende de nada além do Node: dá para copiar só este arquivo.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROMPT = process.argv[2] ?? 'Diga apenas: ok';
const WORKDIR = process.argv[3] ?? join(tmpdir(), 'devin-probe');
const TIMEOUT_MS = 120_000;

mkdirSync(WORKDIR, { recursive: true });

/** Tudo que trafega, nos dois sentidos, na ordem em que aconteceu. */
const trace = [];
const record = (dir, data) => {
  trace.push({ t: Date.now(), dir, data });
  const label = dir === 'out' ? '\x1b[36m→\x1b[0m' : '\x1b[32m←\x1b[0m';
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  console.log(`${label} ${s.slice(0, 400)}${s.length > 400 ? ' …' : ''}`);
};

console.log(`▸ devin acp  (cwd: ${WORKDIR})`);
const child = spawn('devin', ['acp'], { cwd: WORKDIR, env: process.env });

let rawStdout = '';
let rawStderr = '';

child.on('error', (err) => {
  console.error(`\n\x1b[31m✗ não consegui executar "devin": ${err.message}\x1b[0m`);
  console.error('  Confirme que `devin --version` responde neste terminal.');
  process.exit(1);
});

child.stderr.on('data', (d) => {
  rawStderr += d.toString();
});

/**
 * O framing não está documentado de forma conclusiva: pode ser JSON por linha
 * (ndjson) ou cabeçalhos Content-Length no estilo LSP. A sonda aceita os dois
 * e registra qual apareceu — é uma das respostas que precisamos.
 */
let buffer = '';
let framing = 'desconhecido';

child.stdout.on('data', (chunk) => {
  rawStdout += chunk.toString();
  buffer += chunk.toString();
  for (;;) {
    if (buffer.startsWith('Content-Length:')) {
      framing = 'content-length';
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(buffer)?.[1] ?? 0);
      const start = headerEnd + 4;
      if (buffer.length < start + len) return;
      dispatch(buffer.slice(start, start + len));
      buffer = buffer.slice(start + len);
      continue;
    }
    const nl = buffer.indexOf('\n');
    if (nl < 0) return;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    if (line.startsWith('{') && framing === 'desconhecido') framing = 'ndjson';
    dispatch(line);
  }
});

let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  record('out', msg);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function dispatch(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    record('in-raw', text);
    return;
  }
  record('in', msg);

  // resposta a algo que pedimos
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }
  // o agente está pedindo algo de VOLTA (permissão, leitura de arquivo…):
  // aprova tudo, já que o objetivo é ver o formato da conversa inteira
  if (msg.id !== undefined && msg.method) {
    const reply = { jsonrpc: '2.0', id: msg.id, result: autoReply(msg) };
    record('out', reply);
    child.stdin.write(`${JSON.stringify(reply)}\n`);
  }
}

/** Aprovação automática — o formato exato da resposta é parte do que queremos descobrir. */
function autoReply(msg) {
  if (msg.method === 'session/request_permission') {
    const opts = msg.params?.options ?? [];
    const allow =
      opts.find((o) => /allow/i.test(o.optionId ?? o.kind ?? '')) ?? opts[0];
    return { outcome: { outcome: 'selected', optionId: allow?.optionId } };
  }
  return {};
}

const finish = (motivo) => {
  const out = join(process.cwd(), 'devin-acp-trace.json');
  writeFileSync(
    out,
    JSON.stringify({ motivo, framing, prompt: PROMPT, trace, rawStdout, rawStderr }, null, 2),
  );
  console.log(`\n▸ framing detectado: \x1b[1m${framing}\x1b[0m`);
  console.log(`▸ ${trace.length} mensagens registradas`);
  console.log(`\x1b[32m✓ trace salvo em ${out}\x1b[0m`);
  console.log('  Me mande esse arquivo (ou o conteúdo dele).');
  try {
    child.kill('SIGTERM');
  } catch {
    /* já morreu */
  }
  process.exit(0);
};

setTimeout(() => finish('timeout'), TIMEOUT_MS);
child.on('close', (code) => finish(`processo encerrou com código ${code}`));

(async () => {
  // 1. handshake
  await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });

  // 2. cria a conversa
  const session = await send('session/new', { cwd: WORKDIR, mcpServers: [] });
  const sessionId =
    session?.result?.sessionId ?? session?.result?.session_id ?? session?.result?.id;
  console.log(`\n▸ sessionId: ${sessionId ?? '(não encontrei no result — ver trace)'}\n`);

  // 3. manda o prompt e deixa o stream correr
  await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: PROMPT }],
  });

  // dá um respiro para notificações atrasadas antes de fechar
  setTimeout(() => finish('prompt concluído'), 3000);
})().catch((err) => {
  record('erro', String(err));
  finish(`exceção: ${err.message}`);
});
