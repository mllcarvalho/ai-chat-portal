import type * as vscode from 'vscode';
import type {
  AgentPreset,
  ChatAttachment,
  ChatErrorCode,
  ChatFinishReason,
  MessagePart,
  ModelInfo,
  Project,
  ProviderId,
  ProviderInfo,
  Session,
  SkillWithContent,
  TokenUsage,
} from '@aiportal/shared';
import type { ChatStream } from '../streamHub';

/**
 * Tudo o que um provider recebe para responder um turno. O que vem daqui já
 * foi resolvido pelo shell (runChat): a mensagem do usuário já está
 * persistida e presente em `session.messages`, e a pasta de trabalho já
 * está decidida (mas pode ainda não existir em disco).
 */
export interface TurnContext {
  /** Snapshot da sessão com a mensagem do usuário deste turno já aplicada. */
  session: Session;
  /** Texto puro da mensagem do usuário (sem os anexos). */
  text: string;
  /**
   * Anexos deste turno. O Copilot os lê de volta do histórico da sessão; os
   * providers que mantêm o histórico do lado da CLI só recebem a mensagem
   * nova, então precisam montar o conteúdo a partir daqui.
   */
  attachments: ChatAttachment[];
  agent?: AgentPreset;
  project?: Project;
  /** Pasta do projeto, ou o workspace próprio da sessão avulsa. */
  workRoot: string;
  /** Skills ativadas na conversa — o conteúdo entra no contexto. */
  instructionSkills: SkillWithContent[];
  /** Skills invocáveis por /comando (globais + do projeto + do agente). */
  commandSkills: SkillWithContent[];
  requestId: string;
  /** Id que a mensagem do assistente terá em disco — já anunciado no `meta`. */
  assistantMessageId: string;
  sse: ChatStream;
  token: vscode.CancellationToken;
  /**
   * Onde o provider empurra as partes da resposta conforme elas acontecem.
   * O shell persiste este array mesmo se o turno terminar em erro ou
   * cancelamento, então nunca acumule localmente para dar push só no fim.
   */
  parts: MessagePart[];
  /** Idem: o shell lê no fim, o provider vai somando durante o turno. */
  usage: TokenUsage;
  /**
   * Modelo que de fato respondeu, preenchido assim que o provider o resolve.
   * Existe além do `modelId` do TurnResult porque um turno que termina em
   * exceção não devolve resultado — e a mensagem parcial ainda precisa
   * registrar qual modelo estava respondendo.
   */
  respondedModelId?: string;
}

export interface TurnResult {
  finishReason: ChatFinishReason;
  /** Modelo que de fato respondeu — persistido na mensagem. */
  modelId?: string;
  /**
   * Id da conversa do lado da CLI, quando o provider mantém o histórico lá.
   * O shell grava na sessão para o próximo turno retomar (--resume).
   */
  providerSessionId?: string;
  /**
   * Trabalho que só faz sentido depois do `done` chegar na UI (ex.: medir os
   * créditos do Copilot, que o GitHub leva segundos para contabilizar). O
   * stream fica aberto até isto resolver.
   */
  afterDone?: () => Promise<void>;
}

/** Um backend de conversa: Copilot (portal é dono do loop) ou uma CLI agêntica. */
export interface ChatProvider {
  readonly id: ProviderId;

  /** Metadados e disponibilidade — alimenta GET /api/providers. */
  describe(): Promise<ProviderInfo>;

  /** Modelos oferecidos por este provider (lista vazia = indisponível). */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Responde um turno, emitindo eventos em `ctx.sse` e empurrando as partes
   * em `ctx.parts`. Pode lançar: o shell chama `mapError` e persiste o que
   * já tiver sido produzido.
   */
  runTurn(ctx: TurnContext): Promise<TurnResult>;

  /** Traduz uma exceção do turno para o erro que a UI mostra. */
  mapError(err: unknown): { code: ChatErrorCode; message: string };

  /**
   * Título curto gerado por modelo depois da primeira troca (melhor esforço).
   * Provider que não implementa mantém o título derivado da primeira linha.
   */
  generateTitle?(ctx: TurnContext, assistantText: string): Promise<string | undefined>;

  /**
   * Um subagente do party mode: conversa independente, com persona e tarefa
   * próprias e SÓ ferramentas de leitura, cujo texto final volta como
   * resultado da ferramenta. Provider sem isto não oferece party mode.
   */
  runSubagent?(req: SubagentRequest): Promise<SubagentOutcome>;
}

/** Pedido de subagente, já com a persona resolvida pelo chamador. */
export interface SubagentRequest {
  /** Instruções da persona (vazio = subagente genérico). */
  persona?: string;
  task: string;
  label?: string;
  /** Modelo pedido pelo chamador; cada provider interpreta no catálogo dele. */
  modelId?: string;
  workRoot: string;
  sessionId: string;
  projectId: string;
  agentBaseIds: string[];
  token: vscode.CancellationToken;
}

export interface SubagentOutcome {
  ok: boolean;
  content: string;
  usage: { inputTokens: number; outputTokens: number; requests: number };
}
