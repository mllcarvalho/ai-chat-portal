import { Router, sendError, sendJson } from '../router';
import { getConfig, patchConfig } from '../../storage/configStore';

export function registerConfigRoutes(router: Router): void {
  router.get('/api/config', ({ res }) => {
    const { token: _token, ...safe } = getConfig();
    sendJson(res, 200, safe);
  });

  router.patch('/api/config', ({ res, body }) => {
    const patch = (body ?? {}) as {
      projectsRoot?: string;
      network?: { httpsProxy?: string; noProxy?: string; extraCaCerts?: string };
    };
    if (patch.projectsRoot !== undefined && !patch.projectsRoot.trim()) {
      sendError(res, 400, 'projectsRoot não pode ser vazio');
      return;
    }
    const network =
      patch.network !== undefined
        ? {
            httpsProxy: patch.network.httpsProxy?.trim() || undefined,
            noProxy: patch.network.noProxy?.trim() || undefined,
            extraCaCerts: patch.network.extraCaCerts?.trim() || undefined,
          }
        : undefined;
    const updated = patchConfig({
      ...(patch.projectsRoot ? { projectsRoot: patch.projectsRoot.trim() } : {}),
      ...(network ? { network } : {}),
    });
    const { token: _token, ...safe } = updated;
    sendJson(res, 200, safe);
  });
}
