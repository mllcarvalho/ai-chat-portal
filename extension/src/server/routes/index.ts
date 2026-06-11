import * as vscode from 'vscode';
import { Router } from '../router';
import { registerHealthRoutes } from './health';
import { registerAuthRoutes } from './auth';
import { registerModelRoutes } from './models';
import { registerChatRoutes } from './chat';
import { registerSessionRoutes } from './sessions';
import { registerProjectRoutes } from './projects';
import { registerSkillRoutes } from './skills';
import { registerAgentRoutes } from './agents';
import { registerToolRoutes } from './tools';
import { registerConfigRoutes } from './config';

export interface RouteDeps {
  context: vscode.ExtensionContext;
  version: string;
}

export function buildRouter(deps: RouteDeps): Router {
  const router = new Router();
  registerHealthRoutes(router, deps);
  registerAuthRoutes(router, deps);
  registerModelRoutes(router, deps);
  registerChatRoutes(router);
  registerSessionRoutes(router);
  registerProjectRoutes(router);
  registerSkillRoutes(router);
  registerAgentRoutes(router);
  registerToolRoutes(router);
  registerConfigRoutes(router);
  return router;
}
