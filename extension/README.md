# BMAD Product Studio

Chat com os modelos do **GitHub Copilot** direto do navegador — com projetos, sessões, skills, agentes, bases de conhecimento e ferramentas MCP — usando o login que você já tem no VS Code. Sem chave de API, sem custo extra: se a sua conta tem Copilot, você tem o portal.

Tudo roda **local**: a extensão sobe um servidor em `127.0.0.1` (protegido por token) e serve a interface web. O navegador conversa com ela, e ela repassa para o Copilot e para os MCPs do seu VS Code. Nada sai da sua máquina além das chamadas que o próprio Copilot já faz.

## Como usar

1. Instale esta extensão (e a **GitHub Copilot Chat**, se ainda não tiver)
2. `Cmd/Ctrl+Shift+P` → **"BMAD Product Studio: Abrir no Navegador"**
3. Na primeira mensagem, o VS Code pede autorização para a extensão usar o Copilot — clique em **Autorizar**

O portal vive enquanto houver uma janela do VS Code aberta — a extensão é o servidor. Também há um instalador de um comando via `npx`; veja o [repositório](https://github.com/mllcarvalho/ai-chat-portal).

## O que dá pra fazer

- **Chat** com qualquer modelo do Copilot (streaming, markdown, parar geração)
- **Modos** por conversa: **Ask** (pergunta/resposta), **Plan** (gera plano, só leitura) e **Agent** (usa ferramentas automaticamente)
- **Projetos**: cada projeto tem uma pasta em `~/AIChatPortal/projects/<nome>/` — o assistente gera arquivos direto nela
- **Sessões** avulsas ou dentro de projetos, persistidas em disco
- **Skills**: instruções reutilizáveis (ativáveis por conversa) e comandos slash (`/resumir …`)
- **Agentes**: presets de instruções + modelo + modo, exportáveis/importáveis em `.zip` — bom para compartilhar com o time
- **Bases de conhecimento**: documentos que entram como contexto nas conversas; importa arquivos locais ou URLs
- **MCPs**: usa os MCPs já configurados no VS Code, com liga/desliga, e permite registrar servidores extras pela UI

Dados do usuário ficam em `~/AIChatPortal/` (config, sessões, skills, agentes, bases de conhecimento, projetos).

## Requisitos

- [VS Code](https://code.visualstudio.com) com conta GitHub logada e **Copilot habilitado**
- Extensão **GitHub Copilot Chat**

## Suporte

Problemas e sugestões: [github.com/mllcarvalho/ai-chat-portal/issues](https://github.com/mllcarvalho/ai-chat-portal/issues)

---

Feito por **Matheus Llobregat** ([@mllcarvalho](https://github.com/mllcarvalho)).
