/**
 * APIs do VS Code como selectChatModels/getAccounts podem pendurar enquanto a
 * extensão provedora (Copilot Chat, auth) ativa. Nunca bloqueie uma rota HTTP
 * nelas sem timeout.
 */
export function withTimeout<T>(promise: Thenable<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
