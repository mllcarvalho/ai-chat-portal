import { create } from 'zustand';
import type { CollabIdentity, CollabPeer, CollabStatus, PortalEvents } from '@aiportal/shared';
import { api, clientId } from '../api/client';
import { cancelJob, getLocalPortal, runFederatedJob } from '../api/federation';
import { streamPortalEvents } from '../api/events';
import { syncRelayBridge } from '../api/relayBridge';
import { isHosted, viaRelay } from '../api/server';
import { useBoard } from './boardStore';
import { useChat } from './chatStore';
import { useSessions } from './sessionsStore';
import { useUi } from './uiStore';

/**
 * Colaboração no cliente: mantém a conexão com o canal global de eventos
 * (/api/events) e traduz cada evento em atualização dos outros stores — é o
 * que faz outra aba (ou outra pessoa, no modo host) aparecer na tela na hora,
 * sem polling. Também carrega a identidade (host/convidado) e a presença.
 */

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];

interface CollabState {
  identity?: CollabIdentity;
  peers: CollabPeer[];
  connected: boolean;
  /** Estado da tela de configurações do host. */
  status?: CollabStatus;
  /** Executor escolhido por conversa (federação): clientId + nome, ou null = host. */
  executors: Record<string, { clientId: string; name: string } | null>;
  /** Esta aba pode executar na licença própria (portal local ligado). */
  canExecute: boolean;

  /** Identidade via GET (o boot precisa dela ANTES do hello do SSE chegar). */
  loadIdentity: () => Promise<void>;
  /** Conecta (uma vez) ao canal de eventos; reconecta sozinho para sempre. */
  connect: () => void;
  /** Conta ao servidor o que esta aba está olhando (presença). */
  setViewing: (viewing: { sessionId?: string; projectId?: string; board?: boolean }) => void;
  loadStatus: () => Promise<void>;
  /** Pessoas (além de mim) olhando esta conversa agora. */
  viewersOf: (sessionId: string) => CollabPeer[];
  /** Anuncia (ou retira) a capacidade de executar na licença própria. */
  advertiseCapability: (canExecute: boolean) => void;
  /** Escolhe quem executa a inferência da conversa (null = host). */
  chooseExecutor: (sessionId: string, executorClientId: string | null) => Promise<void>;
  /** Carrega o executor atual de uma conversa (ao abrir). */
  loadExecutor: (sessionId: string) => Promise<void>;
}

let started = false;
let lastViewingKey = '';
let everConnected = false;

export const useCollab = create<CollabState>((set, get) => {
  const handleEvent = (event: string, data: unknown): void => {
    switch (event) {
      case 'hello': {
        const hello = data as PortalEvents['hello'];
        set({ identity: hello.identity, peers: hello.peers, connected: true });
        // re-anuncia a capacidade de executar após (re)conectar
        if (get().canExecute || getLocalPortal()) get().advertiseCapability(!!getLocalPortal());
        // portal hospedado: a aba do host é a ponte dos convidados — o status
        // traz a sala do relay (e religa a ponte depois de um restart)
        if (hello.identity.role === 'host' && isHosted() && !viaRelay()) void get().loadStatus();
        // conexão nova depois de uma queda: o que aconteceu no vácuo não
        // chegou por evento — ressincroniza tudo que está na tela
        if (everConnected) resyncAfterReconnect();
        everConnected = true;
        break;
      }
      case 'peers':
        set({ peers: (data as PortalEvents['peers']).peers });
        break;
      case 'session_changed': {
        const { summary } = data as PortalEvents['session_changed'];
        const sessions = useSessions.getState();
        sessions.applyRemoteSummary(summary);
        const current = sessions.current;
        if (
          current?.id === summary.id &&
          current.updatedAt !== summary.updatedAt &&
          // com stream local ativo o próprio stream materializa a resposta;
          // recarregar no meio apagaria o parcial da tela
          !useChat.getState().streams[summary.id]
        ) {
          void sessions.reloadCurrentFromServer(
            summary.id,
            () => !useChat.getState().streams[summary.id],
          );
        }
        break;
      }
      case 'session_deleted': {
        const { sessionId, projectId } = data as PortalEvents['session_deleted'];
        const sessions = useSessions.getState();
        const wasOpen = sessions.current?.id === sessionId;
        sessions.removeRemoteSession(sessionId, projectId);
        if (wasOpen) {
          useUi.getState().toast('Esta conversa foi excluída em outra aba.', 'info');
        }
        break;
      }
      case 'generation_started': {
        const { sessionId } = data as PortalEvents['generation_started'];
        // outra aba/pessoa começou uma geração: anexa para ver ao vivo (o
        // resume ignora se esta aba já tem um stream desta sessão)
        void useChat.getState().resume(sessionId);
        break;
      }
      case 'lm_request': {
        const { targetClientId, job } = data as PortalEvents['lm_request'];
        // só a aba-alvo executa (o evento é direcionado, mas confere)
        if (targetClientId === clientId) void runFederatedJob(job);
        break;
      }
      case 'lm_cancel': {
        const { targetClientId, jobId } = data as PortalEvents['lm_cancel'];
        if (targetClientId === clientId) cancelJob(jobId);
        break;
      }
      case 'executor_changed': {
        const ev = data as PortalEvents['executor_changed'];
        set((s) => ({
          executors: {
            ...s.executors,
            [ev.sessionId]: ev.executorClientId
              ? { clientId: ev.executorClientId, name: ev.executorName ?? 'convidado' }
              : null,
          },
        }));
        break;
      }
      case 'board_op':
        useBoard.getState().applyRemote(data as PortalEvents['board_op']);
        break;
      case 'board_cursor':
        useBoard.getState().applyCursor(data as PortalEvents['board_cursor']);
        break;
      case 'projects_changed':
        void useSessions.getState().loadProjects();
        break;
      case 'collab_changed':
        if (get().status) void get().loadStatus();
        break;
      default:
        // servidor mais novo que o build da aba: ignora sem quebrar
        break;
    }
  };

  /** A conexão caiu e voltou: o que aconteceu no vácuo não chegou — ressincroniza. */
  const resyncAfterReconnect = (): void => {
    const sessions = useSessions.getState();
    void sessions.loadProjects();
    void sessions.loadSessions(null);
    const current = sessions.current;
    if (current) {
      void sessions.loadSessions(current.projectId ?? null);
      if (!useChat.getState().streams[current.id]) {
        void sessions.reloadCurrentFromServer(
          current.id,
          () => !useChat.getState().streams[current.id],
        );
      }
    }
    void useChat.getState().resumeAll();
    void useBoard.getState().resync();
    // presença desta aba se perdeu com a conexão antiga
    lastViewingKey = '';
  };

  return {
    peers: [],
    connected: false,
    executors: {},
    canExecute: false,

    loadIdentity: async () => {
      try {
        set({ identity: await api.collabMe() });
      } catch {
        // servidor antigo sem a rota: segue como antes (single-player)
      }
    },

    connect: () => {
      if (started) return;
      started = true;
      void (async () => {
        let attempt = 0;
        // laço eterno: o canal é a espinha da colaboração — sempre reconecta
        while (true) {
          const controller = new AbortController();
          const before = Date.now();
          try {
            await streamPortalEvents(clientId, handleEvent, controller.signal);
          } catch {
            // servidor fora / rede caiu — tenta de novo abaixo
          } finally {
            controller.abort();
            set({ connected: false });
          }
          // conexão durou bem = servidor saudável: zera o backoff
          if (Date.now() - before > 30_000) attempt = 0;
          const delay = RECONNECT_DELAYS_MS[Math.min(attempt++, RECONNECT_DELAYS_MS.length - 1)];
          await new Promise((r) => setTimeout(r, delay));
        }
      })();
    },

    setViewing: (viewing) => {
      const key = JSON.stringify(viewing);
      if (key === lastViewingKey) return;
      lastViewingKey = key;
      void api.setViewing(viewing).catch(() => {
        // presença é cosmética; a próxima mudança tenta de novo
        lastViewingKey = '';
      });
    },

    loadStatus: async () => {
      try {
        const status = await api.collabStatus();
        set({ status });
        syncRelayBridge(status.enabled ? status.relay : undefined);
      } catch {
        // convidado (403) ou servidor antigo: a seção simplesmente não aparece
      }
    },

    viewersOf: (sessionId) =>
      get().peers.filter((p) => p.clientId !== clientId && p.viewing?.sessionId === sessionId),

    advertiseCapability: (canExecute) => {
      set({ canExecute });
      void api.setCapability(canExecute).catch(() => undefined);
    },

    chooseExecutor: async (sessionId, executorClientId) => {
      // otimista: reflete já; o evento executor_changed confirma para todos
      set((s) => ({
        executors: {
          ...s.executors,
          [sessionId]: executorClientId
            ? {
                clientId: executorClientId,
                name:
                  get().peers.find((p) => p.clientId === executorClientId)?.name ?? 'convidado',
              }
            : null,
        },
      }));
      try {
        await api.setExecutor(sessionId, executorClientId);
      } catch (err) {
        useUi.getState().toast((err as Error).message, 'error');
      }
    },

    loadExecutor: async (sessionId) => {
      try {
        const { executorClientId, executorName } = await api.getExecutor(sessionId);
        set((s) => ({
          executors: {
            ...s.executors,
            [sessionId]: executorClientId
              ? { clientId: executorClientId, name: executorName ?? 'convidado' }
              : null,
          },
        }));
      } catch {
        // servidor antigo sem a rota: sem federação, segue no host
      }
    },
  };
});
