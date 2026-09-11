# Portal hospedado (UI no CloudFront/S3 + relay)

Modo para a empresa publicar a **interface** do portal num endereço próprio
(`https://portal.empresa.com`) sem mudar onde a coisa acontece: a **extensão do VS
Code continua sendo o servidor** na máquina de cada pessoa — Copilot, MCPs,
arquivos e sessões seguem 100% locais. Nada disso sobe para a nuvem.

**Desligado por padrão.** Quem instala pelo `npx` e roda local não percebe nada:
a extensão continua servindo a UI em `127.0.0.1`, e a UI continua chamando a API
na mesma origem. Todo o modo hospedado só entra quando a página chega com
`?server=` ou `?room=` na URL.

## Como fica

```
                    https://portal.empresa.com
                              │
                          CloudFront
                 ┌────────────┴────────────┐
           behavior padrão            /relay/*
                 │                         │
            S3 (web/dist)          ALB (interno, OIDC) ──► ECS Fargate: relay/
                                                              │  WebSocket
                                                     aba do HOST (ponte)
                                                              │  http://127.0.0.1:4717
                                                     extensão do host ──► Copilot, MCPs, disco
```

- **Uso solo:** a pessoa abre `https://portal.empresa.com/?server=http://127.0.0.1:4717&token=…`
  (é o que "Abrir no Navegador" e o instalador passam a abrir). A página HTTPS
  chama a extensão local direto — loopback é origem confiável para o browser.
  Não passa pelo relay.
- **Multiplayer:** o convidado abre `https://portal.empresa.com/?room=<sala>&token=<convite>`.
  As chamadas dele vão para `/relay/<sala>/api/...`; o relay repassa, por
  WebSocket, para a **aba do host**, que repete cada request contra a extensão
  local e devolve a resposta em stream. É a mesma ideia da federação de
  licenças (`lmBridge.ts`): a aba é a ponte, e nenhuma credencial vai para a
  extensão nem para o bundle.
- **Federação de licenças** continua igual: a aba do executor fala com o
  `127.0.0.1` da própria máquina.

Por que não chamar o IP do host direto da página hospedada: uma página HTTPS
não pode chamar `http://192.168.x.x` (mixed content) e uma página HTTP pública
não pode chamar rede privada (Private Network Access). Só loopback passa. O
relay existe para contornar exatamente isso, e de quebra funciona entre redes
segmentadas/VPN.

## O que o relay é (e não é)

`relay/` — um Node pequeno (`node:http` + `ws`), sem banco, sem disco, sem
modelo. Salas em memória: `id da sala → WebSocket da aba do host`. O id da sala
é `sha256(chave)` truncado; a chave é gerada pela extensão do host e só chega à
aba dele (rota host-only). O relay confere o hash e pronto — sem registro.

| Rota | Quem | O quê |
| --- | --- | --- |
| `WS /relay/:sala/host?key=…` | aba do host | a ponte (uma por host; outra aba assume se esta fechar) |
| `ANY /relay/:sala/api/*` | convidado | request encaminhado; resposta em stream |
| `GET /relay/health` | ALB | target group |

Ping de WebSocket a cada 20s parte do **relay** (abas em segundo plano têm
timers estrangulados, mas respondem ping sem JavaScript). Autorização de
verdade continua na extensão: o header `X-Portal-Token` do convidado é
repassado como veio, e o `isHostOnly` do `httpServer.ts` decide o que ele pode.

Se a task reiniciar, os hosts reconectam e as salas se refazem. Mais de uma
task exige um pub/sub entre elas (Redis) — comece com uma.

## Configuração

**Na extensão (cada máquina):** informe a URL do portal hospedado de um destes
jeitos — o primeiro tem precedência:

1. configuração do VS Code `aiChatPortal.hostedPortalUrl` (política corporativa);
2. tela de configurações do portal → *Rede corporativa* → *Portal hospedado*
   (grava `hostedPortalUrl` no `~/AIChatPortal/config.json`).

Com isso, "Abrir no Navegador", "Copiar URL do Portal" e o instalador abrem a
URL da empresa com `?server=` e `?token=`, e a origem entra no CORS da
extensão. Vazio = comportamento de sempre.

**Multiplayer pelo relay:** o host liga a colaboração como hoje. Na tela de
convites, com a UI hospedada, o primeiro endereço sugerido passa a ser
`https://portal.empresa.com/?room=<sala>` e os links de convite saem nesse
formato. Uma linha mostra o estado da ponte (*conectada nesta aba* / *outra aba
sua é a ponte*).

**No CloudFront:**

- origin S3 (bucket privado, OAC) no behavior padrão, servindo `web/dist`;
- origin ALB (de preferência *VPC origin*, ALB interno) no behavior `/relay/*`:
  cache `CachingDisabled`, origin request `AllViewer`, todos os métodos.
  WebSocket passa nativo;
- timeouts: o *origin response timeout* do CloudFront é tempo ocioso entre bytes
  (máx. 60s sem quota); o idle do ALB pode subir. Com o ping de 20s do relay,
  ambos ficam folgados;
- autenticação dos convidados no listener do ALB (`authenticate-oidc` com o IdP
  da empresa) — zero código, e sem client secret em lugar nenhum.

## Subindo no ambiente corporativo

Checklist esteira por esteira (imagem, ECS, ALB interno com OIDC, CloudFront
interno, o que fica fora da AWS e a validação): `relay/DEPLOY-CORPORATIVO.md`.

## Onboarding: quem abre o link sem ter nada instalado

O link da empresa sozinho não instala nada — a extensão continua sendo
instalada na máquina de cada pessoa. O que o portal hospedado faz é guiar:

- **Link aberto "seco"** (sem `?server=`/`?room=`): a UI mostra a tela de
  boas-vindas (`HostedWelcome.tsx`). Ela sonda `127.0.0.1:4717-4727` a cada
  5s (o `/api/health` da extensão é aberto a qualquer origem, só versão e
  estado dos motores) e reage:
  - nada rodando → passo a passo: VS Code + Node, o setup corporativo em
    `/setup.html` (a página `scripts/setup-itau.html`, com o bootstrap
    embutido para download; o script também sai em `/bootstrap.sh`), e o
    comando `npx <instalador>@latest --portal https://portal.empresa.com`;
  - extensão atrasada em relação à UI → comando de atualizar (a UI hospedada
    é sempre a mais nova; a versão da extensão entra no build via
    `__PORTAL_VERSION__`);
  - extensão atual → como entrar autenticado ("Abrir no Navegador" no VS Code).
- **`npx … --portal <url>`** grava `hostedPortalUrl` no `~/AIChatPortal/config.json`
  (antes mesmo da primeira ativação — a extensão preserva o config parcial e só
  completa o token), instala/atualiza a extensão, sobe o VS Code e abre o portal
  já pelo link da empresa com `?server=` e `?token=`. A página `/setup.html`,
  quando servida pelo portal, já mostra o comando com `--portal`.
- **Dentro do portal**, se a extensão local estiver atrás da UI, o banner de
  atualização de sempre aparece com esse mesmo comando.

## Variante: tudo no ECS, sem S3

O relay também serve a interface (`RELAY_STATIC_DIR`), então um container só
resolve os dois papéis — é o que o `relay/Dockerfile` faz por padrão: copia o
`web/dist` para dentro da imagem e liga a variável. O CloudFront fica com um
origin só (o ALB):

```
https://portal.empresa.com → CloudFront → ALB (OIDC) → ECS: relay (UI + /relay/*)
```

- behavior `/relay/*`: `CachingDisabled` + `AllViewer` (streaming e WebSocket);
- behavior padrão: política de cache que respeita o `Cache-Control` do origin
  (`UseOriginCacheControlHeaders`) — o relay manda `no-cache` no `index.html` e
  1h nos assets, que têm hash no nome. Ou `CachingDisabled` em tudo, que para
  esse tamanho de UI não faz diferença.

Trocar para S3 depois é só publicar o `web/dist` no bucket, apontar o behavior
padrão para ele e subir o container com `RELAY_STATIC_DIR` vazio.

Build da imagem, da raiz do repo:

```bash
npm run build -w @aiportal/web && npm run build:relay
docker build -f relay/Dockerfile -t portal-relay .
docker run -p 8787:8787 portal-relay
```

## Subindo numa conta AWS de teste

`relay/aws/` tem uma stack CloudFormation mínima (ECS Fargate + ALB + CloudFront
na VPC default) e um script que builda, publica no ECR e faz o deploy:

```bash
AWS_REGION=us-east-1 relay/aws/deploy.sh
```

Ao final ele imprime `PortalUrl` (o domínio `*.cloudfront.net`, já em HTTPS).
Coloque esse valor em `aiChatPortal.hostedPortalUrl` no VS Code e use "Abrir no
Navegador". Para derrubar: `aws cloudformation delete-stack --stack-name portal-relay`.

É a versão de teste: ALB e CloudFront públicos, sem OIDC. Os pontos que mudam
na empresa (ALB interno, VPC origin, listener 443 com `authenticate-oidc`,
task sem IP público) estão marcados com `EMPRESA:` no `stack.yaml`.

## Rodando local (sem AWS)

```bash
npm run build -w @aiportal/web          # gera web/dist
npm run build:relay                     # gera relay/dist/server.cjs
RELAY_STATIC_DIR=$PWD/web/dist PORT=8787 npm run -w @aiportal/relay start
```

(Caminho absoluto de propósito: o `npm run -w` executa dentro de `relay/`, e um
caminho relativo apontaria para `relay/web/dist`.)

O relay serve a UI em `http://localhost:8787` (localhost é contexto seguro:
mesmo comportamento da página HTTPS). Então:

1. **Solo:** abra `http://localhost:8787/?server=http://127.0.0.1:4717&token=<token>`
   (o token está na URL do comando "Copiar URL do Portal").
2. **Multiplayer:** nessa aba, ligue a colaboração, convide alguém e copie o
   link `http://localhost:8787/?room=…&token=…`. Abra numa janela anônima: é o
   convidado, passando pelo relay e pela sua aba.

Variáveis do relay: `PORT`, `RELAY_STATIC_DIR` (opcional), `RELAY_CORS_ORIGINS`
(dev com Vite em `:5173`), `RELAY_SETUP_URL` (página de instalação da empresa,
ex.: o `instalacao.html` do GitHub Pages, no lugar do `/setup.html` embutido).

Imagem Docker: ver a variante "tudo no ECS" acima.

## Onde está no código

| Peça | Papel |
| --- | --- |
| `shared/src/relay.ts` | Contrato: caminhos, envelopes `RelayToHostMessage`/`HostToRelayMessage`, headers repassados |
| `web/src/api/server.ts` | Base da API da UI: mesma origem (padrão), `?server=` (solo hospedado) ou `?room=` (convidado pelo relay) |
| `web/src/api/relayBridge.ts` | A ponte na aba do host: WebSocket com o relay, repete requests contra `127.0.0.1`, Web Lock para uma aba só |
| `web/src/api/client.ts`, `events.ts`, `sseChat.ts` | Chamadas prefixadas com `apiUrl()`; failover de porta atualiza a base em vez de redirecionar |
| `extension/src/storage/hostedPortal.ts` | Lê a URL hospedada (setting do VS Code → config.json) e monta a URL com `?server=` |
| `extension/src/server/httpServer.ts` | Origem hospedada liberada no CORS |
| `extension/src/storage/collabStore.ts` + `routes/collab.ts` | Chave da sala (`relayKey`) e `relay: { roomId, key }` no status (host-only) |
| `relay/src/server.ts` | O serviço |
