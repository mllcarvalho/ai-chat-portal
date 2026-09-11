# bmad-product-studio

Chat com os modelos do **GitHub Copilot** no navegador — com projetos, sessões, skills, agentes e ferramentas MCP — usando o login que você já tem no VS Code.

## Instalação

```bash
npx bmad-product-studio
```

Um comando: instala a extensão no seu VS Code, espera o servidor local subir e abre o portal no navegador **já autenticado** com sua conta GitHub do VS Code.

**Pré-requisitos:** [VS Code](https://code.visualstudio.com) com conta GitHub (Copilot habilitado) e [Node.js 18+](https://nodejs.org).

> O portal vive enquanto houver uma janela do VS Code aberta (a extensão é o servidor).

## Atualizar

```bash
npx bmad-product-studio@latest
```

## Portal hospedado pela empresa

Se a sua empresa publica a interface num endereço próprio, passe a URL uma vez:

```bash
npx bmad-product-studio --portal https://portal.empresa.com
```

A extensão continua rodando na sua máquina; só a interface vem do endereço da empresa. "Abrir no Navegador" passa a abrir por lá.

## Reabrir depois

Rode o comando de novo (instantâneo) — ou, no VS Code, `Cmd/Ctrl+Shift+P` → **"BMAD Product Studio: Abrir no Navegador"**.

---

Feito por **Matheus Llobregat** ([@mllcarvalho](https://github.com/mllcarvalho)) · Código-fonte: <https://github.com/mllcarvalho/ai-chat-portal>
