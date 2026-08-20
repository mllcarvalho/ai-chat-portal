import { useEffect, useRef } from 'react';
import type { SharedRevision } from '@aiportal/shared';
import { api } from '../api/client';

/*
 * Uma página pode montar o hook mais de uma vez (a de Agentes observa skills,
 * agentes E bases). Sem isto seriam três GETs por tick para a mesma resposta —
 * então quem chegar dentro da janela abaixo compartilha a requisição em voo.
 */
const SHARE_WINDOW_MS = 3_000;
let inFlight: Promise<SharedRevision> | undefined;
let inFlightAt = 0;

function fetchRevision(): Promise<SharedRevision> {
  if (inFlight && Date.now() - inFlightAt < SHARE_WINDOW_MS) return inFlight;
  inFlightAt = Date.now();
  inFlight = api.sharedRevision();
  // erro não pode ficar "grudado" no cache até a janela vencer
  inFlight.catch(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/**
 * Avisa quando alguém MEXEU na pasta compartilhada.
 *
 * O servidor mantém um hash de mtime+tamanho por tipo (skills/agents/
 * knowledge); aqui a gente compara entre um poll e outro e chama `onChange`
 * quando o hash daquele tipo muda. É o que faz a skill que a colega acabou de
 * salvar na pasta da equipe aparecer sem ninguém apertar "atualizar".
 *
 * Detalhes que importam:
 * - só faz poll com a aba VISÍVEL: portal esquecido aberto num monitor não
 *   fica batendo numa pasta de rede a cada 15s;
 * - checa na hora em que a aba volta ao foco — é exatamente quando a pessoa
 *   volta de uma conversa com alguém que mexeu na pasta;
 * - a PRIMEIRA revisão vista é só linha de base, nunca dispara recarga.
 */
export function useSharedRevision(
  kind: 'skills' | 'agents' | 'knowledge',
  onChange: () => void,
  opts: { intervalMs?: number; enabled?: boolean } = {},
): void {
  const { intervalMs = 15_000, enabled = true } = opts;
  // em ref para o efeito não reiniciar a cada render do callback
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const seenRef = useRef<string>();

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const check = async () => {
      if (!alive || document.hidden) return;
      let revision: SharedRevision;
      try {
        revision = await fetchRevision();
      } catch {
        return; // portal reiniciando ou rede fora: tenta de novo no próximo tick
      }
      if (!alive) return;
      const current = revision[kind];
      // '' = ainda não varreu (ou não há biblioteca): não é mudança
      if (!current) return;
      const previous = seenRef.current;
      seenRef.current = current;
      if (previous !== undefined && previous !== current) changeRef.current();
    };

    void check();
    const timer = setInterval(() => void check(), intervalMs);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [kind, intervalMs, enabled]);
}
