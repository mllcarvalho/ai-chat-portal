import { Router, sendError, sendJson } from '../router';
import { getBmadStatus, startBmadInstall } from '../../storage/bmadStore';
import { scanBmadArtifacts } from '../../storage/bmadArtifacts';
import { getProject, projectDir } from '../../storage/projectStore';

export function registerBmadRoutes(router: Router): void {
  router.get('/api/bmad', ({ res }) => {
    sendJson(res, 200, getBmadStatus());
  });

  router.post('/api/bmad/install', ({ res }) => {
    sendJson(res, 200, startBmadInstall());
  });

  // artefatos BMAD já produzidos no projeto (varre _bmad-output/) — alimenta o
  // progresso visual do deck de ações no chat
  router.get('/api/bmad/artifacts', ({ res, query }) => {
    const projectId = query.get('projectId') ?? '';
    const project = getProject(projectId);
    if (!project) {
      sendError(res, 404, 'Projeto não encontrado');
      return;
    }
    sendJson(res, 200, { artifacts: scanBmadArtifacts(projectDir(project)) });
  });
}
