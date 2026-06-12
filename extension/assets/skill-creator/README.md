# skill-creator (vendorizado)

`SKILL.md` é uma cópia verbatim do [skill-creator da Anthropic](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
(licença Apache-2.0, ver `LICENSE.txt`).

No primeiro start, a extensão semeia o comando global `/criar-skill` com este
conteúdo entre um adaptador (registro via `portal_create_skill`, sem
subagentes/scripts) e o footer com o pedido do usuário — ver
`seedDefaultSkills` em `extension/src/storage/skillStore.ts`.

Para atualizar do upstream: `npm run update-skill-creator` e suba o
`SEED_VERSION` no `skillStore.ts` (é ele que faz o conteúdo novo substituir o
semeado nas máquinas que já rodaram o seed).

Os `scripts/` do skill-creator não são vendorizados: o agente do portal não
executa scripts, então só o SKILL.md é usado.
