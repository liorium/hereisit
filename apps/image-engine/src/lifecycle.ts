export interface EngineShutdownController {
  stopAccepting(): void;
  waitForIdle(graceMs: number): Promise<boolean>;
  cancelActive(): Promise<void>;
}

export async function shutdownEngine(input: {
  readonly graceMs: number;
  readonly controller: EngineShutdownController;
  readonly closeServer: () => Promise<void>;
}): Promise<void> {
  input.controller.stopAccepting();
  const idle = await input.controller.waitForIdle(input.graceMs);
  if (!idle) await input.controller.cancelActive();
  await input.closeServer();
}
