import { Router, sendJson } from '../router';
import { getBmadStatus, startBmadInstall } from '../../storage/bmadStore';

export function registerBmadRoutes(router: Router): void {
  router.get('/api/bmad', ({ res }) => {
    sendJson(res, 200, getBmadStatus());
  });

  router.post('/api/bmad/install', ({ res }) => {
    sendJson(res, 200, startBmadInstall());
  });
}
