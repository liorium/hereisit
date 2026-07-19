export interface CostAccountingScheduleDependencies {
  readonly targetHour: () => Promise<number | null>;
  readonly importUsageLogs: (now: number) => Promise<"complete" | "partial" | "conflict">;
  readonly observeUsageHour: (
    hourKey: number,
    now: number,
  ) => Promise<"observed" | "stable" | "conflict">;
  readonly reconcileWorker: (
    hourKey: number,
    now: number,
  ) => Promise<"verified" | "incomplete" | "conflict">;
  readonly reconcileContainer: (
    hourKey: number,
    now: number,
  ) => Promise<"verified" | "incomplete" | "conflict">;
  readonly sealHour: (now: number) => Promise<"sealed" | "not-due" | "incomplete" | "conflict">;
}

export type CostAccountingScheduleResult = {
  readonly kind:
    | "idle"
    | "importing"
    | "provider-delay"
    | "observing"
    | "worker-incomplete"
    | "container-incomplete"
    | "sealing-incomplete"
    | "sealed"
    | "conflict";
  readonly hourKey: number | null;
};

export async function runCostAccountingSchedule(
  now: number,
  dependencies: CostAccountingScheduleDependencies,
): Promise<CostAccountingScheduleResult> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Cost accounting schedule time is invalid.");
  }
  const hourKey = await dependencies.targetHour();
  if (hourKey === null) return { kind: "idle", hourKey: null };
  if (!Number.isSafeInteger(hourKey) || hourKey < 0) {
    throw new RangeError("Cost accounting target hour is invalid.");
  }
  const hourEnd = (hourKey + 1) * 3_600_000;
  const providerReadyAt = hourEnd + 30 * 60_000;
  const completenessDeadline = hourEnd + 60 * 60_000;
  if (!Number.isSafeInteger(providerReadyAt) || !Number.isSafeInteger(completenessDeadline)) {
    throw new RangeError("Cost accounting provider deadline exceeded its bound.");
  }
  const incomplete = async (
    kind: Exclude<CostAccountingScheduleResult["kind"], "idle" | "sealed" | "conflict">,
  ): Promise<CostAccountingScheduleResult> => {
    if (now < completenessDeadline) return { kind, hourKey };
    const deadlineSeal = await dependencies.sealHour(now);
    return { kind: deadlineSeal === "conflict" ? "conflict" : "sealing-incomplete", hourKey };
  };

  const imported = await dependencies.importUsageLogs(now);
  if (imported === "conflict") return { kind: "conflict", hourKey };
  if (imported === "partial") return incomplete("importing");

  if (now < providerReadyAt) return { kind: "provider-delay", hourKey };

  const observation = await dependencies.observeUsageHour(hourKey, now);
  if (observation === "conflict") return { kind: "conflict", hourKey };
  if (observation === "observed") return incomplete("observing");

  const worker = await dependencies.reconcileWorker(hourKey, now);
  if (worker === "conflict") return { kind: "conflict", hourKey };
  if (worker === "incomplete") return incomplete("worker-incomplete");

  const container = await dependencies.reconcileContainer(hourKey, now);
  if (container === "conflict") return { kind: "conflict", hourKey };
  if (container === "incomplete") return incomplete("container-incomplete");

  const sealed = await dependencies.sealHour(now);
  if (sealed === "conflict") return { kind: "conflict", hourKey };
  if (sealed !== "sealed") return { kind: "sealing-incomplete", hourKey };
  return { kind: "sealed", hourKey };
}
