# AI Chat Portal

Interface web local para conversar com os modelos do **GitHub Copilot** — com projetos, sessões, skills, agentes e ferramentas MCP — usando o login que você já tem no VS Code.

```
┌─────────────┐   HTTP + SSE    ┌──────────────────────────┐
│  Navegador   │ ◄────────────► │  Extensão VS Code (proxy) │ ──► vscode.lm (Copilot)
│  (React UI)  │   127.0.0.1    │  servidor em 127.0.0.1    │ ──► MCPs do VS Code
└─────────────┘                 └──────────────────────────┘
```

## Requisitos

- **VS Code** com a extensão **GitHub Copilot Chat** e conta GitHub logada (com Copilot habilitado)
- **Node.js 18+**
- Windows ou macOS

## Como usar

```bash
git clone <este-repositorio>
cd ai-chat-portal
npm start
```

O `npm start` faz tudo: instala dependências, builda, instala a extensão no seu VS Code, espera o servidor subir e abre o portal no navegador **já autenticado** com sua conta GitHub do VS Code.

> O portal vive enquanto houver uma janela do VS Code aberta (a extensão é o servidor).

Para reabrir depois: `npm start` de novo (instantâneo) ou, no VS Code, `Cmd/Ctrl+Shift+P` → **"AI Chat Portal: Abrir no Navegador"**.

## O que dá pra fazer

- **Chat** com qualquer modelo do Copilot (streaming, markdown, parar geração)
- **Modos** por conversa: **Ask** (só pergunta/resposta), **Plan** (gera plano, só leitura) e **Agent** (usa ferramentas automaticamente)
- **Projetos**: cada projeto tem uma pasta em `~/AIChatPortal/projects/<nome>/` — o assistente gera arquivos direto nela (`portal_write_file` etc.)
- **Sessões** avulsas ou dentro de projetos, persistidas em disco
- **Skills**: instruções reutilizáveis (ativáveis por conversa) e comandos slash (`/resumir …`)
- **Agentes**: presets de instruções + modelo + modo
- **MCPs**: usa os MCPs já configurados no VS Code e permite registrar servidores extras pela UI

## Estrutura

| Pasta        | O quê                                                              |
| ------------ | ------------------------------------------------------------------ |
| `extension/` | Extensão VS Code: servidor HTTP/SSE, loop agêntico, storage         |
| `web/`       | Interface React (servida pela própria extensão)                     |
| `shared/`    | Tipos TypeScript compartilhados (contrato da API)                   |
| `scripts/`   | `setup.mjs` — o comando único                                       |

Dados do usuário ficam em `~/AIChatPortal/` (config, sessões, skills, agentes, projetos).

## Desenvolvimento

```bash
npm run dev:web   # Vite em http://localhost:5173 com proxy para a extensão
npm run dev:ext   # esbuild em watch (recarregue a janela do VS Code para aplicar)
```

No modo dev, pegue a URL com token pelo comando do VS Code **"AI Chat Portal: Copiar URL do Portal"** e troque a porta para 5173.

## Solução de problemas

- **Tela de checklist (onboarding)** — ela mesma diz o que falta: VS Code fechado, Copilot Chat ausente, conta deslogada ou modelos indisponíveis. Atualiza sozinha a cada 3s.
- **"Confirme a permissão na janela do VS Code"** — na primeira mensagem o VS Code pede autorização para a extensão usar o Copilot; clique em **Autorizar** na notificação.
- **Sem token de acesso** — abra o portal pelo comando "AI Chat Portal: Abrir no Navegador" (a URL carrega o token).
