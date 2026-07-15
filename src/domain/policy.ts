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
  const normalized = selector.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("Cron job selector cannot be empty");
  }
  const candidates = [...jobs];
  const exactId = candidates.find((job) => job.id.toLowerCase() === normalized);
  if (exactId) return exactId;

  const exactNames = candidates.filter(
    (job) => job.name.trim().toLowerCase() === normalized,
  );
  if (exactNames.length === 1) return exactNames[0];
  if (exactNames.length > 1) {
    throw new Error(`Ambiguous job selector: ${selector}`);
  }

  const prefixes = candidates.filter(
    (job) =>
      job.id.toLowerCase().startsWith(normalized) ||
      job.name.trim().toLowerCase().startsWith(normalized),
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
    scheduleRaisesPrivilege(before.schedule, after.schedule) ||
    expiryRaisesPrivilege(before.expiresAt, after.expiresAt) ||
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

function scheduleRaisesPrivilege(before: Schedule, after: Schedule): boolean {
  if (before.kind !== after.kind) return true;

  switch (before.kind) {
    case "interval":
      return after.kind === "interval" && after.intervalMs < before.intervalMs;
    case "cron":
      return (
        after.kind === "cron" &&
        (after.expression !== before.expression ||
          after.timezone !== before.timezone)
      );
    case "once":
      return after.kind === "once" && after.at !== before.at;
    case "adaptive":
      return (
        after.kind === "adaptive" && after.nextWakeAt !== before.nextWakeAt
      );
    case "maintenance": {
      if (after.kind !== "maintenance") return true;
      if (before.cadence === "adaptive" || after.cadence === "adaptive") {
        return before.cadence !== after.cadence;
      }
      return after.cadence.intervalMs < before.cadence.intervalMs;
    }
  }
}

function expiryRaisesPrivilege(before: string, after: string): boolean {
  if (before === after) return false;
  const beforeMs = Date.parse(before);
  const afterMs = Date.parse(after);
  if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) return true;
  return afterMs > beforeMs;
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
