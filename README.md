# AI Product BMAD Chat

Chat com os modelos do **GitHub Copilot** direto do navegador — com projetos, sessões, skills, agentes, bases de conhecimento e ferramentas MCP — usando o login que você já tem no VS Code. Sem chave de API, sem custo extra: se a sua conta tem Copilot, você tem o portal.

```
┌─────────────┐   HTTP + SSE    ┌──────────────────────────┐
│  Navegador   │ ◄────────────► │  Extensão VS Code (proxy) │ ──► vscode.lm (Copilot)
│  (React UI)  │   127.0.0.1    │  servidor em 127.0.0.1    │ ──► MCPs do VS Code
└─────────────┘                 └──────────────────────────┘
```

Tudo roda **local**: a extensão sobe um servidor em `127.0.0.1` (protegido por token) e serve a interface web. O navegador conversa com ela, e ela repassa para o Copilot e para os MCPs do seu VS Code.

## Instalação — um comando

```bash
npx ai-product-bmad-chat
```

Pronto. O comando:

1. Instala a extensão no seu VS Code (e o GitHub Copilot Chat, se faltar)
2. Abre uma janela do VS Code para ativar o servidor local
3. Abre o portal no navegador, **já autenticado** com a sua conta GitHub do VS Code

**Pré-requisitos:** [VS Code](https://code.visualstudio.com) com conta GitHub logada (Copilot habilitado) e [Node.js 18+](https://nodejs.org). Windows ou macOS.

> O portal vive enquanto houver uma janela do VS Code aberta — a extensão é o servidor.

- **Reabrir depois:** rode o comando de novo (instantâneo) ou, no VS Code, `Cmd/Ctrl+Shift+P` → **"AI Product BMAD Chat: Abrir no Navegador"**
- **Atualizar:** `npx ai-product-bmad-chat@latest`
- **Primeira mensagem:** o VS Code mostra uma notificação pedindo autorização para usar o Copilot — clique em **Autorizar**

## O que dá pra fazer

- **Chat** com qualquer modelo do Copilot (streaming, markdown, parar geração)
- **Modos** por conversa: **Ask** (só pergunta/resposta), **Plan** (gera plano, só leitura) e **Agent** (usa ferramentas automaticamente)
- **Projetos**: cada projeto tem uma pasta em `~/AIChatPortal/projects/<nome>/` — o assistente gera arquivos direto nela (`portal_write_file` etc.)
- **Sessões** avulsas ou dentro de projetos, persistidas em disco
- **Skills**: instruções reutilizáveis (ativáveis por conversa) e comandos slash (`/resumir …`)
- **Agentes**: presets de instruções + modelo + modo, **exportáveis/importáveis em `.zip`** (levam junto skills e base de conhecimento) — bom para compartilhar com o time
- **Bases de conhecimento**: documentos que entram como contexto nas conversas; importa arquivos locais ou **URLs** (a página vira Markdown automaticamente), e também exporta/importa em `.zip`
- **MCPs**: usa os MCPs já configurados no VS Code (incluindo os do projeto em `.vscode/mcp.json`, com liga/desliga) e permite registrar servidores extras pela UI

Dados do usuário ficam em `~/AIChatPortal/` (config, sessões, skills, agentes, bases de conhecimento, projetos).

## Estrutura do repositório

| Pasta        | O quê                                                               |
| ------------ | ------------------------------------------------------------------- |
| `extension/` | Extensão VS Code: servidor HTTP/SSE, loop agêntico, storage          |
| `web/`       | Interface React (servida pela própria extensão)                      |
| `shared/`    | Tipos TypeScript compartilhados (contrato da API)                    |
| `installer/` | Pacote npm `ai-product-bmad-chat` — o instalador de um comando (npx) |
| `scripts/`   | `setup.mjs` (dev), `release.mjs` (publicação no npm)                 |

## Desenvolvimento

Rodando do código-fonte (em vez do npx):

```bash
git clone https://github.com/mllcarvalho/ai-chat-portal.git
cd ai-chat-portal
npm start
```

O `npm start` instala dependências, builda tudo, empacota e instala a extensão, espera o servidor subir e abre o portal — o mesmo fluxo do instalador npx, só que a partir do código.

Modo watch:

```bash
npm run dev:web   # Vite em http://localhost:5173 com proxy para a extensão
npm run dev:ext   # esbuild em watch (recarregue a janela do VS Code para aplicar)
```

No modo dev, pegue a URL com token pelo comando do VS Code **"AI Product BMAD Chat: Copiar URL do Portal"** e troque a porta para 5173.

### Publicando uma versão nova

```bash
# 1. suba a "version" em extension/package.json (ex.: 0.2.0 → 0.3.0)
# 2. publique (precisa de npm login, uma vez só):
npm run release
```

O `release.mjs` builda tudo, gera o `.vsix`, embute no pacote `installer/` (sincronizando a versão) e publica no npm. Quem usa pega a nova versão com `npx ai-product-bmad-chat@latest`.

## Solução de problemas

- **Tela de checklist (onboarding)** — ela mesma diz o que falta: VS Code fechado, Copilot Chat ausente, conta deslogada ou modelos indisponíveis. Atualiza sozinha a cada 3s.
- **"Confirme a permissão na janela do VS Code"** — na primeira mensagem o VS Code pede autorização para a extensão usar o Copilot; clique em **Autorizar** na notificação.
- **Sem token de acesso** — abra o portal pelo comando "AI Product BMAD Chat: Abrir no Navegador" (a URL carrega o token).
- **`npx` não encontrado** — instale o Node.js 18+ em <https://nodejs.org> (o npx vem junto).
- **"Node.js X é antigo demais"** — o instalador exige **Node 18+**. Confira com `node --version` e atualize pela versão LTS em <https://nodejs.org> (no Windows, dá pra usar o [nvm-windows](https://github.com/coreybutler/nvm-windows) se precisar manter várias versões). Depois rode o comando de novo.

---

Feito por **Matheus Llobregat** ([@mllcarvalho](https://github.com/mllcarvalho)).
