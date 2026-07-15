import { truncateToWidth } from "@earendil-works/pi-tui";
import { describeSchedule } from "../domain/schedule.js";
import type { CronJob, RuntimeStatus } from "../domain/types.js";

export type Column =
  | "state"
  | "name"
  | "schedule"
  | "next"
  | "last"
  | "runs"
  | "mode"
  | "expires";

export function visibleColumns(width: number): Column[] {
  const columns: Column[] = [
    "state",
    "name",
    "schedule",
    "next",
    "last",
    "runs",
    "mode",
    "expires",
  ];
  return columns.filter(
    (column) =>
      !(width < 110 && column === "last") &&
      !(width < 90 && column === "runs") &&
      !(width < 72 && column === "expires"),
  );
}

export function stateLabel(job: CronJob, runtime?: RuntimeStatus): string {
  if (runtime?.state === "running") return "▶ running";
  if (runtime?.state === "pending") return "◷ pending";
  switch (job.state) {
    case "active":
      return "● active";
    case "paused":
      return "Ⅱ paused";
    case "missed":
      return "! missed";
    case "completed":
      return "✓ completed";
    case "expired":
      return "× expired";
  }
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return "—";
  const future = durationMs >= 0;
  let remaining = Math.abs(Math.round(durationMs / 1_000));
  const days = Math.floor(remaining / 86_400);
  remaining %= 86_400;
  const hours = Math.floor(remaining / 3_600);
  remaining %= 3_600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const value = days
    ? `${days}d ${hours}h`
    : hours
      ? `${hours}h ${minutes}m`
      : minutes
        ? `${minutes}m`
        : `${seconds}s`;
  return future ? value : `${value} ago`;
}

export function modeLabel(job: CronJob): string {
  return job.execution.kind === "main"
    ? "main"
    : `isolated:${job.execution.model}`;
}

export interface ManagerRow {
  id: string;
  values: Record<Column, string>;
}

export function projectRow(
  job: CronJob,
  runtime: RuntimeStatus,
  now: Date,
  nextAt?: Date,
): ManagerRow {
  return {
    id: job.id,
    values: {
      state: stateLabel(job, runtime),
      name: job.name,
      schedule: describeSchedule(job.schedule),
      next: nextAt ? formatDuration(nextAt.getTime() - now.getTime()) : "—",
      last: job.lastSettledAt
        ? formatDuration(Date.parse(job.lastSettledAt) - now.getTime())
        : "—",
      runs: job.maxRuns ? `${job.runCount}/${job.maxRuns}` : `${job.runCount}`,
      mode: modeLabel(job),
      expires: formatDuration(Date.parse(job.expiresAt) - now.getTime()),
    },
  };
}

export function renderRow(
  row: ManagerRow,
  columns: Column[],
  width: number,
): string {
  const available = Math.max(1, width - Math.max(0, columns.length - 1) * 2);
  const base = Math.max(6, Math.floor(available / columns.length));
  return truncateToWidth(
    columns
      .map((column) => truncateToWidth(row.values[column], base).padEnd(base))
      .join("  "),
    width,
  );
}
