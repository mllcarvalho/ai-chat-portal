import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Router, sendError, sendJson } from '../router';
import { exportSkillFile } from '../../storage/skillZip';
import {
  createSkill,
  deleteSkill,
  deleteSkillAsset,
  getSkill,
  listAllSkills,
  listSkills,
  skillFolderPath,
  updateSkill,
  writeSkillAsset,
} from '../../storage/skillStore';

/** Teto por anexo de skill (o body inteiro já é limitado a 10 MB pelo router). */
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

export function registerSkillRoutes(router: Router): void {
  // Sem projectId devolve o catálogo completo (globais + todos os projetos);
  // com projectId, apenas globais + as daquele projeto.
  router.get('/api/skills', ({ res, query }) => {
    const projectId = query.get('projectId') || undefined;
    sendJson(res, 200, projectId ? listSkills(projectId) : listAllSkills());
  });

  // download da skill: .md simples, ou .skill.zip quando ela tem anexos
  router.get('/api/skills/:id/export', async ({ res, params }) => {
    const file = await exportSkillFile(params.id);
    if (!file) {
      sendError(res, 404, 'Skill não encontrada');
      return;
    }
    res.writeHead(200, {
      'Content-Type': file.contentType,
      'Content-Length': file.data.length,
      'Content-Disposition': `attachment; filename="${file.fileName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
    res.end(file.data);
  });

  router.get('/api/skills/:id', ({ res, params }) => {
    const skill = getSkill(params.id);
    if (!skill) {
      sendError(res, 404, 'Skill não encontrada');
      return;
    }
    sendJson(res, 200, skill);
  });

  router.post('/api/skills', ({ res, body }) => {
    const input = (body ?? {}) as {
      scope?: 'global' | 'project';
      projectId?: string;
      name?: string;
      description?: string;
      command?: string;
      content?: string;
    };
    if (!input.name?.trim() || !input.scope) {
      sendError(res, 400, 'name e scope são obrigatórios');
      return;
    }
    if (input.scope === 'project' && !input.projectId) {
      sendError(res, 400, 'Skills de projeto precisam de projectId');
      return;
    }
    const skill = createSkill({
      scope: input.scope,
      projectId: input.projectId,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      command: input.command?.trim().replace(/^\//, '') || undefined,
      content: input.content ?? '',
    });
    if (!skill) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 201, skill);
  });

  router.patch('/api/skills/:id', ({ res, params, body }) => {
    const patch = (body ?? {}) as {
      name?: string;
      description?: string;
      command?: string;
      content?: string;
    };
    if (patch.command) patch.command = patch.command.trim().replace(/^\//, '');
    const updated = updateSkill(params.id, patch);
    if (!updated) {
      sendError(res, 404, 'Skill não encontrada');
      return;
    }
    sendJson(res, 200, updated);
  });

  router.delete('/api/skills/:id', ({ res, params }) => {
    const ok = deleteSkill(params.id);
    sendJson(res, ok ? 200 : 404, { ok });
  });

  // abre a pasta da skill no gerenciador do sistema (Finder/Explorer/…);
  // revela o SKILL.md para o gerenciador já abrir dentro da pasta certa
  router.post('/api/skills/:id/reveal', async ({ res, params }) => {
    const folder = skillFolderPath(params.id);
    if (!folder) {
      sendError(res, 404, 'Skill não encontrada');
      return;
    }
    try {
      const skillMd = path.join(folder, 'SKILL.md');
      const target = fs.existsSync(skillMd) ? skillMd : folder;
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'Erro ao abrir a pasta');
    }
  });

  // --- anexos da pasta da skill (referências, templates…) --------------------

  router.post('/api/skills/:id/files', ({ res, params, body }) => {
    const input = (body ?? {}) as { path?: string; contentBase64?: string };
    if (!input.path?.trim() || typeof input.contentBase64 !== 'string') {
      sendError(res, 400, 'path e contentBase64 são obrigatórios');
      return;
    }
    const data = Buffer.from(input.contentBase64, 'base64');
    if (data.length > MAX_ASSET_BYTES) {
      sendError(res, 400, `Anexo excede o limite de ${MAX_ASSET_BYTES / (1024 * 1024)} MB`);
      return;
    }
    const ok = writeSkillAsset(params.id, input.path.trim(), data);
    if (!ok) {
      sendError(res, 400, 'Skill não encontrada ou caminho inválido');
      return;
    }
    sendJson(res, 200, getSkill(params.id));
  });

  router.post('/api/skills/:id/files/delete', ({ res, params, body }) => {
    const input = (body ?? {}) as { path?: string };
    if (!input.path?.trim()) {
      sendError(res, 400, 'path é obrigatório');
      return;
    }
    const ok = deleteSkillAsset(params.id, input.path.trim());
    if (!ok) {
      sendError(res, 404, 'Anexo não encontrado');
      return;
    }
    sendJson(res, 200, getSkill(params.id));
  });
}
