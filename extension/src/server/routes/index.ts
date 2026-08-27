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
import { registerPortalToolRoutes } from './portalTools';
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
import { registerEventRoutes } from './events';
import { registerCollabRoutes } from './collab';
import { registerBoardRoutes } from './board';

export interface RouteDeps {
  context: vscode.ExtensionContext;
  version: string;
  /** Identifica o build carregado (mtime do bundle); usado na eleição entre janelas. */
  buildId: number;
  /** Encerra o servidor desta janela (chamado quando outra janela assume o portal). */
  requestShutdown: () => void;
  /** Porta em que o servidor está escutando agora (0 = ainda não subiu). */
  getPort: () => number;
  /** Religa o servidor com a config atual (ligar/desligar o modo colaboração muda o bind). */
  requestRestart: () => Promise<void>;
}

export function buildRouter(deps: RouteDeps): Router {
  const router = new Router();
  registerHealthRoutes(router, deps);
  registerAuthRoutes(router, deps);
  registerModelRoutes(router);
  registerChatRoutes(router);
  registerSessionRoutes(router);
  registerProjectRoutes(router);
  registerSkillRoutes(router);
  registerAgentRoutes(router);
  registerToolRoutes(router);
  registerPortalToolRoutes(router);
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
  registerEventRoutes(router);
  registerCollabRoutes(router, deps);
  registerBoardRoutes(router);
  return router;
}
