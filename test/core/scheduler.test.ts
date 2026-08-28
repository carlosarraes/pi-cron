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
    runCount: 1,
    attributedTokens: 0,
    lastOccurrenceAt: NOW,
    consecutiveFailures: 0,
    approval: { approvedAt: NOW, fingerprint: "ok" },
    originSessionId: "session",
    ...overrides,
  };
}

function neverRunJob(
  id: string,
  schedule: CronJob["schedule"],
  overrides: Partial<CronJob> = {},
): CronJob {
  const current = job(id, 60_000, overrides);
  delete current.lastOccurrenceAt;
  return { ...current, schedule, runCount: 0 };
}

class FakeService implements SchedulerService {
  readonly jobs = new Map<string, CronJob>();
  readonly recorded: Array<{ id: string; at: Date; result: DispatchResult }> =
    [];
  flushes = 0;
  shouldFlush = false;
  onSkip?: () => void;

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

  async recordSkip(id: string, at: Date): Promise<void> {
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, {
      ...current,
      skippedRuns: (current.skippedRuns ?? 0) + 1,
      lastSkippedAt: at.toISOString(),
    });
    this.onSkip?.();
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
  it("dispatches a never-run interval immediately and keeps its anchor", async () => {
    const { scheduler, clock, dispatcher } = harness([
      neverRunJob("interval", {
        kind: "interval",
        intervalMs: 2 * 60 * 60_000,
        anchorAt: NOW,
      }),
    ]);

    scheduler.start();
    await settleAsync();

    expect(dispatcher.calls.map((call) => call.at.toISOString())).toEqual([
      NOW,
    ]);
    expect(scheduler.nextDue()?.at.toISOString()).toBe(
      "2026-07-15T12:00:00.000Z",
    );
    expect(clock.pendingTimerCount()).toBe(1);
  });

  it.each<[string, CronJob["schedule"]]>([
    [
      "adaptive",
      {
        kind: "adaptive",
        nextWakeAt: "2026-07-15T10:01:00.000Z",
        fallbackUsed: false,
      },
    ],
    ["maintenance adaptive", { kind: "maintenance", cadence: "adaptive" }],
    [
      "maintenance interval",
      {
        kind: "maintenance",
        cadence: { intervalMs: 15 * 60_000, anchorAt: NOW },
      },
    ],
  ])("dispatches never-run %s jobs immediately", async (_name, schedule) => {
    const { scheduler, dispatcher } = harness([neverRunJob("job-1", schedule)]);

    scheduler.start();
    await settleAsync();

    expect(dispatcher.calls[0]?.at.toISOString()).toBe(NOW);
  });

  it.each<[string, CronJob["schedule"]]>([
    ["cron", { kind: "cron", expression: "0 12 * * *", timezone: "UTC" }],
    [
      "once",
      {
        kind: "once",
        at: "2026-07-15T12:00:00.000Z",
        original: "2h",
      },
    ],
  ])("does not immediately dispatch never-run %s jobs", async (_name, schedule) => {
    const { scheduler, dispatcher } = harness([neverRunJob("job-1", schedule)]);

    scheduler.start();
    await settleAsync();

    expect(dispatcher.calls).toEqual([]);
  });

  it("coalesces a busy initial occurrence and never duplicates it on refresh", async () => {
    const { scheduler, dispatcher } = harness([
      neverRunJob("job-1", {
        kind: "interval",
        intervalMs: 2 * 60 * 60_000,
        anchorAt: NOW,
      }),
    ]);
    dispatcher.idle = false;

    scheduler.start();
    scheduler.refresh();
    scheduler.refresh();

    expect(scheduler.getRuntimeStatus("job-1")).toEqual({
      state: "pending",
      pendingSince: NOW,
    });

    dispatcher.idle = true;
    await scheduler.onAgentSettled();
    await settleAsync();
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("cancels an unstarted initial run on pause and requeues it on resume", async () => {
    const initial = neverRunJob("job-1", {
      kind: "interval",
      intervalMs: 2 * 60 * 60_000,
      anchorAt: NOW,
    });
    const { scheduler, dispatcher, service } = harness([initial]);
    dispatcher.idle = false;
    scheduler.start();
    expect(scheduler.getRuntimeStatus("job-1").state).toBe("pending");

    service.jobs.set("job-1", { ...initial, state: "paused" });
    scheduler.refresh();
    expect(scheduler.getRuntimeStatus("job-1").state).toBe("idle");

    service.jobs.set("job-1", { ...initial, state: "active" });
    scheduler.refresh();
    expect(scheduler.getRuntimeStatus("job-1").state).toBe("pending");

    dispatcher.idle = true;
    await scheduler.onAgentSettled();
    await settleAsync();
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("preserves one later occurrence that becomes due during the initial run", async () => {
    const { scheduler, clock, dispatcher } = harness([
      neverRunJob("slow-initial", {
        kind: "interval",
        intervalMs: 60_000,
        anchorAt: NOW,
      }),
    ]);
    const gate = deferred<DispatchResult>();
    let calls = 0;
    dispatcher.executeImpl = async () => {
      calls += 1;
      return calls === 1 ? gate.promise : { outcome: "settled", tokens: 0 };
    };

    scheduler.start();
    await settleAsync();
    clock.advanceBy(3 * 60_000);
    await settleAsync();
    gate.resolve({ outcome: "settled", tokens: 0 });
    await settleAsync();

    expect(dispatcher.calls.map((call) => call.at.toISOString())).toEqual([
      NOW,
      "2026-07-15T10:01:00.000Z",
    ]);
  });

  it("does not add another immediate run after the first occurrence is recorded", async () => {
    const { scheduler, dispatcher } = harness([
      neverRunJob("job-1", {
        kind: "interval",
        intervalMs: 2 * 60 * 60_000,
        anchorAt: NOW,
      }),
    ]);
    scheduler.start();
    await settleAsync();
    expect(dispatcher.calls).toHaveLength(1);

    scheduler.stop();
    scheduler.start();
    await settleAsync();
    expect(dispatcher.calls).toHaveLength(1);
  });

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

  it("skips due occurrences while the same skip-policy job is running", async () => {
    const { scheduler, clock, dispatcher, service } = harness([
      job("slow", 60_000, { overlap: "skip" }),
    ]);
    const gate = deferred<DispatchResult>();
    let calls = 0;
    dispatcher.executeImpl = async () => {
      calls += 1;
      return calls === 1 ? gate.promise : { outcome: "settled", tokens: 0 };
    };
    scheduler.start();

    clock.advanceBy(60_000);
    await settleAsync();
    clock.advanceBy(60_000);
    await settleAsync();

    expect(dispatcher.calls.map((call) => call.at.toISOString())).toEqual([
      "2026-07-15T10:01:00.000Z",
    ]);
    expect(service.jobs.get("slow")).toMatchObject({
      skippedRuns: 1,
      lastSkippedAt: "2026-07-15T10:02:00.000Z",
    });

    gate.resolve({ outcome: "settled", tokens: 0 });
    await settleAsync();
    clock.advanceBy(60_000);
    await settleAsync();

    expect(dispatcher.calls.map((call) => call.at.toISOString())).toEqual([
      "2026-07-15T10:01:00.000Z",
      "2026-07-15T10:03:00.000Z",
    ]);
  });

  it("preserves simultaneous ticks when recording a skip refreshes the scheduler", async () => {
    const { scheduler, clock, dispatcher, service } = harness([
      job("a-running", 60_000, { overlap: "skip" }),
      job("b-due", 120_000),
    ]);
    const gate = deferred<DispatchResult>();
    dispatcher.executeImpl = async () => gate.promise;
    service.onSkip = () => scheduler.refresh();
    scheduler.start();

    clock.advanceBy(60_000);
    await settleAsync();
    clock.advanceBy(60_000);
    await settleAsync();

    expect(service.jobs.get("a-running")?.skippedRuns).toBe(1);
    expect(scheduler.getRuntimeStatus("b-due")).toEqual({
      state: "pending",
      pendingSince: "2026-07-15T10:02:00.000Z",
    });

    gate.resolve({ outcome: "settled", tokens: 0 });
    await settleAsync();
  });

  it("keeps a skip-policy job pending when a different job is running", async () => {
    const { scheduler, clock, dispatcher, service } = harness([
      job("a-running", 60_000),
      job("b-waiting", 120_000, { overlap: "skip" }),
    ]);
    const gate = deferred<DispatchResult>();
    let calls = 0;
    dispatcher.executeImpl = async () => {
      calls += 1;
      return calls === 1 ? gate.promise : { outcome: "settled", tokens: 0 };
    };
    scheduler.start();

    clock.advanceBy(60_000);
    await settleAsync();
    clock.advanceBy(60_000);
    await settleAsync();

    expect(scheduler.getRuntimeStatus("b-waiting")).toEqual({
      state: "pending",
      pendingSince: "2026-07-15T10:02:00.000Z",
    });
    expect(service.jobs.get("b-waiting")?.skippedRuns).toBeUndefined();

    const running = service.jobs.get("a-running");
    if (running) service.jobs.set(running.id, { ...running, state: "paused" });
    gate.resolve({ outcome: "settled", tokens: 0 });
    await settleAsync();

    expect(dispatcher.calls.map((call) => call.jobId)).toEqual([
      "a-running",
      "b-waiting",
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
