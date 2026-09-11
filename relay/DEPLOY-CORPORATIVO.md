# Checklist: subir o portal hospedado no ambiente corporativo

O que precisa existir na AWS da empresa, esteira por esteira, e o que fica
fora da AWS. Contexto e arquitetura estão em `../PORTAL-HOSPEDADO.md`; a stack
de teste (`aws/stack.yaml`) é a referência de propriedades, mas é a versão
pública — os pontos que mudam aqui estão marcados nela com `EMPRESA:`.

Resumo do que sobe: **um container** (o relay, com a UI dentro), **um ALB
interno** e **um CloudFront**. Sem banco, sem S3, sem segredo, sem variável de
ambiente obrigatória. O relay não faz nenhuma chamada de saída.

---

## 1. Antes do build (no repo clonado lá)

- [ ] **Preencher `scripts/bootstrap-itau.sh`** (bloco `CONFIG — PREENCHA`):
      `PROXY_HOST`, `NO_PROXY_LIST`, `REGISTRY_URL`, CA. Esse script vai
      dentro da imagem em `/bootstrap.sh` e embutido em `/setup.html`.
- [ ] **Regerar a página de setup** depois de mexer no bootstrap:
      `node scripts/build-setup-page.mjs` (ela embute o script; sem isso a
      cópia dentro do HTML fica velha).
- [ ] **Dependência fora do npm:** `web/package.json` e `extension/package.json`
      puxam o `xlsx` de `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
      A esteira precisa de saída para esse host, ou o tarball espelhado no
      Artifactory com o `package.json` apontando para lá.
- [ ] Node 18+ no agente de build (22 recomendado; a imagem usa `node:22-alpine`).

## 2. Esteira da imagem (ECR)

Contexto do `docker build` é a **raiz do repo** (o `.dockerignore` da raiz só
deixa passar os artefatos).

```bash
npm ci
npm run build -w @aiportal/web        # web/dist
npm run build -w @aiportal/relay      # relay/dist/server.cjs (bundle único)
docker build -f relay/Dockerfile -t <conta>.dkr.ecr.<região>.amazonaws.com/portal-relay:<tag> .
docker push …
```

| Item | Valor |
| --- | --- |
| Base | `node:22-alpine`, roda como `node` (não root) |
| Porta | 8787 |
| Env | `PORT=8787`, `RELAY_STATIC_DIR=/app/web` (já no Dockerfile; nada a passar) |
| Env opcional | `RELAY_SETUP_URL=https://…/instalacao.html` — página de instalação da empresa (GitHub Pages); a tela de boas-vindas aponta para ela em vez do `/setup.html` embutido |
| Health | `GET /relay/health` → `{"ok":true,"rooms":N}` |
| Logs | stdout (`[relay] …`) |
| Arquitetura | x86_64 (buildar com `--platform linux/amd64` se o agente for ARM) |

## 3. Esteira ECS

| Item | Valor |
| --- | --- |
| Launch type | Fargate, 0,25 vCPU / 512 MB |
| Tasks | **1** (`desired 1`, deployment `max 100% / min 0%`) — as salas ficam em memória; duas tasks separariam host e convidado. Para escalar, entra Redis pub/sub entre elas |
| Container port | 8787 |
| Target group | tipo `ip`, HTTP 8787, health `/relay/health` a cada 15s, deregistration 10s |
| Rede | subnets privadas, sem IP público; saída só para puxar a imagem (NAT ou VPC endpoints do ECR + logs) |
| SG da task | 8787 apenas do SG do ALB |
| Segredos / env | nenhum obrigatório; `RELAY_SETUP_URL` se a página de instalação for a do GitHub Pages |

## 4. ALB (interno)

| Item | Valor |
| --- | --- |
| Scheme | `internal` |
| Listener | 443, certificado corporativo |
| Idle timeout | ≥ 300s (WebSocket da aba do host e SSE do chat; o relay faz ping a cada 20s) |
| Ação padrão | `authenticate-oidc` (IdP corporativo) → `forward` para o target group |
| SG | 443 apenas do que o CloudFront usa para chegar (SG do VPC origin) |

Sobre o `authenticate-oidc`:

- o **client id/secret do IdP ficam no listener do ALB**, nunca na extensão
  nem no bundle;
- a callback é `https://portal.empresa/oauth2/idpresponse` (o domínio do
  CloudFront, registrada no app do IdP);
- para o ALB montar essa callback com o host certo, o CloudFront precisa
  **repassar o header `Host` do viewer** (política de origin request
  `AllViewer`, não a `AllViewerExceptHostHeader` da stack de teste);
- a rota do health do target group não passa pelo listener, então o OIDC não
  atrapalha o health check;
- se a esteira de CloudFront da empresa já tem um padrão de autenticação
  (Lambda@Edge, por exemplo), use ele no lugar e deixe o listener só com o
  `forward`. Tanto faz para o portal: a autorização de verdade (quem é host,
  quem é convidado) continua na extensão, pelos tokens.

## 5. Esteira CloudFront

| Item | Valor |
| --- | --- |
| Origin | o ALB interno, via **VPC origin**, HTTPS 443 |
| Origin read/keepalive timeout | 60s |
| Domínio | `portal.empresa` + certificado ACM (us-east-1) + DNS interno apontando para a distribuição |
| Acesso | só interno (o padrão que a empresa usa para CloudFront interno: WAF/allowlist, prefix list, DNS privado) |
| Viewer protocol | redirect-to-https |

Behaviors (dois, mesmo origin):

| Path | Cache policy | Origin request | Métodos | Compress |
| --- | --- | --- | --- | --- |
| `/relay/*` | `CachingDisabled` | `AllViewer` | GET HEAD OPTIONS PUT POST PATCH DELETE | não |
| padrão (`*`) | `UseOriginCacheControlHeaders` | `AllViewer` | GET HEAD OPTIONS | sim |

O relay já manda `Cache-Control: no-cache` no `index.html` e 1h nos assets
(que têm hash no nome), por isso a política que respeita o origin. Se a esteira
só oferece `CachingDisabled`, serve também. WebSocket passa nativo no
CloudFront; só não pode haver cache no `/relay/*`.

## 6. Fora da AWS

- [ ] **Domínio final** decidido antes de tudo: `https://portal.empresa` (só
      esquema + host, sem caminho). Ele entra em três lugares: na setting da
      extensão, no `--portal` do instalador e na callback do IdP.
- [ ] **Extensão ≥ 0.5.2** disponível para as máquinas (Marketplace ou o
      `.vsix` embutido no instalador). É a partir dela que existe o modo
      hospedado e o `/api/health` aberto a qualquer origem, que a tela de
      boas-vindas usa.
- [ ] **Instalador ≥ 0.5.2** no npm/Artifactory (`bmad-product-studio` ou
      `-beta`) — é o que tem `--portal`.
- [ ] **Apontar a extensão para o domínio**, de um destes jeitos:
      - política do VS Code: setting `aiChatPortal.hostedPortalUrl` =
        `https://portal.empresa` (vale para todo mundo, ganha do config);
      - ou cada pessoa roda uma vez `npx <instalador>@latest --portal https://portal.empresa`
        (é o comando que a tela de boas-vindas e o `/setup.html` mostram).
- [ ] **App no IdP** para o `authenticate-oidc` (se for esse o padrão).

## 7. Validação depois do deploy

1. `https://portal.empresa/relay/health` (após o SSO) responde `{"ok":true}`.
2. `https://portal.empresa/` aberto "seco" mostra a tela de boas-vindas; sem
   VS Code aberto ela lista os três passos e o `/setup.html` abre.
3. Com a extensão apontada para o domínio, "Abrir no Navegador" no VS Code
   abre `https://portal.empresa/?server=http://127.0.0.1:4717&token=…` e o
   chat funciona. O Chrome pede permissão de "acesso à rede local" uma vez.
4. Configurações → Colaboração → ligar. A linha "Ponte com o portal
   hospedado" mostra *conectada nesta aba* e o health passa a `rooms: 1`.
5. Link de convite `https://portal.empresa/?room=…&token=…` aberto por outra
   pessoa (ou janela anônima) entra e conversa em tempo real.

## O que NÃO precisa

Banco, S3, fila, Redis (com uma task), segredos no container, variáveis de
ambiente, acesso de saída do relay, Bedrock ou qualquer chave de modelo. A
inferência continua no Copilot de cada máquina; nenhum dado de conversa
fica na AWS.
