import type {
  SavedCronDefinition,
  SavedDefinitionDraft,
  SavedDefinitionPatch,
  SavedSchedule,
} from "../domain/saved.js";
import { parseDuration } from "../domain/schedule.js";
import {
  type CronJob,
  DEFAULT_LIMITS,
  type Schedule,
} from "../domain/types.js";
import type { JobDraft, JobPatch } from "./service.js";

const DURATION_INPUT = /^[1-9]\d*(?:ms|s|m|h|d)$/;

export function savedDraftFromJobDraft(
  draft: JobDraft,
  now: Date,
): SavedDefinitionDraft {
  const result: SavedDefinitionDraft = {
    prompt: structuredClone(draft.prompt),
    schedule: savedScheduleFromRuntime(draft.schedule),
    execution: structuredClone(draft.execution ?? { kind: "main" }),
    overlap: draft.overlap ?? "queue",
    unsafeSeconds:
      draft.unsafeSeconds === true || isSubMinuteRecurring(draft.schedule),
    expiresAfterMs:
      draft.expiresAt === undefined
        ? DEFAULT_LIMITS.expiresAfterMs
        : expiryDuration(draft.expiresAt, now.getTime()),
  };
  if (draft.name !== undefined) result.name = draft.name;
  copyOptionalLimit(result, draft, "maxRuns");
  copyOptionalLimit(result, draft, "tokenBudget");
  return result;
}

export function savedDraftFromJob(job: CronJob): SavedDefinitionDraft {
  const result: SavedDefinitionDraft = {
    name: job.name,
    prompt: structuredClone(job.prompt),
    schedule: savedScheduleFromRuntime(job.schedule),
    execution: structuredClone(job.execution),
    overlap: job.overlap ?? "queue",
    unsafeSeconds: isSubMinuteRecurring(job.schedule),
    expiresAfterMs: expiryDuration(job.expiresAt, Date.parse(job.createdAt)),
  };
  copyOptionalLimit(result, job, "maxRuns");
  copyOptionalLimit(result, job, "tokenBudget");
  return result;
}

export function savedPatchFromJobPatch(
  patch: JobPatch,
  now: Date,
): SavedDefinitionPatch {
  const result: SavedDefinitionPatch = {};
  if (Object.hasOwn(patch, "name")) result.name = patch.name;
  if (Object.hasOwn(patch, "prompt") && patch.prompt !== undefined) {
    result.prompt = structuredClone(patch.prompt);
  }
  if (Object.hasOwn(patch, "schedule") && patch.schedule !== undefined) {
    result.schedule = savedScheduleFromRuntime(patch.schedule);
    if (isSubMinuteRecurring(patch.schedule)) result.unsafeSeconds = true;
  }
  if (Object.hasOwn(patch, "execution") && patch.execution !== undefined) {
    result.execution = structuredClone(patch.execution);
  }
  if (Object.hasOwn(patch, "overlap")) result.overlap = patch.overlap;
  if (Object.hasOwn(patch, "expiresAt") && patch.expiresAt !== undefined) {
    result.expiresAfterMs = expiryDuration(patch.expiresAt, now.getTime());
  }
  if (Object.hasOwn(patch, "maxRuns")) result.maxRuns = patch.maxRuns;
  if (Object.hasOwn(patch, "tokenBudget")) {
    result.tokenBudget = patch.tokenBudget;
  }
  if (Object.hasOwn(patch, "unsafeSeconds") && result.unsafeSeconds !== true) {
    result.unsafeSeconds = patch.unsafeSeconds;
  }
  return result;
}

export function materializeSavedDefinition(
  definition: SavedCronDefinition,
  now: Date,
): JobDraft {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid activation time");
  const expiresAt = checkedIso(
    nowMs + definition.expiresAfterMs,
    "Saved cron expiry is outside the supported date range",
  );
  const result: JobDraft = {
    name: definition.name,
    prompt: structuredClone(definition.prompt),
    schedule: materializeSchedule(definition.schedule, now),
    execution: structuredClone(definition.execution),
    overlap: definition.overlap,
    expiresAt,
    unsafeSeconds: definition.unsafeSeconds,
  };
  copyOptionalLimit(result, definition, "maxRuns");
  copyOptionalLimit(result, definition, "tokenBudget");
  return result;
}

function savedScheduleFromRuntime(schedule: Schedule): SavedSchedule {
  switch (schedule.kind) {
    case "interval":
      return { kind: "interval", intervalMs: schedule.intervalMs };
    case "cron":
      return {
        kind: "cron",
        expression: schedule.expression,
        timezone: schedule.timezone,
      };
    case "once":
      return DURATION_INPUT.test(schedule.original)
        ? {
            kind: "once",
            timing: {
              kind: "relative",
              delayMs: parseSavedDuration(schedule.original),
            },
          }
        : {
            kind: "once",
            timing: { kind: "absolute", at: schedule.at },
          };
    case "adaptive":
      return { kind: "adaptive" };
    case "maintenance":
      return {
        kind: "maintenance",
        cadence:
          schedule.cadence === "adaptive"
            ? "adaptive"
            : { intervalMs: schedule.cadence.intervalMs },
      };
  }
}

function materializeSchedule(schedule: SavedSchedule, now: Date): Schedule {
  switch (schedule.kind) {
    case "interval":
      return {
        kind: "interval",
        intervalMs: schedule.intervalMs,
        anchorAt: now.toISOString(),
      };
    case "cron":
      return structuredClone(schedule);
    case "once": {
      if (schedule.timing.kind === "absolute") {
        if (Date.parse(schedule.timing.at) <= now.getTime()) {
          throw new Error("Saved absolute one-shot must be in the future");
        }
        return {
          kind: "once",
          at: schedule.timing.at,
          original: schedule.timing.at,
        };
      }
      return {
        kind: "once",
        at: checkedIso(
          now.getTime() + schedule.timing.delayMs,
          "Saved relative one-shot is outside the supported date range",
        ),
        original: formatDurationInput(schedule.timing.delayMs),
      };
    }
    case "adaptive":
      return {
        kind: "adaptive",
        nextWakeAt: checkedIso(
          now.getTime() + DEFAULT_LIMITS.minRecurringMs,
          "Saved adaptive wakeup is outside the supported date range",
        ),
        fallbackUsed: false,
      };
    case "maintenance":
      return {
        kind: "maintenance",
        cadence:
          schedule.cadence === "adaptive"
            ? "adaptive"
            : {
                intervalMs: schedule.cadence.intervalMs,
                anchorAt: now.toISOString(),
              },
      };
  }
}

function expiryDuration(expiresAt: string, fromMs: number): number {
  const duration = Date.parse(expiresAt) - fromMs;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error(
      "Saved cron expiry duration must be a positive safe integer",
    );
  }
  return duration;
}

function isSubMinuteRecurring(schedule: Schedule): boolean {
  const intervalMs =
    schedule.kind === "interval"
      ? schedule.intervalMs
      : schedule.kind === "maintenance" && schedule.cadence !== "adaptive"
        ? schedule.cadence.intervalMs
        : undefined;
  return intervalMs !== undefined && intervalMs < DEFAULT_LIMITS.minRecurringMs;
}

function formatDurationInput(durationMs: number): string {
  for (const [suffix, unitMs] of [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ] as const) {
    if (durationMs % unitMs === 0) return `${durationMs / unitMs}${suffix}`;
  }
  return `${durationMs}ms`;
}

function parseSavedDuration(value: string): number {
  if (value.endsWith("ms")) return Number(value.slice(0, -2));
  return parseDuration(value);
}

function checkedIso(timestamp: number, message: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || !Number.isFinite(date.getTime())) {
    throw new Error(message);
  }
  return date.toISOString();
}

function copyOptionalLimit<
  T extends Partial<Pick<JobDraft, "maxRuns" | "tokenBudget">>,
  U extends Partial<Pick<JobDraft, "maxRuns" | "tokenBudget">>,
>(target: T, source: U, key: "maxRuns" | "tokenBudget"): void {
  if (!Object.hasOwn(source, key)) return;
  target[key] = source[key];
}
