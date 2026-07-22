import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionMode } from '@aiportal/shared';
import { PROJECT_META_DIR, bmadRootDir } from '../storage/paths';
import { linkedRealTargets } from '../storage/linkStore';
import { createCheckpoint, type CheckpointOperation } from '../storage/checkpointStore';
import { createAgent } from '../storage/agentStore';
import {
  createBase,
  fetchSourceContent,
  listBases,
  readKnowledgeDoc,
  searchKnowledge,
  writeDoc,
} from '../storage/knowledgeStore';
import { createSkill, getSkill, listSkills, readSkillAsset } from '../storage/skillStore';
import { normalizeSourceUrl } from '../storage/remoteFetch';
import { backgroundOutput } from './runCommand';
import { searchWeb } from './webSearch';

export const READ_LIMIT = 256 * 1024;
export const WRITE_LIMIT = 2 * 1024 * 1024;
/**
 * Teto de segurança do portal_edit_file: acima disso a edição é recusada.
 * A edição lê o arquivo INTEIRO (nunca o clamp de leitura — gravar um
 * conteúdo truncado de volta destruiria o resto do arquivo).
 */
export const EDIT_LIMIT = 10 * 1024 * 1024;
export const LIST_LIMIT = 500;

export interface BuiltinToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  {
    name: 'portal_write_file',
    description:
      'Cria ou sobrescreve um arquivo de TEXTO na pasta de trabalho da conversa ' +
      '(a pasta do projeto, ou o workspace próprio da conversa quando ela não está em um projeto). ' +
      'Use caminhos relativos à raiz da pasta de trabalho. IMPORTANTE — arquivo longo (mais de ' +
      '~150 linhas): grave em BLOCOS, nunca de uma vez — primeira chamada cria o início, as ' +
      'seguintes continuam com append: true; blocos menores aparecem mais rápido e evitam timeout. ' +
      'Para ALTERAR arquivo existente, use portal_edit_file (nunca reescreva o arquivo inteiro). ' +
      'NUNCA use para formatos binários (.pptx, .xlsx, .docx, .pdf, imagens…) — o arquivo sairia ' +
      'corrompido; gere-os com um script Python em .tmp/ via portal_run_command (python-pptx, ' +
      'openpyxl, python-docx, reportlab). Arquivos em .tmp/ ficam ocultos do usuário — use essa ' +
      'pasta para scripts auxiliares que ele não pediu.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          description: 'Caminho relativo à pasta de trabalho, ex: docs/resumo.md',
        },
        content: { type: 'string', description: 'Conteúdo do arquivo (ou do bloco, com append)' },
        append: {
          type: 'boolean',
          description:
            'Acrescenta o conteúdo ao FIM do arquivo existente em vez de sobrescrever — é como se ' +
            'grava um arquivo longo em blocos (default false)',
        },
        overwrite: {
          type: 'boolean',
          description: 'Se false, falha caso o arquivo já exista (default true; ignorado com append)',
        },
      },
    },
  },
  {
    name: 'portal_read_file',
    description:
      'Lê um arquivo de texto da pasta de trabalho da conversa. Em arquivo grande, leia por ' +
      'FAIXAS com startLine/endLine (a resposta informa o total de linhas) em vez do arquivo ' +
      'inteiro — economiza contexto e permite navegar por partes.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Caminho relativo à pasta de trabalho' },
        startLine: {
          type: 'number',
          description: 'Primeira linha a ler (1-indexada; default: início do arquivo)',
        },
        endLine: {
          type: 'number',
          description: 'Última linha a ler, inclusiva (default: fim do arquivo)',
        },
      },
    },
  },
  {
    name: 'portal_list_files',
    description: 'Lista os arquivos e pastas da pasta de trabalho da conversa.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subpasta a listar (default: raiz da pasta de trabalho)' },
        recursive: { type: 'boolean', description: 'Listar recursivamente (default false)' },
      },
    },
  },
  {
    name: 'portal_run_command',
    description:
      'Executa um comando de shell (sintaxe bash/POSIX) na pasta de trabalho da conversa. ' +
      'O usuário aprova cada comando na interface antes de ele rodar. Não-interativo: nada de ' +
      'comandos que esperam input. A saída (stdout+stderr) volta truncada quando longa. ' +
      'Processo de longa duração (servidor, watch): use background: true e consulte a saída com ' +
      'portal_command_output. Se o comando falhar ou for negado, não repita: siga pela ' +
      'alternativa manual quando existir.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Comando a executar, ex: python3 scripts/gerar.py' },
        timeoutSeconds: {
          type: 'number',
          description: 'Tempo máximo de execução em segundos (default 60, máximo 600)',
        },
        background: {
          type: 'boolean',
          description:
            'Roda em segundo plano e devolve um id na hora — para servidores e processos longos ' +
            '(default false). Consulte/encerre com portal_command_output.',
        },
      },
    },
  },
  {
    name: 'portal_command_output',
    description:
      'Consulta a saída acumulada de um comando iniciado com portal_run_command background: true ' +
      '(informa se ainda está rodando e o exit code quando termina). Com kill: true, encerra o processo.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Id devolvido ao iniciar o comando em background' },
        kill: { type: 'boolean', description: 'Encerrar o processo (default false)' },
      },
    },
  },
  {
    name: 'portal_todo',
    description:
      'Mantém um plano de trabalho visível para o usuário em tarefas com várias etapas (3+ passos ' +
      'ou várias ferramentas). Envie SEMPRE a lista COMPLETA — ela substitui a anterior — com o ' +
      'status de cada item: pending, in_progress (no máximo 1 por vez) ou done. Atualize assim ' +
      'que concluir cada etapa, não acumule. Pule esta ferramenta em pedidos triviais de 1 passo.',
    inputSchema: {
      type: 'object',
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          description: 'A lista completa de etapas, na ordem de execução',
          items: {
            type: 'object',
            required: ['title', 'status'],
            properties: {
              title: { type: 'string', description: 'A etapa, curta e específica' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
          },
        },
      },
    },
  },
  {
    name: 'portal_edit_file',
    description:
      'Edita um arquivo da pasta de trabalho substituindo trechos exatos — prefira esta ' +
      'ferramenta a portal_write_file para mudanças em arquivos existentes (não reescreve o arquivo ' +
      'inteiro). Cada trecho buscado deve ser único no arquivo (inclua linhas vizinhas para desambiguar) ' +
      'e bater exatamente, incluindo espaços e quebras de linha. Para VÁRIAS mudanças no mesmo ' +
      'arquivo, mande todas de uma vez no campo "edits" (aplicadas em ordem, tudo-ou-nada) em vez ' +
      'de uma chamada por mudança.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Caminho relativo à pasta de trabalho' },
        find: { type: 'string', description: 'Trecho exato a localizar (único no arquivo)' },
        replace: { type: 'string', description: 'Texto que substitui o trecho (vazio = remover)' },
        replaceAll: {
          type: 'boolean',
          description: 'Substituir todas as ocorrências em vez de exigir trecho único (default false)',
        },
        edits: {
          type: 'array',
          description:
            'Várias substituições numa chamada só, aplicadas em ordem (alternativa a find/replace). ' +
            'Se qualquer uma falhar, nenhuma é gravada.',
          items: {
            type: 'object',
            required: ['find'],
            properties: {
              find: { type: 'string', description: 'Trecho exato a localizar (único no arquivo)' },
              replace: { type: 'string', description: 'Texto que substitui o trecho (vazio = remover)' },
              replaceAll: {
                type: 'boolean',
                description: 'Substituir todas as ocorrências (default false)',
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'portal_search_files',
    description:
      'Busca um texto (ou expressão regular) dentro dos arquivos da pasta de trabalho e retorna as ' +
      'linhas que casam, no formato arquivo:linha. Use para localizar em qual documento está uma ' +
      'informação antes de ler o arquivo inteiro.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Texto ou regex a procurar' },
        path: { type: 'string', description: 'Subpasta onde buscar (default: raiz da pasta de trabalho)' },
        regex: { type: 'boolean', description: 'Tratar query como expressão regular (default false)' },
        caseSensitive: {
          type: 'boolean',
          description: 'Diferenciar maiúsculas/minúsculas (default false)',
        },
      },
    },
  },
  {
    name: 'portal_delete_file',
    description:
      'Exclui um arquivo (ou uma pasta, com recursive: true) da pasta de trabalho da conversa. ' +
      'A exclusão é definitiva — na dúvida, confirme com o usuário antes.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Caminho relativo à pasta de trabalho' },
        recursive: {
          type: 'boolean',
          description: 'Necessário para excluir pastas com conteúdo (default false)',
        },
      },
    },
  },
  {
    name: 'portal_move_file',
    description:
      'Move ou renomeia um arquivo/pasta dentro da pasta de trabalho da conversa.',
    inputSchema: {
      type: 'object',
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', description: 'Caminho atual, relativo à pasta de trabalho' },
        to: { type: 'string', description: 'Novo caminho, relativo à pasta de trabalho' },
        overwrite: {
          type: 'boolean',
          description: 'Substituir o destino se já existir (default false)',
        },
      },
    },
  },
  {
    name: 'portal_fetch_url',
    description:
      'Lê o conteúdo de uma URL (página HTML, markdown, Word/Excel/PowerPoint/PDF publicado, página ou ' +
      'arquivo de SharePoint) convertido para markdown. Use quando o usuário citar um link ou quando uma ' +
      'informação estiver em uma página conhecida. Conteúdos longos voltam em partes: continue com o ' +
      'offset indicado no fim da resposta.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'URL http(s) a ler' },
        offset: {
          type: 'number',
          description: 'Posição (em caracteres) para continuar a leitura (default 0)',
        },
      },
    },
  },
  {
    name: 'portal_web_search',
    description:
      'Busca na web (DuckDuckGo) e devolve títulos, URLs e trechos dos resultados. Use para descobrir ' +
      'fontes e dados atuais (pesquisas de mercado, docs, notícias); depois leia as páginas relevantes ' +
      'com portal_fetch_url e cite as URLs reais. Na rede corporativa alguns sites são bloqueados: se ' +
      'um fetch falhar, siga para outro resultado em vez de insistir.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Termos de busca (como se digitasse no buscador)' },
        maxResults: {
          type: 'number',
          description: 'Máximo de resultados (default 8, teto 15)',
        },
      },
    },
  },
  {
    name: 'portal_spawn_subagent',
    description:
      'Dispara um subagente: uma instância independente do modelo com persona e tarefa próprias, que ' +
      'trabalha em paralelo e devolve a resposta final. Use para consultar outras personas (ex: party ' +
      'mode do BMAD, revisor independente, comitê de especialistas) ou para delegar uma subtarefa de ' +
      'leitura/análise. Várias chamadas na MESMA rodada rodam em paralelo. O subagente tem apenas ' +
      'ferramentas de leitura (arquivos, BMAD, conhecimento, URLs), não conversa com o usuário e não ' +
      'vê a conversa nem os outros subagentes: dê a ele todo o contexto necessário no campo task — ' +
      'numa discussão entre personas, inclua na task o que as outras já disseram e peça reação, senão ' +
      'as respostas saem duplicadas.',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description:
            'Tarefa completa e autocontida: contexto relevante da conversa + o que o subagente deve produzir',
        },
        label: {
          type: 'string',
          description: 'Nome curto da persona/tarefa para exibição na UI, ex: "PM John" (recomendado)',
        },
        personaPath: {
          type: 'string',
          description:
            'Arquivo de persona (.md) a usar como instruções: caminho na instalação BMAD ' +
            '(ex: _bmad/bmm/agents/pm.md) ou na pasta de trabalho',
        },
        personaAgent: {
          type: 'string',
          description: 'Nome (ou id) de um agente do portal a usar como persona',
        },
        systemPrompt: {
          type: 'string',
          description: 'Instruções de sistema diretas (alternativa a personaPath/personaAgent)',
        },
        modelId: {
          type: 'string',
          description: 'Modelo do subagente (default: o mesmo da conversa)',
        },
      },
    },
  },
  {
    name: 'portal_ask_user',
    description:
      'Faz uma pergunta ao usuário com opções clicáveis e pausa a resposta até ele responder. Use nas ' +
      'elicitações estruturadas (workflows BMAD, decisões de rumo) em vez de terminar a resposta com a ' +
      'pergunta solta no texto. Não use para perguntas retóricas nem quando a resposta já está na conversa.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'A pergunta, curta e direta' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Até 6 opções de resposta (o usuário sempre pode digitar outra coisa)',
        },
      },
    },
  },
  {
    name: 'bmad_read_file',
    description:
      'Lê um arquivo da instalação global do BMAD (workflows, templates, configs — compartilhada por todos os projetos). ' +
      'Caminhos relativos à raiz do BMAD, ex: _bmad/bmm/… ou .agents/skills/bmad-create-prd/SKILL.md. ' +
      'Somente leitura: documentos gerados devem ser gravados com portal_write_file em _bmad-output/ do projeto.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Caminho relativo à raiz da instalação BMAD' },
      },
    },
  },
  {
    name: 'bmad_list_files',
    description:
      'Lista arquivos e pastas da instalação global do BMAD (ex: _bmad/, .agents/skills/).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subpasta a listar (default: raiz do BMAD)' },
        recursive: { type: 'boolean', description: 'Listar recursivamente (default false)' },
      },
    },
  },
  {
    name: 'bmad_write_custom',
    description:
      'Grava um arquivo de override de customização em _bmad/custom/ da instalação global do BMAD ' +
      '(somente .toml, ex: _bmad/custom/bmad-create-prd.user.toml). É a ÚNICA escrita permitida na ' +
      'instalação BMAD — use na skill bmad-customize para persistir customizações, que passam a valer ' +
      'para todas as conversas do portal.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          description: 'Caminho relativo à raiz do BMAD, dentro de _bmad/custom/ e terminando em .toml',
        },
        content: { type: 'string', description: 'Conteúdo TOML completo do arquivo' },
      },
    },
  },
  {
    name: 'portal_load_skill',
    description:
      'Carrega o conteúdo completo de uma skill do catálogo listado nas instruções da conversa. ' +
      'Use ANTES de responder sempre que o pedido do usuário corresponder à descrição de uma skill ' +
      'do catálogo — e então siga as instruções carregadas. ' +
      'Se a skill usar o marcador {{input}}, passe o pedido do usuário no campo input.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: 'Comando da skill como aparece no catálogo (sem a barra), ex: bmad-bmm-prd',
        },
        input: {
          type: 'string',
          description: 'Pedido do usuário, para skills que usam marcador de input (opcional)',
        },
      },
    },
  },
  {
    name: 'portal_read_skill_file',
    description:
      'Lê um arquivo ANEXO da pasta de uma skill do portal (referências, templates, exemplos). ' +
      'Os anexos disponíveis são listados junto do conteúdo da skill (ativa, carregada ou por /comando). ' +
      'Use quando as instruções da skill citarem um desses arquivos.',
    inputSchema: {
      type: 'object',
      required: ['command', 'path'],
      properties: {
        command: {
          type: 'string',
          description: 'Comando da skill dona do arquivo (sem a barra)',
        },
        path: {
          type: 'string',
          description: 'Caminho relativo do anexo, exatamente como listado (ex: references/guia.md)',
        },
      },
    },
  },
  {
    name: 'portal_search_knowledge',
    description:
      'Busca trechos relevantes nas bases de conhecimento habilitadas da conversa (documentação ' +
      'sincronizada de SharePoint/GitHub Pages, docs enviados pelo usuário…). Use SEMPRE que a ' +
      'pergunta puder ser respondida por um documento listado no bloco "Bases de conhecimento" ' +
      'das instruções — não responda de memória sobre esses assuntos. A busca é por ' +
      'palavras-chave: prefira termos específicos do domínio; se não achar, tente sinônimos.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Palavras-chave da busca, ex: "limite transferência aprovação alçada"',
        },
        base: {
          type: 'string',
          description: 'Restringe a uma base pelo nome (opcional; default: todas as habilitadas)',
        },
      },
    },
  },
  {
    name: 'portal_read_knowledge',
    description:
      'Lê um documento inteiro de uma base de conhecimento. Use depois de portal_search_knowledge, ' +
      'quando os trechos retornados não bastarem. Documentos longos voltam em partes: continue com ' +
      'o offset indicado no fim da resposta.',
    inputSchema: {
      type: 'object',
      required: ['base', 'doc'],
      properties: {
        base: { type: 'string', description: 'Nome da base, como aparece nas instruções/busca' },
        doc: { type: 'string', description: 'Nome do documento, ex: politica-de-credito.md' },
        offset: {
          type: 'number',
          description: 'Posição (em caracteres) para continuar a leitura (default 0)',
        },
      },
    },
  },
  {
    name: 'portal_save_knowledge',
    description:
      'Salva um documento em uma base de conhecimento do portal, criando a base pelo nome se ela não existir. ' +
      'As bases aparecem na página Conhecimento e, quando habilitadas, seus documentos são injetados no contexto dos chats. ' +
      'Use quando o usuário pedir para criar/alimentar uma base de conhecimento ou registrar fatos, decisões e ' +
      'referências que devem persistir entre conversas.',
    inputSchema: {
      type: 'object',
      required: ['base', 'content'],
      properties: {
        base: {
          type: 'string',
          description: 'Nome da base de conhecimento, ex: "Padrões do time"',
        },
        scope: {
          type: 'string',
          enum: ['global', 'project'],
          description:
            'Onde criar a base caso não exista: global (default) = vale para todos os chats; ' +
            'project = só nas conversas deste projeto',
        },
        description: {
          type: 'string',
          description: 'Descrição da base (usada apenas quando a base é criada agora)',
        },
        doc: {
          type: 'string',
          description:
            'Nome do arquivo do documento (.md ou .txt). Se omitido, é derivado do nome da base',
        },
        content: { type: 'string', description: 'Conteúdo do documento (markdown)' },
      },
    },
  },
  {
    name: 'portal_create_skill',
    description:
      'Registra uma skill no BMAD Product Studio (aparece no menu Skills e na página Skills). ' +
      'Toda skill funciona das duas formas: injetada no contexto quando ativada E invocável por /comando no chat. ' +
      'Skills são SEMPRE markdown — nunca crie skills como arquivos soltos (.py, .md) com portal_write_file. ' +
      'Boas skills: nome curto e claro; description diz O QUE faz e QUANDO usar (é ela que guia a escolha); ' +
      'conteúdo enxuto, explicando o porquê das regras em vez de listar ordens rígidas.',
    inputSchema: {
      type: 'object',
      required: ['name', 'description', 'content'],
      properties: {
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'project (default) = só neste projeto; global = todos os chats',
        },
        name: { type: 'string', description: 'Nome curto da skill, ex: "Tom executivo"' },
        description: {
          type: 'string',
          description: 'O que a skill faz e quando deve ser usada (1–2 frases)',
        },
        command: {
          type: 'string',
          description:
            'Nome do comando slash sem a barra, ex: "resumir". Se omitido, é derivado do nome.',
        },
        content: {
          type: 'string',
          description:
            'Conteúdo markdown. Use {{input}} onde entra o texto digitado após o /comando (opcional)',
        },
      },
    },
  },
  {
    name: 'portal_create_agent',
    description:
      'Cria um agente (persona reutilizável) no BMAD Product Studio — aparece no seletor de agente do chat ' +
      'e na página Agents. Agentes são globais: as instruções deles entram no contexto de qualquer ' +
      'conversa em que o usuário os selecionar. Use quando o usuário pedir um agente/persona ' +
      'especializado (ex: "agente revisor de contratos"). Boas instruções definem papel, tom, ' +
      'o que fazer e o que NUNCA fazer.',
    inputSchema: {
      type: 'object',
      required: ['name', 'instructions'],
      properties: {
        name: { type: 'string', description: 'Nome curto do agente, ex: "Revisor de contratos"' },
        description: {
          type: 'string',
          description: 'O que o agente faz, em 1 frase (aparece no seletor)',
        },
        icon: { type: 'string', description: 'Um emoji para a UI, ex: "⚖️" (opcional)' },
        instructions: {
          type: 'string',
          description: 'Instruções de sistema do agente (markdown): papel, tom, regras',
        },
        defaultMode: {
          type: 'string',
          enum: ['ask', 'plan', 'agent'],
          description: 'Modo padrão das conversas com este agente (default: mantém o da sessão)',
        },
      },
    },
  },
];

export const BUILTIN_TOOL_NAMES = BUILTIN_TOOLS.map((t) => t.name);
export const READONLY_BUILTIN_TOOL_NAMES = [
  'portal_todo',
  'portal_read_file',
  'portal_list_files',
  'portal_search_files',
  'portal_fetch_url',
  'portal_web_search',
  'portal_load_skill',
  'portal_read_skill_file',
  'portal_search_knowledge',
  'portal_read_knowledge',
  'portal_ask_user',
  'portal_spawn_subagent',
  'bmad_read_file',
  'bmad_list_files',
];
/**
 * Ferramentas oferecidas aos subagentes (portal_spawn_subagent): só leitura,
 * sem spawn (nada de recursão) e sem interação com o usuário.
 */
export const SUBAGENT_TOOL_NAMES = [
  'portal_read_file',
  'portal_list_files',
  'portal_search_files',
  'portal_fetch_url',
  'portal_web_search',
  'portal_read_skill_file',
  'portal_search_knowledge',
  'portal_read_knowledge',
  'bmad_read_file',
  'bmad_list_files',
];
/** Ferramentas da instalação global do BMAD (a escrita é restrita a _bmad/custom/). */
export const BMAD_TOOL_NAMES = ['bmad_read_file', 'bmad_list_files', 'bmad_write_custom'];
/**
 * Ferramentas que SÓ existem em conversas de projeto. As demais valem em
 * qualquer conversa: as de arquivo/comando usam a pasta de trabalho da sessão
 * (projeto ou workspace da conversa avulsa).
 */
export const PROJECT_ONLY_TOOL_NAMES = ['portal_create_skill'];

export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOL_NAMES.includes(name);
}

/**
 * Resolve um caminho relativo dentro da pasta de trabalho (projeto ou
 * workspace da conversa), rejeitando qualquer escape: caminhos absolutos,
 * "..", symlinks que saem da raiz e a pasta de metadados. Exceção: symlinks
 * de pasta referenciada (registrados em .aiportal/links.json) são seguidos —
 * o conteúdo deles vive fora da raiz por definição.
 */
export function resolveInProject(workRoot: string, relPath: string): string {
  const resolved = path.resolve(workRoot, relPath);
  const rel = path.relative(workRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Caminho fora da pasta de trabalho: ${relPath}`);
  }
  if (rel === PROJECT_META_DIR || rel.startsWith(PROJECT_META_DIR + path.sep)) {
    throw new Error(`A pasta ${PROJECT_META_DIR} é reservada ao portal`);
  }
  // valida via realpath o ancestral existente mais profundo (protege contra symlinks)
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    ancestor = path.dirname(ancestor);
  }
  const realRoot = fs.realpathSync(workRoot);
  const realAncestor = fs.realpathSync(ancestor);
  const relReal = path.relative(realRoot, realAncestor);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    const authorized = linkedRealTargets(workRoot).some((target) => {
      const relTarget = path.relative(target, realAncestor);
      return relTarget === '' || (!relTarget.startsWith('..') && !path.isAbsolute(relTarget));
    });
    if (!authorized) {
      throw new Error(`Caminho fora da pasta de trabalho: ${relPath}`);
    }
  }
  return resolved;
}

/** Resolve um caminho dentro da instalação global do BMAD (somente leitura). */
export function resolveInBmad(relPath: string): string {
  const root = bmadRootDir();
  if (!fs.existsSync(root)) {
    throw new Error('BMAD não está instalado. Instale pela tela de um projeto (painel BMAD).');
  }
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Caminho fora da instalação BMAD: ${relPath}`);
  }
  return resolved;
}

export function readFileClamped(file: string, label: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Arquivo não encontrado: ${label}`);
    }
    throw err;
  }
  if (!stat.isFile()) throw new Error(`Não é um arquivo: ${label}`);
  const fd = fs.openSync(file, 'r');
  try {
    const size = Math.min(stat.size, READ_LIMIT);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    let content = buf.toString('utf8');
    if (stat.size > READ_LIMIT) {
      content += `\n… (arquivo truncado em ${READ_LIMIT / 1024} KB)`;
    }
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Diff compacto de uma substituição (- removido / + adicionado), para o card
 * da ferramenta na UI mostrar o que mudou — aproximação do diff do Copilot.
 */
function miniDiff(find: string, replace: string): string {
  const clip = (s: string): string[] => {
    const ls = s.split('\n');
    return ls.length > 8 ? [...ls.slice(0, 8), `… (+${ls.length - 8} linhas)`] : ls;
  };
  const minus = clip(find).map((l) => `- ${l}`);
  const plus = replace ? clip(replace).map((l) => `+ ${l}`) : [];
  return [...minus, ...plus].join('\n');
}

/** Lê o arquivo inteiro para edição (sem clamp), recusando acima de EDIT_LIMIT. */
function readFileForEdit(file: string, label: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Arquivo não encontrado: ${label}`);
    }
    throw err;
  }
  if (!stat.isFile()) throw new Error(`Não é um arquivo: ${label}`);
  if (stat.size > EDIT_LIMIT) {
    throw new Error(
      `Arquivo grande demais para edição: ${label} tem ${(stat.size / 1024 / 1024).toFixed(1)} MB ` +
        `(limite de ${EDIT_LIMIT / 1024 / 1024} MB)`,
    );
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * Snapshot de segurança antes de uma mutação. Falha no checkpoint não bloqueia
 * a ferramenta (melhor executar sem undo do que negar a operação): sem id, o
 * card na UI apenas não oferece "Reverter".
 */
function tryCheckpoint(
  workRoot: string,
  tool: string,
  operation: CheckpointOperation,
  targets: Array<{ absPath: string; relPath: string }>,
): string | undefined {
  try {
    return createCheckpoint(workRoot, tool, operation, targets);
  } catch {
    return undefined;
  }
}

/** Sufixo que a UI (ToolCallCard) parseia para oferecer o botão "Reverter". */
function checkpointNote(id: string | undefined): string {
  return id ? `\n[checkpoint:${id}]` : '';
}

interface ToolOutcome {
  ok: boolean;
  content: string;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Campo "${field}" é obrigatório`);
  return value;
}

function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'documento'
  );
}

function listEntries(
  dir: string,
  base: string,
  recursive: boolean,
  acc: string[],
): void {
  if (acc.length >= LIST_LIMIT) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (acc.length >= LIST_LIMIT) {
      acc.push(`… (limite de ${LIST_LIMIT} entradas atingido)`);
      return;
    }
    if (entry.name === PROJECT_META_DIR || entry.name === 'node_modules') continue;
    const rel = path.join(base, entry.name);
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      // statSync segue symlinks — pasta referenciada entra como pasta normal
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      acc.push(`${rel}/`);
      if (recursive) listEntries(full, rel, true, acc);
    } else {
      acc.push(`${rel} (${stat.size} bytes)`);
    }
  }
}

/** Limites da busca em arquivos. */
const SEARCH_MAX_MATCHES = 100;
const SEARCH_MAX_FILES = 2_000;
const SEARCH_FILE_LIMIT = 1024 * 1024;
const SEARCH_LINE_CLAMP = 240;
/** Teto por chamada de portal_fetch_url (o modelo continua com offset). */
const URL_READ_CAP = 24_000;
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.7z',
  '.xlsx', '.xlsm', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.bin', '.exe', '.dylib', '.so',
  '.woff', '.woff2', '.ttf', '.mp3', '.mp4', '.mov', '.vsix',
]);

/** Biblioteca Python sugerida no erro quando o modelo tenta gravar documento binário como texto. */
const DOC_FORMAT_LIBS: Record<string, string> = {
  '.pptx': 'python-pptx',
  '.ppt': 'python-pptx (gere .pptx)',
  '.xlsx': 'openpyxl',
  '.xlsm': 'openpyxl',
  '.xls': 'openpyxl (gere .xlsx)',
  '.docx': 'python-docx',
  '.doc': 'python-docx (gere .docx)',
  '.pdf': 'reportlab ou fpdf2',
};

/** Arquivos de texto da pasta, em caminhos relativos (pula meta/node_modules/binários). */
function walkTextFiles(dir: string, base: string, acc: string[], depth = 0): void {
  // teto de profundidade evita loop por symlink cíclico numa pasta referenciada
  if (acc.length >= SEARCH_MAX_FILES || depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (acc.length >= SEARCH_MAX_FILES) return;
    if (entry.name === PROJECT_META_DIR || entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const rel = base ? path.join(base, entry.name) : entry.name;
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(full);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      walkTextFiles(full, rel, acc, depth + 1);
    } else if (isFile && !BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      acc.push(rel);
    }
  }
}

export async function dispatchBuiltinTool(
  name: string,
  input: unknown,
  workRoot: string,
  projectId: string,
  /** Bases vinculadas ao agente da sessão — entram na busca mesmo desabilitadas. */
  agentBaseIds: string[] = [],
): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'portal_search_knowledge': {
        const query = asString(args.query, 'query');
        const baseFilter =
          typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
        const hits = searchKnowledge(query, projectId || undefined, agentBaseIds, baseFilter);
        if (!hits.length) {
          return {
            ok: true,
            content:
              'Nenhum trecho encontrado para essa busca. Tente outras palavras-chave (sinônimos, ' +
              'siglas, termos do índice das bases) ou leia um documento do índice com portal_read_knowledge.',
          };
        }
        const body = hits
          .map(
            (hit, i) =>
              `[${i + 1}] Base "${hit.baseName}" — ${hit.docName}` +
              (hit.heading ? ` — seção "${hit.heading}"` : '') +
              `\n${hit.snippet}`,
          )
          .join('\n\n---\n\n');
        return {
          ok: true,
          content: `${body}\n\n(Trechos parciais — para o documento completo use portal_read_knowledge com a base e o doc indicados.)`,
        };
      }
      case 'portal_read_knowledge': {
        const base = asString(args.base, 'base');
        const doc = asString(args.doc, 'doc');
        const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
        return {
          ok: true,
          content: readKnowledgeDoc(base, doc, projectId || undefined, agentBaseIds, offset),
        };
      }
      case 'portal_save_knowledge': {
        const baseName = asString(args.base, 'base').trim();
        const scope = args.scope === 'project' ? 'project' : 'global';
        if (scope === 'project' && !projectId) {
          throw new Error(
            'Esta conversa não está em um projeto: use scope "global" ou abra um chat de projeto',
          );
        }
        // reaproveita base existente com o mesmo nome (em qualquer escopo visível)
        let base = listBases(projectId || undefined).find(
          (b) => b.name.trim().toLowerCase() === baseName.toLowerCase(),
        );
        let created = false;
        if (!base) {
          base = createBase({
            name: baseName,
            description: typeof args.description === 'string' ? args.description.trim() : undefined,
            scope,
            projectId: scope === 'project' ? projectId : undefined,
          });
          if (!base) throw new Error('Não foi possível criar a base de conhecimento');
          created = true;
        }
        let docName =
          typeof args.doc === 'string' && args.doc.trim() ? args.doc.trim() : slugify(baseName);
        if (!['.md', '.txt'].includes(path.extname(docName).toLowerCase())) docName += '.md';
        const doc = writeDoc(base.id, docName, asString(args.content, 'content'));
        return {
          ok: true,
          content:
            `Documento "${doc.name}" salvo na base "${base.name}"` +
            (created ? ` (base ${scope === 'global' ? 'global' : 'do projeto'} criada)` : '') +
            ' — visível na página Conhecimento; entra no contexto dos chats enquanto a base estiver habilitada.',
        };
      }
      case 'portal_create_skill': {
        const scope = args.scope === 'global' ? 'global' : 'project';
        const command =
          typeof args.command === 'string'
            ? args.command.trim().replace(/^\//, '') || undefined
            : undefined;
        const skill = createSkill({
          scope,
          projectId: scope === 'project' ? projectId : undefined,
          name: asString(args.name, 'name').trim(),
          description: typeof args.description === 'string' ? args.description.trim() : '',
          command,
          content: asString(args.content, 'content'),
        });
        if (!skill) throw new Error('Projeto não encontrado para registrar a skill');
        return {
          ok: true,
          content:
            `Skill "${skill.name}" registrada (${scope === 'project' ? 'do projeto' : 'global'}) — ` +
            `use /${skill.command} no chat ou ative-a no menu Skills para injetá-la no contexto.`,
        };
      }
      case 'portal_create_agent': {
        const defaultMode = (['ask', 'plan', 'agent'] as const).find(
          (m) => m === args.defaultMode,
        ) as SessionMode | undefined;
        const agent = createAgent({
          name: asString(args.name, 'name').trim(),
          description:
            typeof args.description === 'string' ? args.description.trim() : undefined,
          icon: typeof args.icon === 'string' && args.icon.trim() ? args.icon.trim() : undefined,
          instructions: asString(args.instructions, 'instructions'),
          defaultMode,
        });
        return {
          ok: true,
          content:
            `Agente "${agent.name}" criado — já aparece no seletor de agente do chat e pode ser ` +
            'editado na página Agents.',
        };
      }
      case 'portal_load_skill': {
        const command = asString(args.command, 'command').trim().replace(/^\//, '').toLowerCase();
        const visible = listSkills(projectId || undefined);
        const meta = visible.find((s) => s.command === command);
        if (!meta) {
          const known = visible.map((s) => s.command).join(', ');
          throw new Error(
            `Skill "${command}" não encontrada. Comandos visíveis: ${known || '(nenhum)'}`,
          );
        }
        const skill = getSkill(meta.id);
        if (!skill?.content) throw new Error(`Skill "${command}" está sem conteúdo`);
        const input =
          typeof args.input === 'string' && args.input.trim()
            ? args.input
            : '(o pedido do usuário está na conversa)';
        const content = skill.content.includes('{{input}}')
          ? skill.content.replaceAll('{{input}}', input)
          : skill.content;
        const filesNote = skill.files?.length
          ? `\n\nAnexos desta skill (leia com portal_read_skill_file quando as instruções citarem): ${skill.files.join(', ')}`
          : '';
        return {
          ok: true,
          content: `Skill "${skill.name}" carregada. Siga estas instruções agora:\n\n${content}${filesNote}`,
        };
      }
      case 'portal_read_skill_file': {
        const command = asString(args.command, 'command').trim().replace(/^\//, '').toLowerCase();
        const rel = asString(args.path, 'path');
        const visible = listSkills(projectId || undefined);
        const meta = visible.find((s) => s.command === command);
        if (!meta) throw new Error(`Skill "${command}" não encontrada.`);
        const text = readSkillAsset(meta.id, rel);
        if (text === undefined) {
          const available = getSkill(meta.id)?.files ?? [];
          throw new Error(
            `Anexo "${rel}" não existe na skill "${command}". Anexos disponíveis: ${available.join(', ') || '(nenhum)'}`,
          );
        }
        return { ok: true, content: text };
      }
      case 'portal_write_file': {
        const rel = asString(args.path, 'path');
        // gravar um formato binário como texto UTF-8 sempre corrompe o arquivo
        // (ex.: .pptx é um ZIP) — o erro redireciona o modelo para o caminho
        // que funciona, na mesma rodada
        const ext = path.extname(rel).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          const lib = DOC_FORMAT_LIBS[ext];
          throw new Error(
            `${rel}: ${ext} é um formato binário e esta ferramenta só grava texto — o arquivo sairia corrompido. ` +
              (lib
                ? `Escreva um script Python em .tmp/ (pasta oculta do usuário) que gere o arquivo com a ` +
                  `biblioteca ${lib} e rode-o com portal_run_command seguindo as instruções do ambiente ` +
                  `de execução (uv run --with, ou o venv compartilhado do portal — nunca pip no Python global).`
                : `Gere o arquivo com um script via portal_run_command usando uma ferramenta adequada ao formato.`),
          );
        }
        const content = typeof args.content === 'string' ? args.content : '';
        if (Buffer.byteLength(content) > WRITE_LIMIT) {
          throw new Error(`Conteúdo excede o limite de ${WRITE_LIMIT / 1024 / 1024} MB`);
        }
        const file = resolveInProject(workRoot, rel);
        const append = args.append === true;
        if (!append && args.overwrite === false && fs.existsSync(file)) {
          throw new Error(`Arquivo já existe: ${rel}`);
        }
        const ck = tryCheckpoint(workRoot, name, 'write', [
          { absPath: file, relPath: path.relative(workRoot, file) },
        ]);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (append) fs.appendFileSync(file, content, 'utf8');
        else fs.writeFileSync(file, content, 'utf8');
        const size = fs.statSync(file).size;
        return {
          ok: true,
          content: append
            ? `Bloco anexado a ${rel} (+${Buffer.byteLength(content)} bytes, total ${size})${checkpointNote(ck)}`
            : `Arquivo salvo: ${rel} (${size} bytes)${checkpointNote(ck)}`,
        };
      }
      case 'portal_todo': {
        const raw = Array.isArray(args.todos) ? (args.todos as unknown[]) : [];
        if (!raw.length) throw new Error('Envie a lista completa de etapas em "todos"');
        const icon = { pending: '☐', in_progress: '▶', done: '☑' } as const;
        let done = 0;
        const lines = raw.map((t, i) => {
          const e = (t ?? {}) as { title?: unknown; status?: unknown };
          const title = typeof e.title === 'string' && e.title ? e.title : `(etapa ${i + 1})`;
          const status =
            e.status === 'in_progress' || e.status === 'done' ? e.status : ('pending' as const);
          if (status === 'done') done++;
          return `${icon[status]} ${title}`;
        });
        return {
          ok: true,
          content: `Plano (${done}/${raw.length} concluídas)\n${lines.join('\n')}`,
        };
      }
      case 'portal_command_output': {
        const id = asString(args.id, 'id');
        return backgroundOutput(id, args.kill === true);
      }
      case 'portal_read_file': {
        const rel = asString(args.path, 'path');
        const file = resolveInProject(workRoot, rel);
        const start =
          typeof args.startLine === 'number' && args.startLine >= 1
            ? Math.floor(args.startLine)
            : undefined;
        const end =
          typeof args.endLine === 'number' && args.endLine >= 1
            ? Math.floor(args.endLine)
            : undefined;
        const full = readFileClamped(file, rel);
        if (start === undefined && end === undefined) return { ok: true, content: full };
        const lines = full.split('\n');
        const from = (start ?? 1) - 1;
        const to = Math.min(end ?? lines.length, lines.length);
        if (from >= lines.length) {
          throw new Error(`${rel} tem ${lines.length} linhas — startLine ${start} está além do fim`);
        }
        return {
          ok: true,
          content:
            `${rel} (linhas ${from + 1}–${to} de ${lines.length}):\n` +
            lines.slice(from, to).join('\n'),
        };
      }
      case 'portal_list_files': {
        const rel = typeof args.path === 'string' && args.path ? args.path : '.';
        const dir = resolveInProject(workRoot, rel);
        const acc: string[] = [];
        listEntries(dir, rel === '.' ? '' : rel, args.recursive === true, acc);
        return { ok: true, content: acc.length ? acc.join('\n') : '(pasta vazia)' };
      }
      case 'portal_edit_file': {
        const rel = asString(args.path, 'path');
        const file = resolveInProject(workRoot, rel);
        interface EditOp {
          find: string;
          replace: string;
          replaceAll: boolean;
        }
        const ops: EditOp[] = [];
        if (Array.isArray(args.edits) && args.edits.length) {
          for (const [i, raw] of (args.edits as unknown[]).entries()) {
            const e = (raw ?? {}) as { find?: unknown; replace?: unknown; replaceAll?: unknown };
            if (typeof e.find !== 'string' || !e.find) {
              throw new Error(`edits[${i}].find é obrigatório`);
            }
            ops.push({
              find: e.find,
              replace: typeof e.replace === 'string' ? e.replace : '',
              replaceAll: e.replaceAll === true,
            });
          }
        } else {
          ops.push({
            find: asString(args.find, 'find'),
            replace: typeof args.replace === 'string' ? args.replace : '',
            replaceAll: args.replaceAll === true,
          });
        }
        // aplica tudo em memória primeiro: erro em qualquer trecho não grava nada
        let content = readFileForEdit(file, rel);
        let total = 0;
        for (const [i, op] of ops.entries()) {
          const at = ops.length > 1 ? `edits[${i}]: ` : '';
          let count = 0;
          for (let j = content.indexOf(op.find); j >= 0; j = content.indexOf(op.find, j + op.find.length)) {
            count++;
          }
          if (!count) {
            throw new Error(
              `${at}trecho não encontrado em ${rel} — o campo "find" deve bater exatamente, ` +
                `incluindo espaços e quebras de linha (nenhuma alteração foi gravada)`,
            );
          }
          if (count > 1 && !op.replaceAll) {
            throw new Error(
              `${at}o trecho aparece ${count} vezes em ${rel} — inclua linhas vizinhas para ` +
                `torná-lo único, ou use replaceAll: true (nenhuma alteração foi gravada)`,
            );
          }
          content = op.replaceAll
            ? content.split(op.find).join(op.replace)
            : content.replace(op.find, () => op.replace);
          total += op.replaceAll ? count : 1;
        }
        const ck = tryCheckpoint(workRoot, name, 'edit', [
          { absPath: file, relPath: path.relative(workRoot, file) },
        ]);
        fs.writeFileSync(file, content, 'utf8');
        const diff = ops.map((op) => miniDiff(op.find, op.replace)).join('\n\n');
        return {
          ok: true,
          content:
            `${rel}: ${total} ocorrência${total === 1 ? '' : 's'} substituída${total === 1 ? '' : 's'}` +
            `${checkpointNote(ck)}\n${diff}`,
        };
      }
      case 'portal_search_files': {
        const query = asString(args.query, 'query');
        const rel = typeof args.path === 'string' && args.path ? args.path : '.';
        const dir = resolveInProject(workRoot, rel);
        const flags = args.caseSensitive === true ? '' : 'i';
        let pattern: RegExp;
        try {
          pattern = args.regex === true
            ? new RegExp(query, flags)
            : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        } catch (err) {
          throw new Error(`Expressão regular inválida: ${err instanceof Error ? err.message : String(err)}`);
        }
        const files: string[] = [];
        walkTextFiles(dir, rel === '.' ? '' : rel, files);
        const matches: string[] = [];
        for (const fileRel of files) {
          if (matches.length >= SEARCH_MAX_MATCHES) break;
          const abs = path.resolve(workRoot, fileRel);
          let text: string;
          try {
            if (fs.statSync(abs).size > SEARCH_FILE_LIMIT) continue;
            text = fs.readFileSync(abs, 'utf8');
          } catch {
            continue;
          }
          if (text.includes('\0')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && matches.length < SEARCH_MAX_MATCHES; i++) {
            if (pattern.test(lines[i])) {
              matches.push(`${fileRel}:${i + 1}: ${lines[i].trim().slice(0, SEARCH_LINE_CLAMP)}`);
            }
          }
        }
        if (!matches.length) {
          return {
            ok: true,
            content:
              'Nenhuma linha encontrada. Tente outros termos ou liste os arquivos com portal_list_files.',
          };
        }
        const suffix =
          matches.length >= SEARCH_MAX_MATCHES
            ? `\n… (limite de ${SEARCH_MAX_MATCHES} resultados atingido — refine a busca)`
            : '';
        return { ok: true, content: matches.join('\n') + suffix };
      }
      case 'portal_delete_file': {
        const rel = asString(args.path, 'path');
        const target = resolveInProject(workRoot, rel);
        if (!fs.existsSync(target)) throw new Error(`Não existe: ${rel}`);
        const isDir = fs.statSync(target).isDirectory();
        if (isDir && args.recursive !== true) {
          throw new Error(`${rel} é uma pasta — para excluir com o conteúdo, passe recursive: true`);
        }
        const ck = tryCheckpoint(workRoot, name, 'delete', [
          { absPath: target, relPath: path.relative(workRoot, target) },
        ]);
        fs.rmSync(target, { recursive: isDir, force: true });
        return {
          ok: true,
          content: `${isDir ? 'Pasta excluída' : 'Arquivo excluído'}: ${rel}${checkpointNote(ck)}`,
        };
      }
      case 'portal_move_file': {
        const fromRel = asString(args.from, 'from');
        const toRel = asString(args.to, 'to');
        // renomear .py → .pptx não converte nada — e já destruiu documento
        // gerado de verdade quando o modelo moveu o script por cima dele
        const toExt = path.extname(toRel).toLowerCase();
        if (BINARY_EXTENSIONS.has(toExt) && path.extname(fromRel).toLowerCase() !== toExt) {
          throw new Error(
            `Mover ${fromRel} para ${toExt} não converte o arquivo — a extensão não muda o ` +
              `formato e o resultado não abriria. Se um script gerou o documento, ele já está ` +
              `no caminho onde o script salvou; NÃO mova o script por cima dele.`,
          );
        }
        const from = resolveInProject(workRoot, fromRel);
        const to = resolveInProject(workRoot, toRel);
        if (!fs.existsSync(from)) throw new Error(`Não existe: ${fromRel}`);
        if (fs.existsSync(to) && args.overwrite !== true) {
          throw new Error(`Destino já existe: ${toRel} (use overwrite: true para substituir)`);
        }
        // snapshot da origem e do destino: reverter restaura a origem e o
        // destino volta ao estado anterior (conteúdo antigo, ou apagado)
        const ck = tryCheckpoint(workRoot, name, 'move', [
          { absPath: from, relPath: path.relative(workRoot, from) },
          { absPath: to, relPath: path.relative(workRoot, to) },
        ]);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        return { ok: true, content: `Movido: ${fromRel} → ${toRel}${checkpointNote(ck)}` };
      }
      case 'portal_fetch_url': {
        const url = normalizeSourceUrl(asString(args.url, 'url'));
        const { content } = await fetchSourceContent(url);
        const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0;
        if (offset >= content.length && content.length > 0) {
          throw new Error(`Offset ${offset} além do fim do conteúdo (${content.length} caracteres)`);
        }
        const chunk = content.slice(offset, offset + URL_READ_CAP);
        const remaining = content.length - (offset + chunk.length);
        const footer =
          remaining > 0
            ? `\n\n… (continua — chame de novo com offset=${offset + chunk.length} para os ${remaining} caracteres restantes)`
            : '';
        return {
          ok: true,
          content: `# ${url} (caracteres ${offset}–${offset + chunk.length} de ${content.length})\n\n${chunk}${footer}`,
        };
      }
      case 'portal_web_search': {
        const query = asString(args.query, 'query');
        const max =
          typeof args.maxResults === 'number' && args.maxResults > 0
            ? Math.min(15, Math.floor(args.maxResults))
            : 8;
        const results = await searchWeb(query, max);
        const lines = results.map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
        );
        return {
          ok: true,
          content: `# Busca: ${query} (${results.length} resultados)\n\n${lines.join('\n\n')}`,
        };
      }
      case 'bmad_read_file': {
        const rel = asString(args.path, 'path');
        return { ok: true, content: readFileClamped(resolveInBmad(rel), rel) };
      }
      case 'bmad_write_custom': {
        const rel = asString(args.path, 'path');
        const content = asString(args.content, 'content');
        const abs = resolveInBmad(rel);
        const customRoot = path.join(bmadRootDir(), '_bmad', 'custom');
        if (!abs.startsWith(customRoot + path.sep) || !abs.toLowerCase().endsWith('.toml')) {
          throw new Error('Só é permitido gravar arquivos .toml dentro de _bmad/custom/');
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        return { ok: true, content: `Override gravado na instalação BMAD: ${rel}` };
      }
      case 'bmad_list_files': {
        const rel = typeof args.path === 'string' && args.path ? args.path : '.';
        const dir = resolveInBmad(rel);
        const acc: string[] = [];
        listEntries(dir, rel === '.' ? '' : rel, args.recursive === true, acc);
        return { ok: true, content: acc.length ? acc.join('\n') : '(pasta vazia)' };
      }
      default:
        return { ok: false, content: `Ferramenta desconhecida: ${name}` };
    }
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
}
