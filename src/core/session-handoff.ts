import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SchedulerSnapshot } from "./scheduler.js";

export const CRON_HANDOFF_ENTRY = "pi-cron/handoff";
export const AFTER_RUN_COMMAND = "cron-after-run";

export interface CronSessionHandoff {
  version: 1;
  sessionId: string;
  token: string;
  scheduler: SchedulerSnapshot;
}

/** Only the new-session lifecycle consumes a handoff, never resume or reload. */
export function readSessionHandoff(
  ctx: ExtensionContext,
): CronSessionHandoff | undefined {
  const entry = [...ctx.sessionManager.getBranch()]
    .reverse()
    .find(
      (entry) =>
        entry.type === "custom" && entry.customType === CRON_HANDOFF_ENTRY,
    );
  if (entry?.type !== "custom") return undefined;
  const data = entry.data as Partial<CronSessionHandoff> | undefined;
  if (
    data?.version !== 1 ||
    data.sessionId !== ctx.sessionManager.getSessionId() ||
    typeof data.token !== "string" ||
    !data.token ||
    !data.scheduler ||
    !isDates(data.scheduler.pending) ||
    !isDates(data.scheduler.occurrences) ||
    !Array.isArray(data.scheduler.initialQueued) ||
    !data.scheduler.initialQueued.every((id) => typeof id === "string")
  ) {
    throw new Error("Malformed cron session handoff");
  }
  return data as CronSessionHandoff;
}

function isDates(value: unknown): value is Array<[string, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        typeof item[1] === "string" &&
        Number.isFinite(Date.parse(item[1])),
    )
  );
}
