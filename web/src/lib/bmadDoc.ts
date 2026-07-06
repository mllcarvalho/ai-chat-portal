/**
 * Conteúdo da página Doc BMAD — curado a partir dos SKILL.md da instalação
 * global (bmad-method 6.9.0, módulo BMM). Ao subir a versão do BMAD no
 * bmadStore, revisar este catálogo (skills novas/removidas/depreciadas).
 */

export interface BmadAgentDoc {
  code: string;
  icon: string;
  persona: string;
  role: string;
  summary: string;
}

export interface BmadSkillDoc {
  /** Comando slash da skill (ex: bmad-prd). */
  command: string;
  /** Rótulo curto exibido ao lado do comando (ex: "criar/editar/validar PRD"). */
  label: string;
  name: string;
  description: string;
  /** Quem tipicamente executa (persona BMAD ou "Qualquer agente"). */
  agent: string;
  does: string;
  whenToUse: string;
  produces: string;
}

export interface BmadCategoryDoc {
  id: string;
  icon: string;
  title: string;
  blurb: string;
  skills: BmadSkillDoc[];
}

export const BMAD_AGENTS: BmadAgentDoc[] = [
  {
    code: 'analyst',
    icon: '📊',
    persona: 'Mary',
    role: 'Business Analyst',
    summary:
      'Analista de negócios e especialista em requisitos: pesquisa de mercado, análise competitiva e elicitação, traduzindo necessidades vagas em especificações acionáveis baseadas em evidência.',
  },
  {
    code: 'pm',
    icon: '📋',
    persona: 'John',
    role: 'Product Manager',
    summary:
      'Conduz a criação de PRDs com entrevistas, descoberta de requisitos e alinhamento de stakeholders — traduz visão de produto em incrementos pequenos e validados.',
  },
  {
    code: 'ux-designer',
    icon: '🎨',
    persona: 'Sally',
    role: 'UX Designer',
    summary:
      'Traduz necessidades dos usuários em design de interação e especificações de UX, equilibrando empatia com rigor em edge cases — alimenta arquitetura e implementação.',
  },
  {
    code: 'architect',
    icon: '🏛️',
    persona: 'Winston',
    role: 'System Architect',
    summary:
      'Converte requisitos de produto e UX em arquitetura técnica que entrega, favorecendo tecnologia estabelecida, produtividade do time e trade-offs explícitos.',
  },
  {
    code: 'dev',
    icon: '💻',
    persona: 'Amelia',
    role: 'Senior Software Engineer',
    summary:
      'Executa stories aprovadas com disciplina test-first (red-green-refactor), entregando código verificado que atende cada critério de aceitação.',
  },
  {
    code: 'tech-writer',
    icon: '✍️',
    persona: 'Paige',
    role: 'Technical Writer',
    summary:
      'Transforma conceitos complexos em documentação acessível e estruturada, adaptando a profundidade ao público (CommonMark, DITA, OpenAPI, Mermaid).',
  },
];

const AG = {
  analyst: 'Mary — Business Analyst (analyst)',
  pm: 'John — Product Manager (pm)',
  ux: 'Sally — UX Designer (ux-designer)',
  architect: 'Winston — System Architect (architect)',
  dev: 'Amelia — Senior Software Engineer (dev)',
  writer: 'Paige — Technical Writer (tech-writer)',
  any: 'Qualquer agente',
};

export const BMAD_CATEGORIES: BmadCategoryDoc[] = [
  {
    id: 'discovery',
    icon: '🔍',
    title: 'Descoberta e pesquisa',
    blurb:
      'Entender o problema antes de decidir: ideação, pesquisa de mercado/domínio/técnica e investigação de evidências.',
    skills: [
      {
        command: 'bmad-brainstorming',
        label: 'facilitação de ideias',
        name: 'Brainstorming',
        description: 'Sessões interativas de brainstorming com técnicas criativas variadas.',
        agent: AG.analyst,
        does:
          'Conduz uma sessão de ideação guiada, aplicando técnicas criativas diversas para gerar e organizar ideias com você.',
        whenToUse: 'Quando você quer "brainstormar" ou ideiar sobre um tema, produto ou problema.',
        produces: 'Registro estruturado das ideias e caminhos priorizados da sessão.',
      },
      {
        command: 'bmad-market-research',
        label: 'pesquisa de mercado',
        name: 'Market Research',
        description: 'Pesquisa de mercado sobre concorrência e clientes com fontes verificadas.',
        agent: AG.analyst,
        does:
          'Faz pesquisa de mercado abrangente usando busca na web, com narrativa e citações de fontes reais.',
        whenToUse: 'Quando precisar entender mercado, concorrentes ou clientes antes de decidir o rumo do produto.',
        produces: 'Documento de pesquisa de mercado com citações, em _bmad-output/planning-artifacts/.',
      },
      {
        command: 'bmad-domain-research',
        label: 'pesquisa de domínio',
        name: 'Domain Research',
        description: 'Pesquisa de domínio/indústria com dados atuais e fontes verificadas.',
        agent: AG.analyst,
        does:
          'Investiga um domínio ou indústria (regras, players, tendências) usando busca na web com citações.',
        whenToUse: 'Quando o time precisa dominar um assunto/indústria que não conhece a fundo.',
        produces: 'Documento de pesquisa de domínio com citações, em _bmad-output/planning-artifacts/.',
      },
      {
        command: 'bmad-technical-research',
        label: 'pesquisa técnica',
        name: 'Technical Research',
        description: 'Pesquisa técnica sobre tecnologias e arquitetura.',
        agent: AG.architect,
        does:
          'Compara tecnologias, padrões e abordagens de arquitetura com dados atuais da web e fontes citadas.',
        whenToUse: 'Antes de decisões técnicas relevantes (escolha de stack, integração, padrão arquitetural).',
        produces: 'Relatório de pesquisa técnica com citações, em _bmad-output/planning-artifacts/.',
      },
      {
        command: 'bmad-investigate',
        label: 'investigação por evidências',
        name: 'Investigate',
        description: 'Investigação forense com achados graduados por evidência.',
        agent: AG.dev,
        does:
          'Reconstrói o que está acontecendo (bug, incidente, área desconhecida do código) a partir de evidências, classificando cada achado como Confirmado, Deduzido ou Hipótese.',
        whenToUse:
          'Para investigar um bug ou incidente, percorrer código desconhecido ou montar um modelo mental de uma área antes de mexer nela.',
        produces: 'Um "case file" estruturado com os achados, em _bmad-output/implementation-artifacts/.',
      },
      {
        command: 'bmad-advanced-elicitation',
        label: 'crítica e refinamento',
        name: 'Advanced Elicitation',
        description: 'Métodos de elicitação para reconsiderar e melhorar a última saída.',
        agent: AG.any,
        does:
          'Aplica métodos de crítica (socrático, first principles, pre-mortem, red team…) sobre o conteúdo recém-gerado para aprofundá-lo e melhorá-lo.',
        whenToUse:
          'Quando quiser uma crítica mais profunda de uma seção/documento ou citar um método específico de elicitação.',
        produces: 'Versão refinada do conteúdo existente (não gera artefato próprio).',
      },
    ],
  },
  {
    id: 'planning',
    icon: '📋',
    title: 'Planejamento de produto',
    blurb:
      'Do conceito ao backlog: brief, PRFAQ, PRD, spec canônica e a decomposição em epics, stories e sprint.',
    skills: [
      {
        command: 'bmad-product-brief',
        label: 'criar/editar/validar brief',
        name: 'Product Brief',
        description: 'Cria, atualiza ou valida um product brief.',
        agent: AG.analyst,
        does:
          'Atua como coach para construir/refinar um brief do tamanho certo para o propósito — sem fazer o pensamento por você.',
        whenToUse: 'No começo de uma iniciativa, para alinhar problema, público e aposta antes do PRD.',
        produces: 'brief.md (+ addendum e decision log) em pasta própria dentro de _bmad-output/.',
      },
      {
        command: 'bmad-prfaq',
        label: 'working backwards (PRFAQ)',
        name: 'PRFAQ Challenge',
        description: 'Desafio PRFAQ no estilo Working Backwards da Amazon.',
        agent: AG.pm,
        does:
          'Escreve o press release e o FAQ do produto "de trás pra frente", estressando cada afirmação como um coach rigoroso.',
        whenToUse: 'Para forjar/validar um conceito de produto partindo do cliente, antes de investir em specs.',
        produces: 'Documento PRFAQ completo + um destilado de PRD para as próximas etapas.',
      },
      {
        command: 'bmad-prd',
        label: 'criar/editar/validar PRD',
        name: 'BMad PRD',
        description: 'Cria, atualiza ou valida um PRD (substitui os antigos create-prd e edit-prd).',
        agent: AG.pm,
        does:
          'Facilita a criação/edição/validação de um PRD calibrado ao rigor necessário, com discovery por elicitação e subagentes de pesquisa.',
        whenToUse: 'Sempre que precisar produzir, revisar ou validar um PRD — a skill detecta a intenção.',
        produces: 'prd.md (+ decision log e addendum) em pasta própria dentro de _bmad-output/.',
      },
      {
        command: 'bmad-spec',
        label: 'destilar em SPEC canônica',
        name: 'BMad Spec',
        description: 'Destila qualquer input no kernel SPEC — o contrato canônico do trabalho.',
        agent: AG.any,
        does:
          'Transforma ideias, brain dumps, PRDs, RFCs ou transcripts em um SPEC.md de cinco campos: porquê, capacidades, restrições, não-objetivos e sinal de sucesso.',
        whenToUse: 'Quando quiser um contrato enxuto e validado que as skills seguintes possam consumir.',
        produces: 'Pasta spec-<slug>/ com SPEC.md, companions e decision log, em _bmad-output/specs/.',
      },
      {
        command: 'bmad-create-epics-and-stories',
        label: 'quebrar em epics e stories',
        name: 'Create Epics and Stories',
        description: 'Quebra os requisitos do PRD em epics e user stories.',
        agent: AG.pm,
        does:
          'Transforma requisitos do PRD e decisões de arquitetura em stories organizadas por valor, com critérios de aceitação completos.',
        whenToUse: 'Depois de PRD e arquitetura prontos, para montar o backlog implementável.',
        produces: 'Lista de epics e stories com critérios de aceitação, em _bmad-output/planning-artifacts/.',
      },
      {
        command: 'bmad-create-story',
        label: 'criar a próxima story',
        name: 'Create Story',
        description: 'Cria um arquivo de story com todo o contexto para a implementação.',
        agent: AG.pm,
        does:
          'Monta um story file completo e otimizado — tudo o que o agente Dev precisa para implementar sem erros.',
        whenToUse: 'Antes de implementar: "crie a próxima story" ou "crie a story X".',
        produces: 'Story file dedicado em _bmad-output/, pronto para o bmad-dev-story.',
      },
      {
        command: 'bmad-sprint-planning',
        label: 'gerar plano do sprint',
        name: 'Sprint Planning',
        description: 'Gera o tracking de status do sprint a partir das epics.',
        agent: AG.dev,
        does: 'Lê os arquivos de epic, detecta o status de cada story e monta o tracking completo do sprint.',
        whenToUse: 'Ao iniciar (ou reorganizar) um sprint baseado nas epics existentes.',
        produces: 'sprint-status.yaml em _bmad-output/implementation-artifacts/.',
      },
    ],
  },
  {
    id: 'design',
    icon: '🏛️',
    title: 'Arquitetura e UX',
    blurb: 'Decisões de solução e experiência que guiam a implementação de forma consistente.',
    skills: [
      {
        command: 'bmad-create-architecture',
        label: 'decisões de arquitetura',
        name: 'Architecture',
        description: 'Cria as decisões de design de solução/arquitetura do projeto.',
        agent: AG.architect,
        does:
          'Facilita passo a passo as decisões de arquitetura, registrando-as para que agentes de IA implementem de forma consistente.',
        whenToUse: 'Depois do PRD, antes de quebrar em epics/stories — ou quando a solução técnica precisa ser desenhada.',
        produces: 'Documento de arquitetura em _bmad-output/planning-artifacts/.',
      },
      {
        command: 'bmad-ux',
        label: 'especificações de UX',
        name: 'BMad UX',
        description: 'Planeja padrões de UX e especificações de design.',
        agent: AG.ux,
        does:
          'Elicita e captura a SUA visão de UX (nunca impõe a dele) e a transforma em dois contratos: identidade visual e comportamento/jornadas.',
        whenToUse: 'Para criar, atualizar ou validar as especificações de UX do produto.',
        produces: 'DESIGN.md e EXPERIENCE.md (+ decision log) em pasta própria dentro de _bmad-output/.',
      },
      {
        command: 'bmad-generate-project-context',
        label: 'regras para agentes de IA',
        name: 'Generate Project Context',
        description: 'Cria o project-context.md com as regras que a IA deve seguir.',
        agent: AG.architect,
        does:
          'Captura regras, padrões e diretrizes não óbvias do projeto num arquivo conciso que os agentes leem antes de gerar código.',
        whenToUse: 'Quando quiser que qualquer agente gere código consistente com as convenções do projeto.',
        produces: 'project-context.md.',
      },
    ],
  },
  {
    id: 'dev',
    icon: '💻',
    title: 'Desenvolvimento',
    blurb: 'Implementar com disciplina: da checagem de prontidão à execução das stories.',
    skills: [
      {
        command: 'bmad-check-implementation-readiness',
        label: 'checar prontidão',
        name: 'Implementation Readiness',
        description: 'Valida que PRD, UX, arquitetura e epics estão completos e alinhados.',
        agent: AG.pm,
        does:
          'Confere rastreabilidade de requisitos e lacunas de planejamento antes de liberar a implementação.',
        whenToUse: 'Antes de começar a implementar, para garantir que as specs se sustentam.',
        produces: 'Relatório de prontidão com as lacunas encontradas.',
      },
      {
        command: 'bmad-dev-story',
        label: 'implementar uma story',
        name: 'Dev Story',
        description: 'Executa a implementação de uma story a partir do story file.',
        agent: AG.dev,
        does:
          'Implementa a story de ponta a ponta até completar todos os critérios de aceitação e tasks, atualizando o registro no próprio story file.',
        whenToUse: 'Quando houver uma story especificada pronta para implementar.',
        produces: 'Código implementado + story file atualizado (tasks, registro do dev, change log, status).',
      },
      {
        command: 'bmad-quick-dev',
        label: 'build/fix rápido',
        name: 'Quick Dev',
        description: 'Implementa qualquer intenção/bug fix/mudança sem o ciclo completo de stories.',
        agent: AG.dev,
        does:
          'Transforma sua intenção num artefato revisável e implementa seguindo a arquitetura e as convenções existentes.',
        whenToUse: 'Caminho rápido para construir, corrigir, refatorar ou ajustar algo pontual.',
        produces: 'Especificação enxuta "Ready for Development" + o código correspondente.',
      },
    ],
  },
  {
    id: 'quality',
    icon: '🔎',
    title: 'Qualidade e revisão',
    blurb: 'Revisões adversariais, caça a edge cases, testes E2E e revisão editorial de textos.',
    skills: [
      {
        command: 'bmad-code-review',
        label: 'revisão de código em camadas',
        name: 'Code Review',
        description: 'Revisão adversarial com camadas paralelas e triagem estruturada.',
        agent: AG.dev,
        does:
          'Reúne contexto, dispara revisões paralelas (Blind Hunter, Edge Case Hunter, Acceptance Auditor) e tria os achados em categorias acionáveis.',
        whenToUse: 'Para revisar mudanças de código com profundidade além do olho humano.',
        produces: 'Relatório de revisão triado por severidade/categoria.',
      },
      {
        command: 'bmad-review-adversarial-general',
        label: 'revisão cética geral',
        name: 'Adversarial Review',
        description: 'Revisão "cínica" de qualquer conteúdo, focada no que falta.',
        agent: AG.any,
        does:
          'Revisa diffs, specs, stories ou docs com ceticismo extremo e lista no mínimo dez problemas encontrados.',
        whenToUse: 'Quando quiser uma crítica dura de qualquer artefato (não só código).',
        produces: 'Lista de achados em markdown.',
      },
      {
        command: 'bmad-review-edge-case-hunter',
        label: 'caça a edge cases',
        name: 'Edge Case Hunter',
        description: 'Enumeração exaustiva de caminhos e condições de contorno não tratadas.',
        agent: AG.any,
        does:
          'Percorre mecanicamente cada branch e limite do conteúdo e reporta apenas os edge cases sem tratamento — sem julgar o código.',
        whenToUse: 'Para análise exaustiva de edge cases em código, specs ou diffs.',
        produces: 'Lista estruturada de achados: local, condição de disparo, guarda sugerida e consequência.',
      },
      {
        command: 'bmad-qa-generate-e2e-tests',
        label: 'gerar testes E2E',
        name: 'QA E2E Tests',
        description: 'Gera testes automatizados end-to-end para features existentes.',
        agent: AG.dev,
        does: 'Gera testes de API e E2E para código já implementado (só geração — não faz review).',
        whenToUse: 'Depois de implementar uma feature, para cobri-la com testes automatizados.',
        produces: 'Arquivos de teste automatizado em _bmad-output/implementation-artifacts/.',
      },
      {
        command: 'bmad-checkpoint-preview',
        label: 'revisão guiada por humano',
        name: 'Checkpoint Review',
        description: 'Revisão human-in-the-loop de uma mudança, guiada pela IA.',
        agent: AG.any,
        does: 'Guia você pela mudança — propósito, contexto e pontos que merecem atenção — para revisar e testar junto.',
        whenToUse: 'Quando quiser entender e revisar uma mudança com acompanhamento ("me guie por essa mudança").',
        produces: 'Walkthrough interativo da mudança (sem artefato de arquivo).',
      },
      {
        command: 'bmad-editorial-review-structure',
        label: 'revisão editorial de estrutura',
        name: 'Editorial Review — Structure',
        description: 'Editor estrutural: cortes, reorganização e simplificação de documentos.',
        agent: AG.writer,
        does:
          'Analisa a estrutura do documento e propõe mudanças de clareza e fluxo — propõe, não executa; rode ANTES da revisão de prosa.',
        whenToUse: 'Antes do copy-edit, quando o documento precisa de reorganização.',
        produces: 'Recomendações de estrutura para você aceitar ou não.',
      },
      {
        command: 'bmad-editorial-review-prose',
        label: 'revisão editorial de prosa',
        name: 'Editorial Review — Prose',
        description: 'Copy-editor clínico focado em problemas de comunicação.',
        agent: AG.writer,
        does:
          'Revisa o texto por problemas que atrapalham a compreensão e sugere correções mínimas, sem reescrever por preferência.',
        whenToUse: 'Para polir a prosa de um documento já estruturado.',
        produces: 'Tabela de correções sugeridas (trecho, problema, sugestão).',
      },
    ],
  },
  {
    id: 'tracking',
    icon: '📈',
    title: 'Acompanhamento do sprint',
    blurb: 'Visibilidade, mudanças de rumo e lições aprendidas durante a execução.',
    skills: [
      {
        command: 'bmad-sprint-status',
        label: 'status do sprint',
        name: 'Sprint Status',
        description: 'Resume o status do sprint e expõe riscos.',
        agent: AG.dev,
        does: 'Lê o tracking do sprint, resume o andamento, aponta riscos e recomenda a próxima ação.',
        whenToUse: 'Para saber onde o sprint está e qual o próximo passo.',
        produces: 'Resumo de status, riscos e próximos passos (sem artefato novo).',
      },
      {
        command: 'bmad-correct-course',
        label: 'mudança de rumo',
        name: 'Correct Course',
        description: 'Gerencia mudanças significativas no meio do sprint.',
        agent: AG.dev,
        does:
          'Analisa a issue disparadora e o impacto em PRD, epics, arquitetura e UX, propondo a mudança de forma estruturada.',
        whenToUse: 'Quando surge uma mudança relevante durante a execução do sprint.',
        produces: 'Sprint Change Proposal + epics/stories/seções de PRD atualizadas.',
      },
      {
        command: 'bmad-retrospective',
        label: 'retrospectiva do epic',
        name: 'Retrospective',
        description: 'Revisão pós-epic para extrair lições e preparar o próximo.',
        agent: AG.dev,
        does:
          'Facilita a retrospectiva (revisão do epic + preparação do próximo) com clima no-blame; pode envolver várias personas via party mode.',
        whenToUse: 'Ao concluir um epic.',
        produces: 'Documento com insights, lições e action items com responsáveis.',
      },
    ],
  },
  {
    id: 'docs-utils',
    icon: '🧰',
    title: 'Documentação e utilidades',
    blurb: 'Documentar projetos existentes, organizar arquivos e operar o próprio BMAD.',
    skills: [
      {
        command: 'bmad-document-project',
        label: 'documentar projeto existente',
        name: 'Document Project',
        description: 'Documenta projetos brownfield para servirem de contexto à IA.',
        agent: AG.writer,
        does: 'Varre um projeto existente e produz a documentação que os agentes precisam para trabalhar nele.',
        whenToUse: 'Em projetos já existentes (brownfield) sem documentação adequada para IA.',
        produces: 'Documentação do projeto em _bmad-output/planning-artifacts/.',
      },
      {
        command: 'bmad-index-docs',
        label: 'indexar uma pasta de docs',
        name: 'Index Docs',
        description: 'Gera/atualiza um index.md referenciando os documentos de uma pasta.',
        agent: AG.writer,
        does: 'Escaneia o diretório, lê e descreve cada arquivo e monta um índice organizado.',
        whenToUse: 'Quando uma pasta de documentos precisa de um índice navegável.',
        produces: 'index.md na pasta-alvo.',
      },
      {
        command: 'bmad-shard-doc',
        label: 'dividir documento grande',
        name: 'Shard Document',
        description: 'Divide markdowns grandes em arquivos menores por seção.',
        agent: AG.any,
        does: 'Divide um markdown grande em um arquivo por seção de nível 2 e gera o índice.',
        whenToUse: 'Quando um documento (ex.: arquitetura) ficou grande demais para consumo pelos agentes.',
        produces: 'Pasta com um arquivo por seção + index.md.',
      },
      {
        command: 'bmad-customize',
        label: 'customizar agentes/skills',
        name: 'BMad Customize',
        description: 'Cria e atualiza overrides de customização das skills BMAD.',
        agent: AG.any,
        does:
          'Traduz sua intenção num arquivo de override (TOML) para mudar o comportamento de um agente ou workflow — vale para todas as conversas do portal.',
        whenToUse: 'Para ajustar o comportamento padrão de um agente ou skill BMAD.',
        produces: 'Arquivos de override em _bmad/custom/.',
      },
      {
        command: 'bmad-party-mode',
        label: 'discussão multi-agente',
        name: 'Party Mode',
        description: 'Roundtable entre as personas BMAD habilitadas no portal.',
        agent: 'Todos os agentes habilitados',
        does:
          'Orquestra uma discussão em rodadas onde cada persona participa como subagente independente (2–4 vozes por rodada), reagindo umas às outras.',
        whenToUse: 'Quando quiser múltiplas perspectivas reais sobre um tema (debate, comitê, roundtable).',
        produces: 'A discussão no chat, com um balão por persona (sem artefato de arquivo).',
      },
      {
        command: 'bmad-help',
        label: 'orientação de próximos passos',
        name: 'BMad Help',
        description: 'Analisa onde você está no fluxo BMAD e recomenda o próximo passo.',
        agent: AG.any,
        does: 'Olha o estado do trabalho e responde dúvidas sobre o método, indicando a próxima skill e como invocá-la.',
        whenToUse: 'Quando não souber por onde começar ou qual é o próximo passo do método.',
        produces: 'Recomendações de próximas skills (sem artefato de arquivo).',
      },
    ],
  },
];
