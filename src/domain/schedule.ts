import { Cron } from "croner";
import type { ScheduleInput } from "../commands/parse.js";
import { DEFAULT_LIMITS, type Schedule } from "./types.js";

const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

export function parseDuration(value: string): number {
  const match = value.match(/^([1-9]\d*)(s|m|h|d)$/);
  if (!match) {
    throw new ScheduleError(`Invalid duration '${value}'. Use 30m, 2h, or 1d.`);
  }
  const durationMs =
    Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new ScheduleError(`Invalid duration '${value}'. Use 30m, 2h, or 1d.`);
  }
  return durationMs;
}

export function resolveSchedule(
  input: ScheduleInput,
  now: Date,
  unsafeSeconds = false,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Schedule {
  switch (input.kind) {
    case "interval": {
      const intervalMs = parseDuration(input.value);
      if (!unsafeSeconds && intervalMs < DEFAULT_LIMITS.minRecurringMs) {
        throw new ScheduleError("Recurring intervals must be at least 1m.");
      }
      const anchor = checkedDate(now.getTime());
      checkedDate(anchor.getTime() + intervalMs);
      return {
        kind: "interval",
        intervalMs,
        anchorAt: anchor.toISOString(),
      };
    }
    case "cron":
      validateTimezone(timezone);
      createCronCalculator(input.value, timezone);
      return { kind: "cron", expression: input.value, timezone };
    case "in":
      return {
        kind: "once",
        at: checkedDate(
          now.getTime() + parseDuration(input.value),
        ).toISOString(),
        original: input.value,
      };
    case "at": {
      const timestamp = Date.parse(input.value);
      if (!Number.isFinite(timestamp)) {
        throw new ScheduleError(`Invalid date '${input.value}'.`);
      }
      if (timestamp <= now.getTime()) {
        throw new ScheduleError("One-shot schedules must be in the future.");
      }
      return {
        kind: "once",
        at: checkedDate(timestamp).toISOString(),
        original: input.value,
      };
    }
    case "adaptive":
      return {
        kind: "adaptive",
        nextWakeAt: checkedDate(
          now.getTime() + DEFAULT_LIMITS.minRecurringMs,
        ).toISOString(),
        fallbackUsed: false,
      };
  }
}

export function nextOccurrence(schedule: Schedule, after: Date): Date | null {
  switch (schedule.kind) {
    case "interval":
      return nextInterval(schedule.anchorAt, schedule.intervalMs, after);
    case "cron":
      return nextCron(schedule.expression, schedule.timezone, after);
    case "once":
      return futureDate(schedule.at, after);
    case "adaptive":
      return futureDate(schedule.nextWakeAt, after);
    case "maintenance":
      return schedule.cadence === "adaptive"
        ? null
        : nextInterval(
            schedule.cadence.anchorAt,
            schedule.cadence.intervalMs,
            after,
          );
  }
}

export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "interval":
      return `every ${formatDuration(schedule.intervalMs)}`;
    case "cron":
      return `${schedule.expression} (${schedule.timezone})`;
    case "once":
      return `once at ${schedule.at}`;
    case "adaptive":
      return `adaptive (next ${schedule.nextWakeAt})`;
    case "maintenance":
      return schedule.cadence === "adaptive"
        ? "maintenance (adaptive)"
        : `maintenance every ${formatDuration(schedule.cadence.intervalMs)}`;
  }
}

function nextInterval(anchorAt: string, intervalMs: number, after: Date): Date {
  const anchor = Date.parse(anchorAt);
  const elapsed = Math.max(0, after.getTime() - anchor);
  const occurrence = Math.floor(elapsed / intervalMs) + 1;
  return checkedDate(anchor + occurrence * intervalMs);
}

function nextCron(
  expression: string,
  timezone: string,
  after: Date,
): Date | null {
  validateTimezone(timezone);
  return createCronCalculator(expression, timezone).nextRun(after) ?? null;
}

function createCronCalculator(expression: string, timezone: string): Cron {
  validateFivePartCron(expression);
  try {
    return new Cron(expression, {
      paused: true,
      mode: "5-part",
      timezone,
      domAndDow: false,
    });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new ScheduleError(
      `Invalid standard five-field cron expression '${expression}'.${detail}`,
    );
  }
}

function validateFivePartCron(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  const hasExtension = fields.some((field) => /[A-Za-zLW?#+]/.test(field));
  if (fields.length !== 5 || hasExtension) {
    throw new ScheduleError(
      `Invalid standard five-field cron expression '${expression}'.`,
    );
  }
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new ScheduleError(`Invalid IANA timezone '${timezone}'.`);
  }
}

function futureDate(value: string, after: Date): Date | null {
  const timestamp = Date.parse(value);
  return timestamp > after.getTime() ? checkedDate(timestamp) : null;
}

function checkedDate(timestamp: number): Date {
  if (!Number.isFinite(timestamp)) {
    throw new ScheduleError(
      "Schedule timestamp is outside the supported date range.",
    );
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new ScheduleError(
      "Schedule timestamp is outside the supported date range.",
    );
  }
  return date;
}

function formatDuration(durationMs: number): string {
  for (const [unit, unitMs] of [
    ["d", UNIT_MS.d],
    ["h", UNIT_MS.h],
    ["m", UNIT_MS.m],
    ["s", UNIT_MS.s],
  ] as const) {
    if (durationMs % unitMs === 0) return `${durationMs / unitMs}${unit}`;
  }
  return `${durationMs}ms`;
}
