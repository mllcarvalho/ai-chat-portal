#!/usr/bin/env node
/**
 * Descobre COMO o `devin acp` aceita um servidor MCP no session/new.
 *
 * O portal manda hoje o formato stdio do ACP ({name, command, args, env}) e o
 * Devin responde "Server portal not found in configuration" — como se
 * estivesse procurando um servidor já cadastrado em vez de aceitar a
 * definição. Em vez de tentar uma quarta forma no escuro, esta sonda testa as
 * variantes plausíveis e diz qual conecta.
 *
 * Rode na máquina que tem o devin:
 *
 *   node scripts/probe-devin-mcp.mjs
 *
 * Grava devin-mcp-probe.json e imprime um resumo. É esse resumo que preciso.
 *
 * Sem dependências além do Node — dá para copiar só este arquivo.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKDIR = join(tmpdir(), 'devin-mcp-probe');
mkdirSync(WORKDIR, { recursive: true });

/** Servidor MCP mínimo, em linha, que publica UMA ferramenta reconhecível. */
const SERVER_SRC = `
const send=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
let buf='';
process.stdin.on('data',(d)=>{buf+=d;let i;
  while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);
    if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}
    if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',
      capabilities:{tools:{}},serverInfo:{name:'sonda',version:'1.0'}}});
    else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[
      {name:'sonda_ping',description:'Ferramenta da sonda.',inputSchema:{type:'object',properties:{}}}]}});
    else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'pong'}]}});
    else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{}});
  }});
`;
const serverPath = join(WORKDIR, 'sonda-mcp.cjs');
writeFileSync(serverPath, SERVER_SRC);

/** As formas plausíveis de declarar o servidor no session/new. */
const VARIANTS = [
  {
    id: 'acp-stdio (o que o portal manda hoje)',
    value: {
      name: 'sonda',
      command: process.execPath,
      args: [serverPath],
      env: [{ name: 'X', value: '1' }],
    },
  },
  {
    id: 'acp-stdio + type',
    value: {
      type: 'stdio',
      name: 'sonda',
      command: process.execPath,
      args: [serverPath],
      env: [{ name: 'X', value: '1' }],
    },
  },
  {
    id: 'env como objeto',
    value: {
      name: 'sonda',
      command: process.execPath,
      args: [serverPath],
      env: { X: '1' },
    },
  },
  {
    id: 'sem env',
    value: { name: 'sonda', command: process.execPath, args: [serverPath] },
  },
];

function runVariant(variant) {
  return new Promise((resolve) => {
    const child = spawn('devin', ['acp'], { cwd: WORKDIR, env: process.env });
    const log = [];
    let buf = '';
    let id = 0;
    const pending = new Map();
    const send = (method, params) => {
      const msgId = ++id;
      const msg = { jsonrpc: '2.0', id: msgId, method, params };
      log.push({ dir: 'out', msg });
      child.stdin.write(`${JSON.stringify(msg)}\n`);
      return new Promise((r) => pending.set(msgId, r));
    };
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        log.push({ dir: 'in', msg: m });
        if (m.id !== undefined && !m.method) {
          pending.get(m.id)?.(m);
          pending.delete(m.id);
        } else if (m.id !== undefined) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} })}\n`);
        }
      }
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const done = (verdict, detail) => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* já morreu */
      }
      resolve({ variant: variant.id, verdict, detail, stderr: stderr.slice(-800), log });
    };
    child.on('error', (e) => done('erro-ao-executar', e.message));
    const timer = setTimeout(() => done('timeout', 'sem resposta em 45s'), 45_000);

    (async () => {
      await send('initialize', { protocolVersion: 1, clientCapabilities: { fs: {} } });
      const created = await send('session/new', { cwd: WORKDIR, mcpServers: [variant.value] });
      clearTimeout(timer);
      if (created?.error) {
        return done('REJEITADO', created.error.message ?? JSON.stringify(created.error));
      }
      const sid = created?.result?.sessionId;
      if (!sid) return done('sem-sessionId', JSON.stringify(created?.result ?? {}).slice(0, 200));
      // pergunta ao agente se ele enxerga a ferramenta da sonda
      const ans = await send('session/prompt', {
        sessionId: sid,
        prompt: [
          {
            type: 'text',
            text: 'Você tem uma ferramenta chamada sonda_ping (pode estar com prefixo)? Responda apenas SIM ou NAO.',
          },
        ],
      });
      const texts = log
        .filter((e) => e.dir === 'in' && e.msg.method === 'session/update')
        .map((e) => e.msg.params?.update)
        .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
        .map((u) => (typeof u.content === 'string' ? u.content : (u.content?.text ?? '')))
        .join('');
      done(
        /sim/i.test(texts) ? 'ACEITO (agente enxergou a ferramenta)' : 'conectou mas sem a ferramenta',
        `resposta: ${texts.trim().slice(0, 80)} | stopReason: ${ans?.result?.stopReason ?? '?'}`,
      );
    })().catch((e) => done('exceção', String(e)));
  });
}

const results = [];
for (const v of VARIANTS) {
  process.stdout.write(`\n▸ testando: ${v.id}\n`);
  const r = await runVariant(v);
  results.push(r);
  const cor = r.verdict.startsWith('ACEITO') ? '\x1b[32m' : '\x1b[33m';
  console.log(`  ${cor}${r.verdict}\x1b[0m — ${r.detail ?? ''}`);
  if (r.stderr.trim()) console.log(`  stderr: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);
}

const out = join(process.cwd(), 'devin-mcp-probe.json');
writeFileSync(out, JSON.stringify({ results }, null, 2));
console.log(`\n\x1b[32m✓ detalhes em ${out}\x1b[0m`);
console.log('  Me mande o resumo acima (ou o arquivo).');
process.exit(0);
