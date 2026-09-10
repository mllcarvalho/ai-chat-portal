import { setToken } from './api/client';
import { consumeServerParams } from './api/server';

/**
 * Primeiro módulo a rodar (é o primeiro import do main.tsx): consome os
 * parâmetros de entrada ANTES de qualquer outro módulo avaliar — a flag de
 * multiplayer, por exemplo, lê "estou num portal hospedado?" na carga.
 *
 * O setup/VS Code abre o portal com ?token=... (e, no portal hospedado, com
 * ?server= ou ?room=); guardamos e limpamos a URL.
 */
const params = new URLSearchParams(window.location.search);
// o servidor vem ANTES do token: o token pertence ao servidor indicado
const consumed = consumeServerParams(params);
const token = params.get('token');
if (token) {
  setToken(token);
  consumed.push('token');
}
if (consumed.length) {
  for (const key of consumed) params.delete(key);
  const query = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
}
