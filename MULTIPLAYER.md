# Modo Colaboração (multiplayer)

O BMAD Product Studio agora é **multiplayer**: o portal de uma pessoa (o *host*) aceita o
squad inteiro pela rede local — cada convidado abre um link no navegador, sem instalar
nada, e trabalha nas mesmas conversas, aprovações e quadro, em tempo real.

**A tese:** o plano de colaboração (estado compartilhado, presença, quadro) fica
centralizado no host; o plano de inferência não muda — a IA continua rodando só na
máquina do host, com a licença Copilot dele, pelo mesmo caminho de sempre (`vscode.lm`).
Nenhuma chave nova, nenhum dado trafegando por rota que já não existisse.

## Como usar

1. **Host:** Configurações → *Colaboração (multiplayer)* → marque *"Aceitar convidados
   pela rede local"*. O servidor religa escutando também na LAN (o endereço aparece ali).
2. **Convites:** ainda na seção, digite o nome de cada pessoa e clique *Convidar* — cada
   uma ganha um **link individual** (`http://IP-do-host:4717/?token=…`). Copie e mande.
3. **Convidado:** abre o link no navegador (mesma rede/VPN). Entra já autenticado, com o
   nome e a cor do convite — sem tela de login, sem VS Code, sem Copilot próprio.
4. **Revogar:** o botão *Revogar* mata o token daquela pessoa na hora. Desligar o modo
   colaboração desliga todos os acessos de uma vez.

## O que funciona em conjunto

- **Chat ao vivo**: quando alguém envia uma mensagem, todo mundo com a conversa aberta
  vê o agente digitando em tempo real (o streaming da extensão sempre foi
  multi-assinante com replay — `streamHub.ts`; o multiplayer só o expôs à rede).
- **Autoria**: em modo colaboração, cada mensagem sai assinada (nome + cor de quem
  enviou) e fica gravada na sessão — auditável depois.
- **Aprovações compartilhadas**: pedidos de aprovação de comando e perguntas do agente
  aparecem para todos; o primeiro que responder resolve, e um aviso conta quem foi.
  O "sempre permitir" (allowlist da máquina do host) só o host pode gravar.
- **Presença**: uma faixa no chat mostra quem mais está naquela conversa; o quadro
  mostra avatares e cursores ao vivo.
- **Quadro do squad**: cada projeto tem um canvas de post-its colaborativo (botão na
  tela do projeto). Pan/zoom, dois cliques cria nota, arrastar move, cores, comentários
  por nota e cursores das outras pessoas. Sincronização por operações com `revision`
  (lacuna → refetch); conflito é resolvido por nota (última escrita vence).
- **Sidebar viva**: sessão criada/renomeada/excluída ou projeto novo por qualquer
  pessoa aparece para todo mundo sem F5 (canal SSE global `/api/events`).

## Modelo de segurança

- **Desligado por padrão.** Sem o modo colaboração, o servidor escuta só em
  `127.0.0.1`, como sempre.
- **Um token por pessoa**, revogável, com identidade. O token do host continua sendo o
  admin. Convidados **não** podem: mexer na config (proxy/rede — que pode conter senha),
  gerenciar convites, configurar MCPs/bibliotecas compartilhadas, rodar login RACF ou
  correções de diagnóstico, ver o contexto do editor do host, nem gravar na allowlist
  de comandos. Tudo isso é barrado no servidor (`isHostOnly` no `httpServer.ts`), não
  só escondido na UI.
- **Anti DNS-rebinding continua**: além de `localhost`, só os IPs reais das interfaces
  da máquina passam no check de `Host`.
- Convidado é **membro do squad**: dentro do que é colaboração (chat, arquivos do
  projeto, quadro, aprovações caso a caso), ele tem os mesmos poderes que uma segunda
  aba do host. Convide quem você convidaria para o refinamento.

## Arquitetura (o que mudou)

| Peça | Papel |
| --- | --- |
| `shared/src/types.ts` | `CollabConfig`/`CollabGuest`/`CollabPeer`, `MessageAuthor`, tipos do quadro (`BoardState`, `BoardOp`) |
| `shared/src/api.ts` | `PortalEvents` (contrato do canal SSE global), `CLIENT_HEADER` |
| `extension/src/events/bus.ts` | Bus interno: storage/chat emitem, o canal SSE repassa |
| `extension/src/server/routes/events.ts` | `GET /api/events` (SSE global + presença), viewing e cursores |
| `extension/src/server/routes/collab.ts` | Status, ligar/desligar, convites (host-only), `GET /api/collab/me` |
| `extension/src/server/routes/board.ts` + `storage/boardStore.ts` | Quadro por projeto (`board.json` em `.aiportal/`) |
| `extension/src/storage/collabStore.ts` | Convites, tokens, identidade por token, IPs da LAN |
| `extension/src/server/httpServer.ts` | Bind `0.0.0.0` no modo colaboração, Host/CORS estendidos, papel por request, rotas host-only |
| `web/src/stores/collabStore.ts` | Conexão com `/api/events`, tradução de eventos → stores, reconexão + resync |
| `web/src/stores/boardStore.ts` + `components/board/BoardView.tsx` | Quadro no cliente |

Correção estrutural que o multiplayer exigiu (e que valia sozinha): o
`PATCH /api/sessions/:id` reescrevia a sessão inteira a partir de uma leitura velha —
podia apagar mensagens gravadas por uma geração concorrente. Agora passa pelo
`updateSession` (releitura+gravação no mesmo tick) e toda gravação de sessão emite
`session_changed`, que é o que mantém as outras abas em dia.

## Limites conhecidos (v1)

- Ligar/desligar o modo colaboração religa o servidor (geração em andamento é
  interrompida — a UI avisa antes).
- O quadro resolve conflito por nota (LWW); duas pessoas digitando na MESMA nota ao
  mesmo tempo: a última que parar vence. Texto co-editado caractere a caractere
  pediria CRDT — não se justifica para post-its.
- Convidado precisa alcançar o IP do host (mesma rede/VPN; firewall do macOS pode
  perguntar na primeira vez).
- Cursores/presença são efêmeros (não persistem, e somem ~6s após a aba fechar).

## Próximo passo desenhado: federação de licenças (fase futura)

A parte mais provocante da tese — "o agente PM roda na máquina da PM, com a licença
dela" — já tem o terreno preparado, sem servidor-a-servidor:

1. Cada convidado que TAMBÉM roda o portal (`npx bmad-product-studio`) tem seu próprio
   servidor em `127.0.0.1` com o próprio Copilot.
2. A **aba do navegador do convidado é a ponte**: servida pelo host (plano de
   colaboração), ela pode falar também com o `127.0.0.1` do próprio convidado (plano de
   inferência). O CORS do portal já aceita requests de outra origem **quando o token
   válido é apresentado** (mudança feita nesta fase exatamente para isso), e o preflight
   OPTIONS responde sempre.
3. Fluxo alvo: a tarefa ("gerar PRD com o agente PM") entra na sessão compartilhada; a
   aba de quem tem aquele papel a pega, executa no portal local dela e streama o
   resultado de volta para a sessão do host — cada chamada disparada e executada pelo
   dono da licença, na máquina dele, com carimbo de autoria.
4. Falta construir: fila de tarefas na sessão, "conectar meu portal local" na UI do
   convidado (colar a URL do comando *Copiar URL do Portal*), e um endpoint no host
   para receber o stream remoto e injetá-lo no `ChatStream` da sessão.
