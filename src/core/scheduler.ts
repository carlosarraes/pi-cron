import { nextOccurrence } from "../domain/schedule.js";
import type {
  Clock,
  CronJob,
  Dispatcher,
  DispatchResult,
  RuntimeStatus,
} from "../domain/types.js";

const CHECKPOINT_POLICY = { maxRuns: 10, maxAgeMs: 5 * 60_000 } as const;

export interface SchedulerService {
  list(): CronJob[];
  get(id: string): CronJob | undefined;
  recordRun(
    jobId: string,
    result: DispatchResult,
    scheduledAt: Date,
  ): Promise<void>;
  shouldFlushCheckpoint(policy: { maxRuns: number; maxAgeMs: number }): boolean;
  flushCheckpoint(): Promise<void>;
}

export interface SchedulerOptions {
  service: SchedulerService;
  dispatcher: Dispatcher;
  clock: Clock;
  onError?: (error: unknown) => void;
}

export interface NextDue {
  jobId: string;
  name: string;
  at: Date;
}

/** One-timer, globally serial scheduler with per-job busy coalescing. */
export class Scheduler {
  private readonly service: SchedulerService;
  private readonly dispatcher: Dispatcher;
  private readonly clock: Clock;
  private readonly onError: (error: unknown) => void;
  private readonly occurrences = new Map<string, Date>();
  private readonly pending = new Map<string, Date>();
  private timer: unknown;
  private runningJobId: string | undefined;
  private runningStartedAt: Date | undefined;
  private started = false;

  constructor(options: SchedulerOptions) {
    this.service = options.service;
    this.dispatcher = options.dispatcher;
    this.clock = options.clock;
    this.onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
    this.occurrences.clear();
    this.pending.clear();
  }

  refresh(): void {
    this.clearTimer();
    this.occurrences.clear();
    if (!this.started) return;

    const now = this.clock.now();
    for (const job of this.service.list()) {
      if (!isEligible(job, now)) continue;
      const next = nextOccurrence(job.schedule, now);
      if (next) this.occurrences.set(job.id, next);
    }
    this.armNearest();
  }

  async onAgentSettled(): Promise<void> {
    await this.drain();
  }

  async runNow(jobId: string): Promise<void> {
    const job = this.service.get(jobId);
    if (!job) throw new Error(`Cron job '${jobId}' not found`);
    if (job.state !== "active") {
      throw new Error(`Cron job '${jobId}' is not active`);
    }
    if (!this.pending.has(jobId) && this.runningJobId !== jobId) {
      this.pending.set(jobId, this.clock.now());
    }
    await this.drain();
  }

  getRuntimeStatus(jobId: string): RuntimeStatus {
    if (this.runningJobId === jobId) {
      return {
        state: "running",
        ...(this.runningStartedAt
          ? { startedAt: this.runningStartedAt.toISOString() }
          : {}),
      };
    }
    const pendingSince = this.pending.get(jobId);
    return pendingSince
      ? { state: "pending", pendingSince: pendingSince.toISOString() }
      : { state: "idle" };
  }

  nextDue(): NextDue | undefined {
    const candidates: Array<{ jobId: string; at: Date }> = [
      ...this.occurrences.entries(),
      ...this.pending.entries(),
    ].map(([jobId, at]) => ({ jobId, at }));
    candidates.sort(compareDue);
    for (const candidate of candidates) {
      const job = this.service.get(candidate.jobId);
      if (job) return { ...candidate, name: job.name };
    }
    return undefined;
  }

  private armNearest(): void {
    const next = [...this.occurrences.entries()]
      .map(([jobId, at]) => ({ jobId, at }))
      .sort(compareDue)[0];
    if (!next) return;
    const delay = Math.max(0, next.at.getTime() - this.clock.now().getTime());
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.onTimer().catch(this.onError);
    }, delay);
  }

  private async onTimer(): Promise<void> {
    if (!this.started) return;
    const now = this.clock.now();
    for (const [jobId, at] of this.occurrences) {
      if (at.getTime() > now.getTime()) continue;
      const job = this.service.get(jobId);
      if (job && isEligible(job, now) && !this.pending.has(jobId)) {
        this.pending.set(jobId, at);
      }
    }

    // Recompute from wall-clock time. This intentionally skips catch-up and
    // keeps interval schedules anchored rather than drifting from completion.
    this.refresh();
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.runningJobId || !this.dispatcher.isIdle()) return;

    while (!this.runningJobId && this.dispatcher.isIdle()) {
      const next = [...this.pending.entries()]
        .map(([jobId, at]) => ({ jobId, at }))
        .sort(compareDue)[0];
      if (!next) return;

      this.pending.delete(next.jobId);
      const job = this.service.get(next.jobId);
      if (!job || !isEligible(job, this.clock.now())) continue;

      this.runningJobId = next.jobId;
      this.runningStartedAt = this.clock.now();
      try {
        const result = await this.dispatcher.execute(job, next.at);
        await this.service.recordRun(job.id, result, next.at);
        if (this.service.shouldFlushCheckpoint(CHECKPOINT_POLICY)) {
          await this.service.flushCheckpoint();
        }
      } catch (error) {
        this.onError(error);
      } finally {
        this.runningJobId = undefined;
        this.runningStartedAt = undefined;
        if (this.started) this.refresh();
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function isEligible(job: CronJob, now: Date): boolean {
  if (job.state !== "active") return false;
  if (Date.parse(job.expiresAt) <= now.getTime()) return false;
  if (job.maxRuns !== undefined && job.runCount >= job.maxRuns) return false;
  if (
    job.tokenBudget !== undefined &&
    job.attributedTokens >= job.tokenBudget
  ) {
    return false;
  }
  return true;
}

function compareDue(
  left: { jobId: string; at: Date },
  right: { jobId: string; at: Date },
): number {
  return (
    left.at.getTime() - right.at.getTime() ||
    left.jobId.localeCompare(right.jobId)
  );
}
