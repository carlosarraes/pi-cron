import { nextOccurrence } from "./schedule.js";
import {
  type CronJob,
  DEFAULT_LIMITS,
  type ProposedJob,
  type Schedule,
} from "./types.js";

const EFFORT_RANK: Record<
  Extract<CronJob["execution"], { kind: "isolated" }>["effort"],
  number
> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

export function selectJob(jobs: Iterable<CronJob>, selector: string): CronJob {
  const normalized = selector.toLowerCase();
  const candidates = [...jobs];
  const exactId = candidates.find((job) => job.id.toLowerCase() === normalized);
  if (exactId) return exactId;

  const exactNames = candidates.filter(
    (job) => job.name.toLowerCase() === normalized,
  );
  if (exactNames.length === 1) return exactNames[0];
  if (exactNames.length > 1) {
    throw new Error(`Ambiguous job selector: ${selector}`);
  }

  const prefixes = candidates.filter(
    (job) =>
      job.id.toLowerCase().startsWith(normalized) ||
      job.name.toLowerCase().startsWith(normalized),
  );
  if (prefixes.length === 1) return prefixes[0];
  if (prefixes.length > 1) {
    throw new Error(`Ambiguous job selector: ${selector}`);
  }
  throw new Error(`Cron job not found: ${selector}`);
}

export function validateJob(
  candidate: ProposedJob,
  jobs: Iterable<CronJob>,
): void {
  const others = [...jobs].filter((job) => job.id !== candidate.id);
  if (others.length >= DEFAULT_LIMITS.maxJobs) {
    throw new Error(`Cron jobs are limited to ${DEFAULT_LIMITS.maxJobs}`);
  }

  const normalizedName = candidate.name.trim().toLowerCase();
  if (normalizedName.length === 0)
    throw new Error("Cron job name cannot be empty");
  if (others.some((job) => job.name.trim().toLowerCase() === normalizedName)) {
    throw new Error(`A cron job named '${candidate.name}' already exists`);
  }
}

export function requiresReapproval(before: CronJob, after: CronJob): boolean {
  return (
    promptFingerprint(before.prompt) !== promptFingerprint(after.prompt) ||
    cadenceMs(after.schedule) < cadenceMs(before.schedule) ||
    Date.parse(after.expiresAt) > Date.parse(before.expiresAt) ||
    raisesExecutionPrivilege(before.execution, after.execution) ||
    raisesLimit(before.maxRuns, after.maxRuns) ||
    raisesLimit(before.tokenBudget, after.tokenBudget)
  );
}

function promptFingerprint(prompt: CronJob["prompt"]): string {
  switch (prompt.kind) {
    case "text":
      return JSON.stringify([prompt.kind, prompt.text]);
    case "maintenance":
      return JSON.stringify([prompt.kind]);
    case "command":
      return JSON.stringify([
        prompt.kind,
        prompt.source,
        prompt.name,
        prompt.args,
      ]);
  }
}

function cadenceMs(schedule: Schedule): number {
  const first = nextOccurrence(schedule, new Date("2000-01-01T00:00:00.000Z"));
  if (!first) return Number.POSITIVE_INFINITY;

  let latest = first;
  let occurrenceCount = 1;
  while (occurrenceCount < 32) {
    const next = nextOccurrence(schedule, latest);
    if (!next) break;
    latest = next;
    occurrenceCount += 1;
  }
  return occurrenceCount > 1
    ? (latest.getTime() - first.getTime()) / (occurrenceCount - 1)
    : Number.POSITIVE_INFINITY;
}

function raisesExecutionPrivilege(
  before: CronJob["execution"],
  after: CronJob["execution"],
): boolean {
  if (before.kind === "isolated" && after.kind === "main") return true;
  if (before.kind === "main" || after.kind === "main") return false;

  return (
    before.model !== after.model ||
    EFFORT_RANK[after.effort] > EFFORT_RANK[before.effort] ||
    (!before.notify && after.notify) ||
    after.timeoutMs > before.timeoutMs ||
    addsEntries(before.tools, after.tools) ||
    addsEntries(before.skills, after.skills) ||
    addsEntries(before.extensions, after.extensions)
  );
}

function addsEntries(before: string[], after: string[]): boolean {
  const existing = new Set(before);
  return after.some((entry) => !existing.has(entry));
}

function raisesLimit(
  before: number | undefined,
  after: number | undefined,
): boolean {
  if (before === undefined) return false;
  if (after === undefined) return true;
  return after > before;
}
