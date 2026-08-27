import * as vscode from 'vscode';
import type { LmChunk, LmRunRequest, LmToolDef } from '@aiportal/shared';
import { Router, sendError, sendJson } from '../router';
import { SseStream } from '../sse';
import { deserializeMessages } from '../../chat/providers/lmWire';
import { feedJob } from '../../chat/lmBridge';
import { creditsRemaining } from './copilot';
import { withTimeout } from '../../util';

/**
 * Rotas da federação de licenças.
 *
 * - POST /api/lm/run: roda UMA requisição de modelo no Copilot DESTA máquina e
 *   devolve o stream (SSE). É o que o portal LOCAL do convidado expõe para a
 *   própria aba dele — a inferência na licença de quem executa.
 * - POST /api/lm/:jobId/chunk: o HOST recebe de volta os pedaços (a aba do
 *   executor relaia o que leu do /run) e injeta no job da ponte.
 */

const NO_MODELS: readonly vscode.LanguageModelChat[] = [];

async function pickModel(modelId?: string): Promise<vscode.LanguageModelChat | undefined> {
  const models = await withTimeout(
    vscode.lm.selectChatModels({ vendor: 'copilot' }),
    10000,
    NO_MODELS,
  );
  if (!models.length) return undefined;
  return models.find((m) => m.id === modelId) ?? models[0];
}

export function registerLmRoutes(router: Router): void {
  // executor: roda no Copilot desta máquina e streama de volta
  router.post('/api/lm/run', async ({ res, body, req }) => {
    const { messages, tools, modelId } = (body ?? {}) as Partial<LmRunRequest>;
    if (!Array.isArray(messages)) {
      sendError(res, 400, 'messages é obrigatório');
      return;
    }
    const sse = new SseStream(res);
    const cts = new vscode.CancellationTokenSource();
    // a aba relaia; se ela desconecta (host cancelou → lm_cancel → abort), para
    sse.onClose(() => cts.cancel());

    const send = (chunk: LmChunk) => sse.send('chunk', chunk);
    try {
      const model = await pickModel(modelId);
      if (!model) {
        send({ type: 'error', message: 'Nenhum modelo do Copilot disponível nesta máquina.', code: 'model_not_found' });
        sse.close();
        return;
      }
      const creditsBefore = creditsRemaining();
      const toolDefs = (Array.isArray(tools) ? tools : []) as LmToolDef[];
      const response = await model.sendRequest(
        deserializeMessages(messages),
        {
          justification: 'BMAD Product Studio — execução federada',
          ...(toolDefs.length
            ? {
                tools: toolDefs.map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema as object | undefined,
                })),
                toolMode: vscode.LanguageModelChatToolMode.Auto,
              }
            : {}),
        },
        cts.token,
      );
      for await (const part of response.stream) {
        if (cts.token.isCancellationRequested) break;
        if (part instanceof vscode.LanguageModelTextPart) {
          send({ type: 'text', value: part.value });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          send({ type: 'tool_call', callId: part.callId, name: part.name, input: part.input });
        }
      }
      // créditos consumidos nesta requisição (delta da cota; some segundos p/ contabilizar)
      let credits: number | undefined;
      const before = await creditsBefore;
      if (before !== undefined) {
        for (const waitMs of [0, 1500, 2500]) {
          if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
          const after = await creditsRemaining();
          if (after !== undefined && after < before) {
            credits = Math.round((before - after) * 1000) / 1000;
            break;
          }
        }
      }
      send({ type: 'done', modelId: model.id, modelName: model.name, ...(credits !== undefined ? { credits } : {}) });
    } catch (err) {
      send({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof vscode.LanguageModelError ? { code: err.code } : {}),
      });
    } finally {
      cts.dispose();
      sse.close();
    }
  });

  // host: recebe um pedaço relaiado pela aba do executor e injeta no job
  router.post('/api/lm/:requestId/chunk', ({ res, params, body }) => {
    const chunk = (body ?? {}) as LmChunk;
    if (!chunk || typeof chunk.type !== 'string') {
      sendError(res, 400, 'chunk inválido');
      return;
    }
    const ok = feedJob(params.requestId, chunk);
    sendJson(res, ok ? 200 : 404, { ok });
  });
}
