import { describe, expect, it } from "vitest";
import { Scheduler, type SchedulerService } from "../../src/core/scheduler.js";
import type {
  CronJob,
  Dispatcher,
  DispatchResult,
} from "../../src/domain/types.js";
import { FakeClock } from "../helpers/fakes.js";

const NOW = "2026-07-15T10:00:00.000Z";

function job(
  id: string,
  intervalMs = 60_000,
  overrides: Partial<CronJob> = {},
): CronJob {
  return {
    version: 1,
    id,
    name: id,
    prompt: { kind: "text", text: id },
    schedule: { kind: "interval", intervalMs, anchorAt: NOW },
    state: "active",
    execution: { kind: "main" },
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-07-22T10:00:00.000Z",
    runCount: 0,
    attributedTokens: 0,
    consecutiveFailures: 0,
    approval: { approvedAt: NOW, fingerprint: "ok" },
    originSessionId: "session",
    ...overrides,
  };
}

class FakeService implements SchedulerService {
  readonly jobs = new Map<string, CronJob>();
  readonly recorded: Array<{ id: string; at: Date; result: DispatchResult }> =
    [];
  flushes = 0;
  shouldFlush = false;

  constructor(jobs: CronJob[]) {
    for (const current of jobs) this.jobs.set(current.id, current);
  }

  list(): CronJob[] {
    return [...this.jobs.values()].map((value) => structuredClone(value));
  }

  get(id: string): CronJob | undefined {
    const value = this.jobs.get(id);
    return value ? structuredClone(value) : undefined;
  }

  async recordRun(id: string, result: DispatchResult, at: Date): Promise<void> {
    this.recorded.push({ id, result, at });
    const current = this.jobs.get(id);
    if (current && result.outcome !== "dispatched") {
      this.jobs.set(id, { ...current, runCount: current.runCount + 1 });
    }
  }

  shouldFlushCheckpoint(): boolean {
    return this.shouldFlush;
  }

  async flushCheckpoint(): Promise<void> {
    this.flushes += 1;
    this.shouldFlush = false;
  }
}

class FakeDispatcher implements Dispatcher {
  idle = true;
  active = 0;
  maxActive = 0;
  readonly calls: Array<{ jobId: string; at: Date }> = [];
  executeImpl: (job: CronJob, at: Date) => Promise<DispatchResult> =
    async () => ({ outcome: "settled", tokens: 1 });

  isIdle(): boolean {
    return this.idle;
  }

  async execute(job: CronJob, at: Date): Promise<DispatchResult> {
    this.calls.push({ jobId: job.id, at });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.executeImpl(job, at);
    } finally {
      this.active -= 1;
    }
  }
}

function harness(jobs: CronJob[]) {
  const clock = new FakeClock(new Date(NOW));
  const service = new FakeService(jobs);
  const dispatcher = new FakeDispatcher();
  const errors: unknown[] = [];
  const scheduler = new Scheduler({
    service,
    dispatcher,
    clock,
    onError: (error) => errors.push(error),
  });
  return { clock, service, dispatcher, scheduler, errors };
}

async function settleAsync(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Scheduler", () => {
  it("arms one timer for the nearest eligible occurrence", async () => {
    const { scheduler, clock, dispatcher } = harness([
      job("later", 120_000),
      job("first", 60_000),
    ]);

    scheduler.start();
    expect(clock.pendingTimerCount()).toBe(1);
    expect(scheduler.nextDue()).toMatchObject({ jobId: "first" });

    clock.advanceBy(60_000);
    await settleAsync();
    expect(dispatcher.calls.map((call) => call.jobId)).toEqual(["first"]);
    expect(clock.pendingTimerCount()).toBe(1);
  });

  it("does not schedule inactive, expired, or exhausted jobs", () => {
    const { scheduler, clock } = harness([
      job("paused", 60_000, { state: "paused" }),
      job("completed", 60_000, { state: "completed" }),
      job("missed", 60_000, { state: "missed" }),
      job("expired", 60_000, { expiresAt: NOW }),
      job("maxed", 60_000, { maxRuns: 1, runCount: 1 }),
      job("tokens", 60_000, { tokenBudget: 10, attributedTokens: 10 }),
    ]);

    scheduler.start();
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("coalesces all busy occurrences into one oldest pending run", async () => {
    const { scheduler, clock, dispatcher } = harness([job("job-1")]);
    dispatcher.idle = false;
    scheduler.start();

    clock.advanceBy(5 * 60_000);
    await settleAsync();
    expect(scheduler.getRuntimeStatus("job-1")).toEqual({
      state: "pending",
      pendingSince: "2026-07-15T10:01:00.000Z",
    });

    dispatcher.idle = true;
    await scheduler.onAgentSettled();
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]?.at.toISOString()).toBe(
      "2026-07-15T10:01:00.000Z",
    );
  });

  it("drains oldest pending jobs fairly with global concurrency one", async () => {
    const { scheduler, clock, dispatcher } = harness([
      job("second", 120_000),
      job("first", 60_000),
    ]);
    dispatcher.idle = false;
    scheduler.start();
    clock.advanceBy(3 * 60_000);
    await settleAsync();

    dispatcher.idle = true;
    await scheduler.onAgentSettled();
    await settleAsync();

    expect(dispatcher.calls.map((call) => call.jobId)).toEqual([
      "first",
      "second",
    ]);
    expect(dispatcher.maxActive).toBe(1);
  });

  it("keeps a second due job pending while one execution is unresolved", async () => {
    const { scheduler, clock, dispatcher } = harness([job("a"), job("b")]);
    const gate = deferred<DispatchResult>();
    let calls = 0;
    dispatcher.executeImpl = async () => {
      calls += 1;
      return calls === 1 ? gate.promise : { outcome: "settled", tokens: 0 };
    };
    scheduler.start();

    clock.advanceBy(60_000);
    await settleAsync();
    expect(dispatcher.calls).toHaveLength(1);
    expect(["pending", "running"]).toContain(
      scheduler.getRuntimeStatus("b").state,
    );

    gate.resolve({ outcome: "settled", tokens: 0 });
    await settleAsync();
    expect(dispatcher.calls).toHaveLength(2);
    expect(dispatcher.maxActive).toBe(1);
  });

  it("coalesces an occurrence that becomes due while the same job runs", async () => {
    const { scheduler, clock, dispatcher } = harness([job("slow")]);
    const gate = deferred<DispatchResult>();
    let calls = 0;
    dispatcher.executeImpl = async () => {
      calls += 1;
      return calls === 1 ? gate.promise : { outcome: "settled", tokens: 0 };
    };
    scheduler.start();

    clock.advanceBy(60_000);
    await settleAsync();
    clock.advanceBy(3 * 60_000);
    await settleAsync();
    expect(scheduler.getRuntimeStatus("slow").state).toBe("running");

    gate.resolve({ outcome: "settled", tokens: 0 });
    await settleAsync();
    expect(dispatcher.calls.map((call) => call.at.toISOString())).toEqual([
      "2026-07-15T10:01:00.000Z",
      "2026-07-15T10:02:00.000Z",
    ]);
  });

  it("uses anchored recurrence without completion drift or catch-up", async () => {
    const { scheduler, clock, dispatcher } = harness([job("anchored")]);
    dispatcher.idle = false;
    scheduler.start();
    clock.advanceBy(5 * 60_000);
    await settleAsync();

    dispatcher.idle = true;
    await scheduler.onAgentSettled();
    expect(dispatcher.calls.map((call) => call.at.toISOString())).toEqual([
      "2026-07-15T10:01:00.000Z",
    ]);

    clock.advanceBy(60_000);
    await settleAsync();
    expect(dispatcher.calls.map((call) => call.at.toISOString())).toEqual([
      "2026-07-15T10:01:00.000Z",
      "2026-07-15T10:06:00.000Z",
    ]);
  });

  it("records results and flushes checkpoints when requested", async () => {
    const { scheduler, clock, service } = harness([job("job-1")]);
    service.shouldFlush = true;
    scheduler.start();

    clock.advanceBy(60_000);
    await settleAsync();

    expect(service.recorded).toHaveLength(1);
    expect(service.flushes).toBe(1);
  });

  it("reports dispatch failures and continues scheduling", async () => {
    const { scheduler, clock, dispatcher, errors } = harness([job("job-1")]);
    dispatcher.executeImpl = async () => {
      throw new Error("dispatch failed");
    };
    scheduler.start();

    clock.advanceBy(60_000);
    await settleAsync();

    expect(errors).toHaveLength(1);
    expect(clock.pendingTimerCount()).toBe(1);
  });

  it("runNow queues one active job and rejects inactive jobs", async () => {
    const { scheduler, dispatcher } = harness([
      job("active"),
      job("paused", 60_000, { state: "paused" }),
    ]);
    scheduler.start();

    await scheduler.runNow("active");
    expect(dispatcher.calls.map((call) => call.jobId)).toEqual(["active"]);
    await expect(scheduler.runNow("paused")).rejects.toThrow("not active");
  });

  it("stop clears timer and pending state", async () => {
    const { scheduler, clock, dispatcher } = harness([job("job-1")]);
    dispatcher.idle = false;
    scheduler.start();
    clock.advanceBy(60_000);
    await settleAsync();
    expect(scheduler.getRuntimeStatus("job-1").state).toBe("pending");

    scheduler.stop();

    expect(clock.pendingTimerCount()).toBe(0);
    expect(scheduler.getRuntimeStatus("job-1")).toEqual({ state: "idle" });
  });

  it("start is idempotent and refresh keeps one timer", () => {
    const { scheduler, clock } = harness([job("job-1")]);
    scheduler.start();
    scheduler.start();
    scheduler.refresh();
    scheduler.refresh();
    expect(clock.pendingTimerCount()).toBe(1);
  });
});
