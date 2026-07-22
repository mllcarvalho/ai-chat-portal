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
import { registerKnowledgeRoutes } from './knowledge';
import { registerConfigRoutes } from './config';
import { registerLoginRoutes } from './login';
import { registerBmadRoutes } from './bmad';
import { registerCaptureRoutes } from './capture';
import { registerCopilotRoutes } from './copilot';
import { registerEditorRoutes } from './editor';
import { registerShareRoutes } from './share';
import { registerDiagnosticsRoutes } from './diagnostics';
import { registerCheckpointRoutes } from './checkpoints';

export interface RouteDeps {
  context: vscode.ExtensionContext;
  version: string;
  /** Identifica o build carregado (mtime do bundle); usado na eleição entre janelas. */
  buildId: number;
  /** Encerra o servidor desta janela (chamado quando outra janela assume o portal). */
  requestShutdown: () => void;
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
  registerKnowledgeRoutes(router);
  registerConfigRoutes(router);
  registerLoginRoutes(router);
  registerBmadRoutes(router);
  registerCaptureRoutes(router);
  registerCopilotRoutes(router);
  registerEditorRoutes(router);
  registerShareRoutes(router);
  registerDiagnosticsRoutes(router, deps);
  registerCheckpointRoutes(router);
  return router;
}
