import type { CronEvent, CronJob } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReplayableJob(value: unknown): value is CronJob {
  return isRecord(value) && value.version === 1 && typeof value.id === "string";
}

function isMetrics(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.runCount === "number" &&
    typeof value.attributedTokens === "number" &&
    typeof value.consecutiveFailures === "number"
  );
}

function assertCronEvent(event: unknown): asserts event is CronEvent {
  if (!isRecord(event)) {
    throw new Error("Malformed pi-cron event");
  }

  if (event.version !== 1) {
    throw new Error(
      `Unsupported pi-cron event version: ${String(event.version)}`,
    );
  }

  if (typeof event.at !== "string") {
    throw new Error("Malformed pi-cron event");
  }

  if (event.type === "job_created" || event.type === "job_replaced") {
    if (!isReplayableJob(event.job)) {
      throw new Error("Malformed pi-cron event");
    }
    return;
  }

  if (event.type === "job_deleted") {
    if (typeof event.jobId !== "string") {
      throw new Error("Malformed pi-cron event");
    }
    return;
  }

  if (event.type === "metrics_checkpoint") {
    if (!Array.isArray(event.jobs) || !event.jobs.every(isMetrics)) {
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
        if (job) {
          jobs.set(job.id, { ...job, ...metrics });
        }
      }
    }
  }

  return jobs;
}
