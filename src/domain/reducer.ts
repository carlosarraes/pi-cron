import type { CronEvent, CronJob, TechnicalOutcome } from "./types.js";

type JobMetrics = Extract<
  CronEvent,
  { type: "metrics_checkpoint" }
>["jobs"][number];

type UnknownRecord = Record<string, unknown>;

const TECHNICAL_OUTCOMES = new Set<TechnicalOutcome>([
  "dispatched",
  "settled",
  "failed",
  "timed_out",
  "aborted",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: UnknownRecord,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && allowedKeys.has(key),
  );
}

function hasOptionalField(
  value: UnknownRecord,
  key: string,
  validate: (field: unknown) => boolean,
): boolean {
  return !Object.hasOwn(value, key) || validate(value[key]);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCounter(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isTechnicalOutcome(value: unknown): value is TechnicalOutcome {
  return (
    typeof value === "string" &&
    TECHNICAL_OUTCOMES.has(value as TechnicalOutcome)
  );
}

function isPrompt(value: unknown): value is CronJob["prompt"] {
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  if (value.kind === "text") {
    return hasOnlyKeys(value, ["kind", "text"]) && isString(value.text);
  }
  if (value.kind === "maintenance") {
    return hasOnlyKeys(value, ["kind"]);
  }
  if (value.kind === "command") {
    return (
      hasOnlyKeys(value, ["kind", "name", "args", "source"]) &&
      isString(value.name) &&
      isString(value.args) &&
      (value.source === "skill" || value.source === "prompt")
    );
  }
  return false;
}

function isCadence(
  value: unknown,
): value is Extract<CronJob["schedule"], { kind: "maintenance" }>["cadence"] {
  return (
    value === "adaptive" ||
    (isRecord(value) &&
      hasOnlyKeys(value, ["intervalMs", "anchorAt"]) &&
      isFiniteNumber(value.intervalMs) &&
      isString(value.anchorAt))
  );
}

function isSchedule(value: unknown): value is CronJob["schedule"] {
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  if (value.kind === "interval") {
    return (
      hasOnlyKeys(value, ["kind", "intervalMs", "anchorAt"]) &&
      isFiniteNumber(value.intervalMs) &&
      isString(value.anchorAt)
    );
  }
  if (value.kind === "cron") {
    return (
      hasOnlyKeys(value, ["kind", "expression", "timezone"]) &&
      isString(value.expression) &&
      isString(value.timezone)
    );
  }
  if (value.kind === "once") {
    return (
      hasOnlyKeys(value, ["kind", "at", "original"]) &&
      isString(value.at) &&
      isString(value.original)
    );
  }
  if (value.kind === "adaptive") {
    return (
      hasOnlyKeys(value, ["kind", "nextWakeAt", "fallbackUsed"]) &&
      isString(value.nextWakeAt) &&
      typeof value.fallbackUsed === "boolean"
    );
  }
  if (value.kind === "maintenance") {
    return hasOnlyKeys(value, ["kind", "cadence"]) && isCadence(value.cadence);
  }
  return false;
}

function isExecution(value: unknown): value is CronJob["execution"] {
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  if (value.kind === "main") {
    return hasOnlyKeys(value, ["kind"]);
  }
  if (value.kind === "isolated") {
    return (
      hasOnlyKeys(value, [
        "kind",
        "model",
        "effort",
        "tools",
        "skills",
        "extensions",
        "notify",
        "timeoutMs",
      ]) &&
      isString(value.model) &&
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        value.effort as string,
      ) &&
      isStringArray(value.tools) &&
      isStringArray(value.skills) &&
      isStringArray(value.extensions) &&
      typeof value.notify === "boolean" &&
      isFiniteNumber(value.timeoutMs)
    );
  }
  return false;
}

function isApproval(value: unknown): value is CronJob["approval"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["approvedAt", "fingerprint"]) &&
    isString(value.approvedAt) &&
    isString(value.fingerprint)
  );
}

export function isCronJob(value: unknown): value is CronJob {
  if (!isRecord(value)) return false;

  return (
    hasOnlyKeys(value, [
      "version",
      "id",
      "name",
      "prompt",
      "schedule",
      "state",
      "execution",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "maxRuns",
      "tokenBudget",
      "runCount",
      "attributedTokens",
      "consecutiveFailures",
      "lastOccurrenceAt",
      "lastDispatchAt",
      "lastSettledAt",
      "lastTechnicalOutcome",
      "pauseReason",
      "approval",
      "originSessionId",
    ]) &&
    value.version === 1 &&
    isString(value.id) &&
    isString(value.name) &&
    isPrompt(value.prompt) &&
    isSchedule(value.schedule) &&
    ["active", "paused", "missed", "completed", "expired"].includes(
      value.state as string,
    ) &&
    isExecution(value.execution) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isString(value.expiresAt) &&
    hasOptionalField(value, "maxRuns", isCounter) &&
    hasOptionalField(value, "tokenBudget", isCounter) &&
    isCounter(value.runCount) &&
    isCounter(value.attributedTokens) &&
    isCounter(value.consecutiveFailures) &&
    hasOptionalField(value, "lastOccurrenceAt", isString) &&
    hasOptionalField(value, "lastDispatchAt", isString) &&
    hasOptionalField(value, "lastSettledAt", isString) &&
    hasOptionalField(value, "lastTechnicalOutcome", isTechnicalOutcome) &&
    hasOptionalField(value, "pauseReason", isString) &&
    isApproval(value.approval) &&
    isString(value.originSessionId)
  );
}

function isMetrics(value: unknown): value is JobMetrics {
  if (!isRecord(value)) return false;

  return (
    hasOnlyKeys(value, [
      "id",
      "runCount",
      "attributedTokens",
      "consecutiveFailures",
      "lastOccurrenceAt",
      "lastDispatchAt",
      "lastSettledAt",
      "lastTechnicalOutcome",
    ]) &&
    isString(value.id) &&
    isCounter(value.runCount) &&
    isCounter(value.attributedTokens) &&
    isCounter(value.consecutiveFailures) &&
    hasOptionalField(value, "lastOccurrenceAt", isString) &&
    hasOptionalField(value, "lastDispatchAt", isString) &&
    hasOptionalField(value, "lastSettledAt", isString) &&
    hasOptionalField(value, "lastTechnicalOutcome", isTechnicalOutcome)
  );
}

export function assertCronEvent(event: unknown): asserts event is CronEvent {
  if (!isRecord(event)) {
    throw new Error("Malformed pi-cron event");
  }

  if (event.version !== 1) {
    throw new Error(
      `Unsupported pi-cron event version: ${String(event.version)}`,
    );
  }

  if (event.type === "job_created" || event.type === "job_replaced") {
    if (
      !hasOnlyKeys(event, ["version", "type", "at", "job"]) ||
      !isString(event.at) ||
      !isCronJob(event.job)
    ) {
      throw new Error("Malformed pi-cron event");
    }
    return;
  }

  if (event.type === "job_deleted") {
    if (
      !hasOnlyKeys(event, ["version", "type", "at", "jobId"]) ||
      !isString(event.at) ||
      !isString(event.jobId)
    ) {
      throw new Error("Malformed pi-cron event");
    }
    return;
  }

  if (event.type === "metrics_checkpoint") {
    if (
      !hasOnlyKeys(event, ["version", "type", "at", "jobs"]) ||
      !isString(event.at) ||
      !Array.isArray(event.jobs) ||
      !event.jobs.every(isMetrics)
    ) {
      throw new Error("Malformed pi-cron event");
    }
    return;
  }

  throw new Error("Malformed pi-cron event");
}

export function reduceEvents(events: CronEvent[]): Map<string, CronJob> {
  const jobs = new Map<string, CronJob>();

  for (const event of events) {
    assertCronEvent(event);

    if (event.type === "job_created" || event.type === "job_replaced") {
      jobs.set(event.job.id, structuredClone(event.job));
    } else if (event.type === "job_deleted") {
      jobs.delete(event.jobId);
    } else {
      for (const metrics of event.jobs) {
        const job = jobs.get(metrics.id);
        if (!job) continue;

        const updated: CronJob = {
          ...job,
          runCount: metrics.runCount,
          attributedTokens: metrics.attributedTokens,
          consecutiveFailures: metrics.consecutiveFailures,
        };
        if (metrics.lastOccurrenceAt !== undefined) {
          updated.lastOccurrenceAt = metrics.lastOccurrenceAt;
        }
        if (metrics.lastDispatchAt !== undefined) {
          updated.lastDispatchAt = metrics.lastDispatchAt;
        }
        if (metrics.lastSettledAt !== undefined) {
          updated.lastSettledAt = metrics.lastSettledAt;
        }
        if (metrics.lastTechnicalOutcome !== undefined) {
          updated.lastTechnicalOutcome = metrics.lastTechnicalOutcome;
        }
        jobs.set(job.id, updated);
      }
    }
  }

  return jobs;
}
