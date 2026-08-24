import {
  requiresReapproval,
  selectJob,
  validateJob,
} from "../domain/policy.js";
import { assertCronEvent, reduceEvents } from "../domain/reducer.js";
import { nextOccurrence } from "../domain/schedule.js";
import {
  type ApprovalMode,
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
  type TechnicalOutcome,
} from "../domain/types.js";

const MAX_ID_ATTEMPTS = 16;
const TECHNICAL_OUTCOMES = new Set<TechnicalOutcome>([
  "dispatched",
  "settled",
  "failed",
  "timed_out",
  "aborted",
]);

export interface JobDraft {
  name?: string;
  prompt: CronJob["prompt"];
  schedule: Schedule;
  execution?: ExecutionMode;
  expiresAt?: string;
  maxRuns?: number;
  tokenBudget?: number;
  unsafeSeconds?: boolean;
}

export type JobPatch = Partial<JobDraft>;

export interface MutationOptions {
  approvalMode?: ApprovalMode;
}

export interface ActiveExecution {
  readonly token: string;
  readonly jobId: string;
  readonly adaptive: boolean;
  readonly decisionMade: boolean;
}

interface MutableActiveExecution {
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
  onObserverError?: (error: unknown) => void;
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
  private activeExecution: MutableActiveExecution | undefined;
  private dirtyRunCount = 0;
  private dirtySinceMs: number | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private pendingMutationCount = 0;
  private changeNotificationPending = false;

  private readonly store: EventStore;
  private readonly approvals: ApprovalPort;
  private readonly clock: Clock;
  private readonly sessionId: string;
  private readonly idFactory: () => string;
  private readonly onChanged: (() => void) | undefined;
  private readonly onObserverError: ((error: unknown) => void) | undefined;

  constructor(options: CronServiceOptions) {
    this.events = structuredClone(options.events);
    this.jobs = reduceEvents(this.events);
    this.store = options.store;
    this.approvals = options.approvals;
    this.clock = options.clock;
    this.sessionId = options.sessionId;
    this.idFactory = options.idFactory;
    this.onChanged = options.onChanged;
    this.onObserverError = options.onObserverError;
  }

  create(draft: JobDraft, options: MutationOptions = {}): Promise<CronJob> {
    if (this.activeExecution) {
      return Promise.reject(
        new Error("Scheduled runs cannot create cron jobs"),
      );
    }
    return this.enqueueMutation(async () => {
      if (this.activeExecution) {
        throw new Error("Scheduled runs cannot create cron jobs");
      }
      const now = this.clock.now();
      const id = this.generateUniqueId();
      const proposed = buildProposedJob(draft, now, this.sessionId, id);
      this.validateCandidate(proposed, draft.unsafeSeconds === true, now);

      const approval = await this.approvals.approve(
        structuredClone(proposed),
        "create",
        options.approvalMode ?? "interactive",
      );
      if (!approval) throw new Error("Cron job creation cancelled");
      this.validateCandidate(
        proposed,
        draft.unsafeSeconds === true,
        this.clock.now(),
      );

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
    });
  }

  replace(
    selector: string,
    patch: JobPatch,
    options: MutationOptions = {},
  ): Promise<CronJob> {
    return this.enqueueMutation(async () => {
      const before = selectJob(this.jobs.values(), selector);
      const now = this.clock.now();
      const after = applyPatch(before, patch, now);
      const proposed = withoutApproval(after);
      this.validateCandidate(proposed, patch.unsafeSeconds === true, now);

      if (requiresReapproval(before, after)) {
        const approval = await this.approvals.approve(
          structuredClone(proposed),
          "privilege_increase",
          options.approvalMode ?? "interactive",
        );
        if (!approval) throw new Error("Cron job replacement cancelled");
        this.validateCandidate(
          proposed,
          patch.unsafeSeconds === true,
          this.clock.now(),
        );
        after.approval = structuredClone(approval);
      }

      this.persistReplacement(after);
      return structuredClone(after);
    });
  }

  pause(selector: string, reason?: string): Promise<CronJob> {
    return this.enqueueMutation(() => {
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
    });
  }

  resume(selector: string): Promise<CronJob> {
    return this.enqueueMutation(() => {
      const before = selectJob(this.jobs.values(), selector);
      const after: CronJob = {
        ...before,
        state: "active",
        updatedAt: this.clock.now().toISOString(),
      };
      delete after.pauseReason;

      this.persistReplacement(after);
      return structuredClone(after);
    });
  }

  delete(selector: string): Promise<void> {
    return this.enqueueMutation(() => {
      const job = selectJob(this.jobs.values(), selector);
      this.persistAndApply({
        version: 1,
        type: "job_deleted",
        at: this.clock.now().toISOString(),
        jobId: job.id,
      });
    });
  }

  transitionState(
    selector: string,
    state: CronJob["state"],
    reason?: string,
  ): Promise<CronJob> {
    return this.enqueueMutation(() => {
      const before = selectJob(this.jobs.values(), selector);
      const after: CronJob = {
        ...before,
        state,
        updatedAt: this.clock.now().toISOString(),
      };
      if (reason === undefined) delete after.pauseReason;
      else after.pauseReason = reason;
      this.persistReplacement(after);
      return structuredClone(after);
    });
  }

  list(): CronJob[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  get(id: string): CronJob | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : structuredClone(job);
  }

  recordRun(
    jobId: string,
    result: DispatchResult,
    scheduledAt: Date,
  ): Promise<void> {
    return this.enqueueMutation(() => {
      validateRunInput(result, scheduledAt);
      const before = this.requireJob(jobId);
      const scheduledAtIso = scheduledAt.toISOString();
      const now = this.clock.now().toISOString();

      if (result.outcome === "dispatched") {
        const dispatched: CronJob = {
          ...before,
          lastOccurrenceAt: scheduledAtIso,
          lastDispatchAt: now,
          lastTechnicalOutcome: "dispatched",
        };
        this.jobs.set(jobId, dispatched);
        this.markCheckpointDirty(0);
        this.notifyChanged();
        return;
      }

      const runCount = before.runCount + 1;
      const attributedTokens = before.attributedTokens + result.tokens;
      const consecutiveFailures = nextFailureCount(
        before.consecutiveFailures,
        result.outcome,
      );
      validateCounter("runCount", runCount);
      validateCounter("attributedTokens", attributedTokens);
      validateCounter("consecutiveFailures", consecutiveFailures);

      const after: CronJob = {
        ...before,
        runCount,
        attributedTokens,
        consecutiveFailures,
        lastOccurrenceAt: scheduledAtIso,
        lastTechnicalOutcome: result.outcome,
      };
      const hasDispatchForOccurrence =
        before.lastOccurrenceAt === scheduledAtIso &&
        before.lastDispatchAt !== undefined;
      if (!hasDispatchForOccurrence) after.lastDispatchAt = now;
      if (result.outcome === "settled") after.lastSettledAt = now;

      if (
        after.consecutiveFailures >= DEFAULT_LIMITS.maxConsecutiveFailures &&
        after.state !== "paused"
      ) {
        after.state = "paused";
        after.pauseReason = `Paused after ${after.consecutiveFailures} consecutive failures`;
        after.updatedAt = now;
        this.persistReplacement(after, () => this.markCheckpointDirty(1));
      } else if (
        after.schedule.kind === "once" ||
        (after.maxRuns !== undefined && after.runCount >= after.maxRuns) ||
        (after.tokenBudget !== undefined &&
          after.attributedTokens >= after.tokenBudget)
      ) {
        after.state = "completed";
        delete after.pauseReason;
        after.updatedAt = now;
        this.persistReplacement(after, () => this.markCheckpointDirty(1));
      } else {
        this.jobs.set(jobId, after);
        this.markCheckpointDirty(1);
        this.notifyChanged();
      }
    });
  }

  shouldFlushCheckpoint(policy: CheckpointPolicy): boolean {
    if (this.dirtySinceMs === undefined) return false;
    return (
      this.dirtyRunCount >= policy.maxRuns ||
      this.clock.now().getTime() - this.dirtySinceMs >= policy.maxAgeMs
    );
  }

  flushCheckpoint(): Promise<void> {
    return this.enqueueMutation(() => {
      if (this.dirtySinceMs === undefined) return;

      const event: CronEvent = {
        version: 1,
        type: "metrics_checkpoint",
        at: this.clock.now().toISOString(),
        jobs: [...this.jobs.values()].map(toMetrics),
      };
      this.persistAndApply(event, () => {
        this.dirtyRunCount = 0;
        this.dirtySinceMs = undefined;
      });
    });
  }

  beginExecution(jobId: string, adaptive: boolean): string {
    if (this.pendingMutationCount > 0) {
      throw new Error(
        "Cannot begin execution while a durable mutation is pending",
      );
    }
    this.requireJob(jobId);
    if (this.activeExecution) {
      throw new Error("A cron execution is already active");
    }
    const token = crypto.randomUUID();
    this.activeExecution = {
      token,
      jobId,
      adaptive,
      decisionMade: false,
    };
    return token;
  }

  getActiveExecution(): ActiveExecution | undefined {
    return this.activeExecution === undefined
      ? undefined
      : Object.freeze({ ...this.activeExecution });
  }

  endExecution(token: string): void {
    this.requireActiveToken(token);
    this.activeExecution = undefined;
  }

  setAdaptiveWakeup(
    token: string,
    at: Date,
    reason: string,
    fallbackUsed = false,
  ): Promise<void> {
    return this.enqueueMutation(() => {
      const execution = this.requireAdaptiveToken(token);
      const before = this.requireJob(execution.jobId);
      if (before.schedule.kind !== "adaptive") {
        throw new Error(`Cron job '${execution.jobId}' is not adaptive`);
      }
      const after: CronJob = {
        ...before,
        schedule: {
          kind: "adaptive",
          nextWakeAt: at.toISOString(),
          fallbackUsed,
        },
        state: "active",
        updatedAt: this.clock.now().toISOString(),
      };
      delete after.pauseReason;
      validateAdaptiveWakeup(at.toISOString(), this.clock.now());
      void reason;

      this.persistReplacement(after, () => {
        execution.decisionMade = true;
      });
    });
  }

  stopAdaptive(token: string, reason: string): Promise<void> {
    return this.enqueueMutation(() => {
      const execution = this.requireAdaptiveToken(token);
      const before = this.requireJob(execution.jobId);
      if (before.schedule.kind !== "adaptive") {
        throw new Error(`Cron job '${execution.jobId}' is not adaptive`);
      }
      const after: CronJob = {
        ...before,
        state: "paused",
        pauseReason: reason,
        updatedAt: this.clock.now().toISOString(),
      };

      this.persistReplacement(after, () => {
        execution.decisionMade = true;
      });
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    this.pendingMutationCount += 1;
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(
      (value) => {
        this.finishMutation();
        return value;
      },
      (error: unknown) => {
        this.finishMutation();
        throw error;
      },
    );
  }

  private generateUniqueId(): string {
    const existingIds = new Set(
      [...this.jobs.keys()].map((id) => id.trim().toLowerCase()),
    );
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = this.idFactory().trim().toLowerCase();
      if (id.length > 0 && !existingIds.has(id)) return id;
    }
    throw new Error(
      `Unable to generate a unique cron job ID after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }

  private validateCandidate(
    candidate: ProposedJob,
    unsafeSeconds: boolean,
    now: Date,
  ): void {
    validateJob(candidate, this.jobs.values());
    validateExpiry(candidate.expiresAt, now);
    validatePositiveLimit("maxRuns", candidate.maxRuns);
    validatePositiveLimit("tokenBudget", candidate.tokenBudget);
    if (candidate.execution.kind === "isolated") {
      validatePositiveInteger("timeout", candidate.execution.timeoutMs);
    }
    validateSchedule(candidate.schedule, now, unsafeSeconds, candidate.maxRuns);
  }

  private requireActiveToken(token: string): MutableActiveExecution {
    if (!this.activeExecution || this.activeExecution.token !== token) {
      throw new Error(
        "Cron execution token does not match the active execution",
      );
    }
    return this.activeExecution;
  }

  private requireAdaptiveToken(token: string): MutableActiveExecution {
    const execution = this.requireActiveToken(token);
    if (!execution.adaptive) {
      throw new Error("The active cron execution is not adaptive");
    }
    return execution;
  }

  private requireJob(jobId: string): CronJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Cron job not found: ${jobId}`);
    return job;
  }

  private markCheckpointDirty(finalRunIncrement: number): void {
    this.dirtyRunCount += finalRunIncrement;
    this.dirtySinceMs ??= this.clock.now().getTime();
  }

  private persistReplacement(job: CronJob, beforeNotify?: () => void): void {
    this.persistAndApply(
      {
        version: 1,
        type: "job_replaced",
        at: this.clock.now().toISOString(),
        job,
      },
      beforeNotify,
    );
  }

  private persistAndApply(event: CronEvent, beforeNotify?: () => void): void {
    assertCronEvent(event);
    this.store.append(structuredClone(event));
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
    beforeNotify?.();
    this.notifyChanged();
  }

  private finishMutation(): void {
    this.pendingMutationCount -= 1;
    if (this.pendingMutationCount === 0 && this.changeNotificationPending) {
      this.changeNotificationPending = false;
      this.deliverChangedNotification();
    }
  }

  private notifyChanged(): void {
    if (this.pendingMutationCount > 0) {
      this.changeNotificationPending = true;
      return;
    }
    this.deliverChangedNotification();
  }

  private deliverChangedNotification(): void {
    try {
      this.onChanged?.();
    } catch (error) {
      try {
        this.onObserverError?.(error);
      } catch {
        // Observer error reporting is deliberately isolated from service state.
      }
    }
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
    name: (draft.name ?? `job-${id}`).trim(),
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
    name: (patch.name ?? before.name).trim(),
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

function validateExpiry(expiresAt: string, now: Date): void {
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid cron job expiry");
  if (timestamp <= now.getTime()) {
    throw new Error("Cron job expiry must be in the future");
  }
}

function validateSchedule(
  schedule: Schedule,
  now: Date,
  unsafeSeconds: boolean,
  maxRuns: number | undefined,
): void {
  switch (schedule.kind) {
    case "interval":
      validateRecurringInterval(
        schedule.intervalMs,
        schedule.anchorAt,
        unsafeSeconds,
        maxRuns,
      );
      return;
    case "cron":
      nextOccurrence(schedule, now);
      return;
    case "once":
      validateFutureTimestamp("One-shot schedule", schedule.at, now);
      return;
    case "adaptive":
      validateAdaptiveWakeup(schedule.nextWakeAt, now);
      return;
    case "maintenance":
      if (schedule.cadence === "adaptive") return;
      validateRecurringInterval(
        schedule.cadence.intervalMs,
        schedule.cadence.anchorAt,
        unsafeSeconds,
        maxRuns,
      );
      return;
    default:
      throw new Error("Invalid cron schedule");
  }
}

function validateRecurringInterval(
  intervalMs: number,
  anchorAt: string,
  unsafeSeconds: boolean,
  maxRuns: number | undefined,
): void {
  validatePositiveInteger("interval", intervalMs);
  validateTimestamp("interval anchor", anchorAt);
  if (intervalMs < DEFAULT_LIMITS.minRecurringMs) {
    if (!unsafeSeconds) {
      throw new Error("Sub-minute intervals require unsafeSeconds");
    }
    if (maxRuns === undefined) {
      throw new Error("Sub-minute intervals require maxRuns");
    }
  }
}

function validateAdaptiveWakeup(value: string, now: Date): void {
  validateFutureTimestamp("Adaptive wakeup", value, now);
}

function validateFutureTimestamp(
  label: string,
  value: string,
  now: Date,
): void {
  const timestamp = validateTimestamp(label, value);
  if (timestamp <= now.getTime())
    throw new Error(`${label} must be in the future`);
}

function validateTimestamp(label: string, value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error(`Invalid ${label} timestamp`);
  return timestamp;
}

function validatePositiveLimit(label: string, value: number | undefined): void {
  if (value !== undefined) validatePositiveInteger(label, value);
}

function validatePositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function validateRunInput(result: DispatchResult, scheduledAt: Date): void {
  if (!Number.isFinite(scheduledAt.getTime())) {
    throw new Error("Run schedule timestamp is invalid");
  }
  if (!TECHNICAL_OUTCOMES.has(result.outcome)) {
    throw new Error(`Invalid run outcome: ${String(result.outcome)}`);
  }
  if (!Number.isFinite(result.tokens) || result.tokens < 0) {
    throw new Error("Run token count must be a non-negative finite number");
  }
}

function validateCounter(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite counter`);
  }
}

function nextFailureCount(
  current: number,
  outcome: Exclude<TechnicalOutcome, "dispatched">,
): number {
  if (outcome === "settled") return 0;
  return current + 1;
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
