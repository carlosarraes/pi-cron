import {
  requiresReapproval,
  selectJob,
  validateJob,
} from "../domain/policy.js";
import { assertCronEvent, reduceEvents } from "../domain/reducer.js";
import {
  type ApprovalPort,
  type Clock,
  type CronEvent,
  type CronJob,
  DEFAULT_LIMITS,
  type DispatchResult,
  type EventStore,
  type ExecutionMode,
  type ProposedJob,
  type Schedule,
} from "../domain/types.js";

export interface JobDraft {
  name?: string;
  prompt: CronJob["prompt"];
  schedule: Schedule;
  execution?: ExecutionMode;
  expiresAt?: string;
  maxRuns?: number;
  tokenBudget?: number;
}

export type JobPatch = Partial<JobDraft>;

export interface ActiveExecution {
  token: string;
  jobId: string;
  adaptive: boolean;
  decisionMade: boolean;
}

export interface CronServiceOptions {
  events: CronEvent[];
  store: EventStore;
  approvals: ApprovalPort;
  clock: Clock;
  sessionId: string;
  idFactory: () => string;
  onChanged?: () => void;
}

export interface CheckpointPolicy {
  maxRuns: number;
  maxAgeMs: number;
}

type JobMetrics = Extract<
  CronEvent,
  { type: "metrics_checkpoint" }
>["jobs"][number];

export class CronService {
  private readonly events: CronEvent[];
  private jobs: Map<string, CronJob>;
  private activeExecution: ActiveExecution | undefined;
  private dirtyRunCount = 0;
  private dirtySinceMs: number | undefined;

  private readonly store: EventStore;
  private readonly approvals: ApprovalPort;
  private readonly clock: Clock;
  private readonly sessionId: string;
  private readonly idFactory: () => string;
  private readonly onChanged: (() => void) | undefined;

  constructor(options: CronServiceOptions) {
    this.events = structuredClone(options.events);
    this.jobs = reduceEvents(this.events);
    this.store = options.store;
    this.approvals = options.approvals;
    this.clock = options.clock;
    this.sessionId = options.sessionId;
    this.idFactory = options.idFactory;
    this.onChanged = options.onChanged;
  }

  async create(draft: JobDraft): Promise<CronJob> {
    if (this.activeExecution) {
      throw new Error("Scheduled runs cannot create cron jobs");
    }

    const now = this.clock.now();
    const id = this.idFactory();
    const proposed = buildProposedJob(draft, now, this.sessionId, id);
    validateJob(proposed, this.jobs.values());

    const approval = await this.approvals.approve(
      structuredClone(proposed),
      "create",
    );
    if (!approval) throw new Error("Cron job creation cancelled");

    const approved: CronJob = {
      ...proposed,
      approval: structuredClone(approval),
    };
    this.persistAndApply({
      version: 1,
      type: "job_created",
      at: this.clock.now().toISOString(),
      job: approved,
    });
    return structuredClone(approved);
  }

  async replace(selector: string, patch: JobPatch): Promise<CronJob> {
    const before = selectJob(this.jobs.values(), selector);
    const after = applyPatch(before, patch, this.clock.now());
    const proposed = withoutApproval(after);
    validateJob(proposed, this.jobs.values());

    if (requiresReapproval(before, after)) {
      const approval = await this.approvals.approve(
        structuredClone(proposed),
        "privilege_increase",
      );
      if (!approval) throw new Error("Cron job replacement cancelled");
      after.approval = structuredClone(approval);
    }

    this.persistReplacement(after);
    return structuredClone(after);
  }

  pause(selector: string, reason?: string): CronJob {
    const before = selectJob(this.jobs.values(), selector);
    const after: CronJob = {
      ...before,
      state: "paused",
      updatedAt: this.clock.now().toISOString(),
    };
    if (reason === undefined) delete after.pauseReason;
    else after.pauseReason = reason;

    this.persistReplacement(after);
    return structuredClone(after);
  }

  resume(selector: string): CronJob {
    const before = selectJob(this.jobs.values(), selector);
    const after: CronJob = {
      ...before,
      state: "active",
      updatedAt: this.clock.now().toISOString(),
    };
    delete after.pauseReason;

    this.persistReplacement(after);
    return structuredClone(after);
  }

  delete(selector: string): void {
    const job = selectJob(this.jobs.values(), selector);
    this.persistAndApply({
      version: 1,
      type: "job_deleted",
      at: this.clock.now().toISOString(),
      jobId: job.id,
    });
  }

  list(): CronJob[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  get(id: string): CronJob | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : structuredClone(job);
  }

  recordRun(jobId: string, result: DispatchResult, scheduledAt: Date): void {
    const before = this.requireJob(jobId);
    const after: CronJob = {
      ...before,
      runCount: before.runCount + 1,
      attributedTokens: before.attributedTokens + result.tokens,
      consecutiveFailures: nextFailureCount(
        before.consecutiveFailures,
        result.outcome,
      ),
      lastOccurrenceAt: scheduledAt.toISOString(),
      lastTechnicalOutcome: result.outcome,
    };
    const now = this.clock.now().toISOString();
    if (result.outcome === "dispatched") after.lastDispatchAt = now;
    if (result.outcome === "settled") after.lastSettledAt = now;

    if (
      after.consecutiveFailures >= DEFAULT_LIMITS.maxConsecutiveFailures &&
      after.state !== "paused"
    ) {
      after.state = "paused";
      after.pauseReason = `Paused after ${after.consecutiveFailures} consecutive failures`;
      after.updatedAt = now;
      this.persistReplacement(after);
    } else {
      this.jobs.set(jobId, after);
      this.onChanged?.();
    }
    this.markCheckpointDirty();
  }

  shouldFlushCheckpoint(policy: CheckpointPolicy): boolean {
    if (this.dirtySinceMs === undefined) return false;
    return (
      this.dirtyRunCount >= policy.maxRuns ||
      this.clock.now().getTime() - this.dirtySinceMs >= policy.maxAgeMs
    );
  }

  flushCheckpoint(): void {
    if (this.dirtySinceMs === undefined) return;

    const event: CronEvent = {
      version: 1,
      type: "metrics_checkpoint",
      at: this.clock.now().toISOString(),
      jobs: [...this.jobs.values()].map(toMetrics),
    };
    this.persistAndApply(event);
    this.dirtyRunCount = 0;
    this.dirtySinceMs = undefined;
  }

  beginExecution(jobId: string, adaptive: boolean): ActiveExecution {
    this.requireJob(jobId);
    if (this.activeExecution) {
      throw new Error("A cron execution is already active");
    }
    const execution: ActiveExecution = {
      token: crypto.randomUUID(),
      jobId,
      adaptive,
      decisionMade: false,
    };
    this.activeExecution = execution;
    return execution;
  }

  getActiveExecution(): ActiveExecution | undefined {
    return this.activeExecution;
  }

  endExecution(token: string): void {
    if (!this.activeExecution || this.activeExecution.token !== token) {
      throw new Error(
        "Cron execution token does not match the active execution",
      );
    }
    this.activeExecution = undefined;
  }

  setAdaptiveWakeup(jobId: string, at: Date, reason: string): void {
    const execution = this.requireAdaptiveExecution(jobId);
    const before = this.requireJob(jobId);
    if (before.schedule.kind !== "adaptive") {
      throw new Error(`Cron job '${jobId}' is not adaptive`);
    }
    const after: CronJob = {
      ...before,
      schedule: {
        kind: "adaptive",
        nextWakeAt: at.toISOString(),
        fallbackUsed: false,
      },
      state: "active",
      updatedAt: this.clock.now().toISOString(),
    };
    delete after.pauseReason;
    void reason;

    this.persistReplacement(after);
    execution.decisionMade = true;
  }

  stopAdaptive(jobId: string, reason: string): void {
    const execution = this.requireAdaptiveExecution(jobId);
    const before = this.requireJob(jobId);
    if (before.schedule.kind !== "adaptive") {
      throw new Error(`Cron job '${jobId}' is not adaptive`);
    }
    const after: CronJob = {
      ...before,
      state: "paused",
      pauseReason: reason,
      updatedAt: this.clock.now().toISOString(),
    };

    this.persistReplacement(after);
    execution.decisionMade = true;
  }

  private requireAdaptiveExecution(jobId: string): ActiveExecution {
    if (
      !this.activeExecution ||
      this.activeExecution.jobId !== jobId ||
      !this.activeExecution.adaptive
    ) {
      throw new Error(
        `No adaptive execution is active for cron job '${jobId}'`,
      );
    }
    return this.activeExecution;
  }

  private requireJob(jobId: string): CronJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Cron job not found: ${jobId}`);
    return job;
  }

  private markCheckpointDirty(): void {
    this.dirtyRunCount += 1;
    this.dirtySinceMs ??= this.clock.now().getTime();
  }

  private persistReplacement(job: CronJob): void {
    this.persistAndApply({
      version: 1,
      type: "job_replaced",
      at: this.clock.now().toISOString(),
      job,
    });
  }

  private persistAndApply(event: CronEvent): void {
    assertCronEvent(event);
    this.store.append(event);
    const reduced = reduceEvents([...this.events, event]);
    if (
      this.dirtySinceMs !== undefined &&
      event.type !== "metrics_checkpoint"
    ) {
      const replacedId =
        event.type === "job_created" || event.type === "job_replaced"
          ? event.job.id
          : undefined;
      for (const current of this.jobs.values()) {
        const replayed = reduced.get(current.id);
        if (replayed && current.id !== replacedId) {
          reduced.set(current.id, withMetrics(replayed, current));
        }
      }
    }
    this.jobs = reduced;
    this.events.push(structuredClone(event));
    this.onChanged?.();
  }
}

function buildProposedJob(
  draft: JobDraft,
  now: Date,
  sessionId: string,
  id: string,
): ProposedJob {
  const timestamp = now.toISOString();
  const proposed: ProposedJob = {
    version: 1,
    id,
    name: draft.name ?? `job-${id}`,
    prompt: structuredClone(draft.prompt),
    schedule: structuredClone(draft.schedule),
    state: "active",
    execution: structuredClone(draft.execution ?? { kind: "main" }),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt:
      draft.expiresAt ??
      new Date(now.getTime() + DEFAULT_LIMITS.expiresAfterMs).toISOString(),
    runCount: 0,
    attributedTokens: 0,
    consecutiveFailures: 0,
    originSessionId: sessionId,
  };
  if (draft.maxRuns !== undefined) proposed.maxRuns = draft.maxRuns;
  if (draft.tokenBudget !== undefined) proposed.tokenBudget = draft.tokenBudget;
  return proposed;
}

function applyPatch(before: CronJob, patch: JobPatch, now: Date): CronJob {
  const after: CronJob = {
    ...before,
    name: patch.name ?? before.name,
    prompt: structuredClone(patch.prompt ?? before.prompt),
    schedule: structuredClone(patch.schedule ?? before.schedule),
    execution: structuredClone(patch.execution ?? before.execution),
    expiresAt: patch.expiresAt ?? before.expiresAt,
    updatedAt: now.toISOString(),
  };
  applyOptionalLimit(after, patch, "maxRuns");
  applyOptionalLimit(after, patch, "tokenBudget");
  return after;
}

function applyOptionalLimit(
  target: CronJob,
  patch: JobPatch,
  key: "maxRuns" | "tokenBudget",
): void {
  if (!Object.hasOwn(patch, key)) return;
  const value = patch[key];
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function withoutApproval(job: CronJob): ProposedJob {
  const { approval: _approval, ...proposed } = job;
  return proposed;
}

function nextFailureCount(
  current: number,
  outcome: DispatchResult["outcome"],
): number {
  if (outcome === "settled") return 0;
  if (["failed", "timed_out", "aborted"].includes(outcome)) return current + 1;
  return current;
}

function withMetrics(job: CronJob, metrics: CronJob): CronJob {
  const merged: CronJob = {
    ...job,
    runCount: metrics.runCount,
    attributedTokens: metrics.attributedTokens,
    consecutiveFailures: metrics.consecutiveFailures,
  };
  copyOptionalMetric(merged, metrics, "lastOccurrenceAt");
  copyOptionalMetric(merged, metrics, "lastDispatchAt");
  copyOptionalMetric(merged, metrics, "lastSettledAt");
  if (metrics.lastTechnicalOutcome === undefined) {
    delete merged.lastTechnicalOutcome;
  } else {
    merged.lastTechnicalOutcome = metrics.lastTechnicalOutcome;
  }
  return merged;
}

function copyOptionalMetric(
  target: CronJob,
  source: CronJob,
  key: "lastOccurrenceAt" | "lastDispatchAt" | "lastSettledAt",
): void {
  const value = source[key];
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function toMetrics(job: CronJob): JobMetrics {
  const metrics: JobMetrics = {
    id: job.id,
    runCount: job.runCount,
    attributedTokens: job.attributedTokens,
    consecutiveFailures: job.consecutiveFailures,
  };
  if (job.lastOccurrenceAt !== undefined) {
    metrics.lastOccurrenceAt = job.lastOccurrenceAt;
  }
  if (job.lastDispatchAt !== undefined)
    metrics.lastDispatchAt = job.lastDispatchAt;
  if (job.lastSettledAt !== undefined)
    metrics.lastSettledAt = job.lastSettledAt;
  if (job.lastTechnicalOutcome !== undefined) {
    metrics.lastTechnicalOutcome = job.lastTechnicalOutcome;
  }
  return metrics;
}
