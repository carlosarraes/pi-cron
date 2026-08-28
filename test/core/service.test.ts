import { describe, expect, it, vi } from "vitest";
import { CronService, type JobDraft } from "../../src/core/service.js";
import type {
  ApprovalPort,
  CronEvent,
  CronJob,
  DispatchResult,
  EventStore,
  ProposedJob,
} from "../../src/domain/types.js";
import { FakeClock } from "../helpers/fakes.js";

const NOW = "2026-07-14T12:00:00.000Z";
const APPROVAL = { approvedAt: NOW, fingerprint: "approved-new" };

class MemoryStore implements EventStore {
  readonly appended: CronEvent[] = [];

  constructor(
    private readonly loaded: CronEvent[] = [],
    public failure?: string,
  ) {}

  load(): CronEvent[] {
    return this.loaded;
  }

  append(event: CronEvent): void {
    if (this.failure) throw new Error(this.failure);
    this.appended.push(structuredClone(event));
  }
}

function validDraft(overrides: Partial<JobDraft> = {}): JobDraft {
  return {
    name: "Daily report",
    prompt: { kind: "text", text: "Summarize progress" },
    schedule: {
      kind: "interval",
      intervalMs: 3_600_000,
      anchorAt: NOW,
    },
    execution: {
      kind: "isolated",
      model: "model-a",
      effort: "medium",
      tools: ["read"],
      skills: [],
      extensions: [],
      notify: false,
      timeoutMs: 60_000,
    },
    ...overrides,
  };
}

function storedJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: "abcd1234",
    name: "Daily report",
    prompt: { kind: "text", text: "Summarize progress" },
    schedule: {
      kind: "interval",
      intervalMs: 3_600_000,
      anchorAt: NOW,
    },
    execution: {
      kind: "isolated",
      model: "model-a",
      effort: "medium",
      tools: ["read"],
      skills: [],
      extensions: [],
      notify: false,
      timeoutMs: 60_000,
    },
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-07-21T12:00:00.000Z",
    runCount: 0,
    attributedTokens: 0,
    consecutiveFailures: 0,
    approval: { approvedAt: NOW, fingerprint: "approved" },
    originSessionId: "session-1",
    ...overrides,
  };
}

function created(job = storedJob()): CronEvent {
  return { version: 1, type: "job_created", at: NOW, job };
}

function makeService({
  events = [],
  store = new MemoryStore(),
  approval = APPROVAL,
  approvals,
  idFactory = () => "deadbeef",
  onChanged,
  onObserverError,
}: {
  events?: CronEvent[];
  store?: MemoryStore;
  approval?: CronJob["approval"] | null;
  approvals?: ApprovalPort;
  idFactory?: () => string;
  onChanged?: () => void;
  onObserverError?: (error: unknown) => void;
} = {}) {
  const approvalPort: ApprovalPort = approvals ?? {
    approve: vi.fn(async (_job: ProposedJob, _reason) => approval ?? undefined),
  };
  const clock = new FakeClock(new Date(NOW));
  const service = new CronService({
    events,
    store,
    approvals: approvalPort,
    clock,
    sessionId: "session-1",
    idFactory,
    onChanged,
    onObserverError,
  });
  return { service, store, approvals: approvalPort, clock };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("CronService creation and validation", () => {
  it("delivers change notifications after the durable mutation barrier clears", async () => {
    let service!: CronService;
    let executionToken: string | undefined;
    const observerError = vi.fn();
    ({ service } = makeService({
      onChanged: () => {
        executionToken = service.beginExecution("deadbeef", false);
      },
      onObserverError: observerError,
    }));

    await service.create(validDraft());

    expect(executionToken).toEqual(expect.any(String));
    expect(observerError).not.toHaveBeenCalled();
    if (!executionToken) throw new Error("execution token was not created");
    service.endExecution(executionToken);
  });

  it("forwards automatic approval mode when creating a job", async () => {
    const approvals: ApprovalPort = {
      approve: vi.fn(async (_job, _reason, mode) =>
        mode === "automatic" ? APPROVAL : undefined,
      ),
    };
    const { service } = makeService({ approvals });

    await expect(
      service.create(validDraft(), { approvalMode: "automatic" }),
    ).resolves.toMatchObject({ approval: APPROVAL });
  });

  it("creates an approved job with normalized defaults after durable append", async () => {
    let appendedAtNotification = 0;
    const store = new MemoryStore();
    const { service, approvals } = makeService({
      store,
      onChanged: () => {
        appendedAtNotification = store.appended.length;
      },
    });

    const result = await service.create(
      validDraft({ name: "  Report  ", execution: undefined }),
    );

    expect(result).toMatchObject({
      id: "deadbeef",
      name: "Report",
      execution: { kind: "main" },
      overlap: "queue",
      skippedRuns: 0,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: "2026-07-21T12:00:00.000Z",
      approval: APPROVAL,
    });
    expect(approvals.approve).toHaveBeenCalledWith(
      expect.objectContaining({ id: "deadbeef", name: "Report" }),
      "create",
      "interactive",
    );
    expect(appendedAtNotification).toBe(1);
    expect(service.list()).toEqual([result]);
  });

  it("uses a generated default name", async () => {
    const { service } = makeService();
    await expect(
      service.create(validDraft({ name: undefined })),
    ).resolves.toMatchObject({ name: "job-deadbeef" });
  });

  it("cancels creation and preserves memory when approval or append fails", async () => {
    const declined = makeService({ approval: null });
    await expect(declined.service.create(validDraft())).rejects.toThrow(
      "Cron job creation cancelled",
    );
    expect(declined.service.list()).toEqual([]);

    const failed = makeService({ store: new MemoryStore([], "disk full") });
    await expect(failed.service.create(validDraft())).rejects.toThrow(
      "disk full",
    );
    expect(failed.service.list()).toEqual([]);
  });

  it("rejects malformed approval data before durable storage", async () => {
    const malformed = {
      approvedAt: NOW,
      fingerprint: "approved",
      unexpected: true,
    } as unknown as CronJob["approval"];
    const { service, store } = makeService({ approval: malformed });

    await expect(service.create(validDraft())).rejects.toThrow(
      "Malformed pi-cron event",
    );
    expect(store.appended).toEqual([]);
  });

  it.each([
    [
      "unknown schedule kind",
      validDraft({
        schedule: { kind: "unknown" } as unknown as JobDraft["schedule"],
      }),
      "Invalid cron schedule",
    ],
    [
      "non-positive interval",
      validDraft({
        schedule: { kind: "interval", intervalMs: 0, anchorAt: NOW },
      }),
      "interval",
    ],
    [
      "unsafe interval without opt-in",
      validDraft({
        schedule: { kind: "interval", intervalMs: 30_000, anchorAt: NOW },
        maxRuns: 2,
      }),
      "unsafeSeconds",
    ],
    [
      "unsafe interval without run cap",
      validDraft({
        schedule: { kind: "interval", intervalMs: 30_000, anchorAt: NOW },
        unsafeSeconds: true,
      }),
      "maxRuns",
    ],
    [
      "malformed cron",
      validDraft({
        schedule: { kind: "cron", expression: "bad cron", timezone: "UTC" },
      }),
      "cron expression",
    ],
    [
      "invalid timezone",
      validDraft({
        schedule: {
          kind: "cron",
          expression: "0 9 * * *",
          timezone: "Not/A_Zone",
        },
      }),
      "timezone",
    ],
    [
      "past one-shot",
      validDraft({
        schedule: { kind: "once", at: NOW, original: "now" },
      }),
      "future",
    ],
    [
      "past adaptive wake",
      validDraft({
        schedule: { kind: "adaptive", nextWakeAt: NOW, fallbackUsed: false },
      }),
      "future",
    ],
    ["malformed expiry", validDraft({ expiresAt: "not-a-date" }), "expiry"],
    ["past expiry", validDraft({ expiresAt: NOW }), "future"],
    ["zero maxRuns", validDraft({ maxRuns: 0 }), "maxRuns"],
    ["negative token budget", validDraft({ tokenBudget: -1 }), "tokenBudget"],
    [
      "zero timeout",
      validDraft({
        execution: {
          kind: "isolated",
          model: "model-a",
          effort: "low",
          tools: [],
          skills: [],
          extensions: [],
          notify: false,
          timeoutMs: 0,
        },
      }),
      "timeout",
    ],
  ])("rejects direct-service %s", async (_label, draft, message) => {
    const { service, approvals, store } = makeService();

    await expect(service.create(draft as JobDraft)).rejects.toThrow(
      message as string,
    );
    expect(approvals.approve).not.toHaveBeenCalled();
    expect(store.appended).toEqual([]);
  });

  it("revalidates time-sensitive safety after deferred approval", async () => {
    const gate = deferred<CronJob["approval"] | undefined>();
    const approve = vi.fn(() => gate.promise);
    const { service, store, clock } = makeService({ approvals: { approve } });
    const creating = service.create(
      validDraft({ expiresAt: "2026-07-14T12:00:01.000Z" }),
    );
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());

    clock.advanceBy(2_000);
    gate.resolve(APPROVAL);

    await expect(creating).rejects.toThrow("future");
    expect(store.appended).toEqual([]);
  });

  it("allows explicitly bounded unsafe-second creation", async () => {
    const { service } = makeService();
    await expect(
      service.create(
        validDraft({
          schedule: { kind: "interval", intervalMs: 30_000, anchorAt: NOW },
          unsafeSeconds: true,
          maxRuns: 2,
        }),
      ),
    ).resolves.toMatchObject({ maxRuns: 2 });
  });

  it("regenerates colliding IDs and fails after bounded collisions", async () => {
    const existing = storedJob();
    const ids = [existing.id.toUpperCase(), "unique02"];
    const regenerated = makeService({
      events: [created(existing)],
      idFactory: () => ids.shift() ?? "unused00",
    });
    await expect(
      regenerated.service.create(validDraft({ name: "Another" })),
    ).resolves.toMatchObject({ id: "unique02" });

    const idFactory = vi.fn(() => existing.id);
    const exhausted = makeService({
      events: [created(existing)],
      idFactory,
    });
    await expect(
      exhausted.service.create(validDraft({ name: "Another" })),
    ).rejects.toThrow("unique cron job ID");
    expect(idFactory).toHaveBeenCalledTimes(16);
  });
});

describe("CronService serialized definition mutations", () => {
  it("serializes deferred approvals so a duplicate cannot commit stale validation", async () => {
    const gate = deferred<CronJob["approval"] | undefined>();
    const approve = vi.fn(() => gate.promise);
    const ids = ["first001", "second02"];
    const { service } = makeService({
      approvals: { approve },
      idFactory: () => ids.shift() ?? "unused00",
    });

    const first = service.create(validDraft({ name: " Same " }));
    const second = service.create(validDraft({ name: "same" }));
    expect(() => service.beginExecution("first001", false)).toThrow(
      "mutation is pending",
    );
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));

    gate.resolve(APPROVAL);
    await expect(first).resolves.toMatchObject({ name: "Same" });
    await expect(second).rejects.toThrow("already exists");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(service.list()).toHaveLength(1);
  });

  it("replaces tighter edits without approval and increases with approval", async () => {
    const existing = storedJob({ maxRuns: 10 });
    const { service, approvals, store } = makeService({
      events: [created(existing)],
    });

    const tightened = await service.replace(existing.id, {
      name: "  Renamed  ",
      maxRuns: 5,
    });
    expect(tightened).toMatchObject({
      name: "Renamed",
      approval: existing.approval,
    });
    expect(approvals.approve).not.toHaveBeenCalled();

    const increased = await service.replace(existing.id, { maxRuns: 20 });
    expect(increased.approval).toEqual(APPROVAL);
    expect(approvals.approve).toHaveBeenCalledWith(
      expect.objectContaining({ maxRuns: 20 }),
      "privilege_increase",
      "interactive",
    );
    expect(store.appended.map((event) => event.type)).toEqual([
      "job_replaced",
      "job_replaced",
    ]);
  });

  it("forwards automatic approval mode for privilege-increasing replacements", async () => {
    const existing = storedJob({ maxRuns: 10 });
    const approvals: ApprovalPort = {
      approve: vi.fn(async (_job, _reason, mode) =>
        mode === "automatic" ? APPROVAL : undefined,
      ),
    };
    const { service } = makeService({
      events: [created(existing)],
      approvals,
    });

    await expect(
      service.replace(
        existing.id,
        { maxRuns: 20 },
        { approvalMode: "automatic" },
      ),
    ).resolves.toMatchObject({ maxRuns: 20, approval: APPROVAL });
  });

  it("requires unsafe authorization again when editing a sub-minute job", async () => {
    const existing = storedJob({
      schedule: { kind: "interval", intervalMs: 30_000, anchorAt: NOW },
      maxRuns: 2,
    });
    const { service } = makeService({ events: [created(existing)] });

    await expect(
      service.replace(existing.id, { name: "Renamed" }),
    ).rejects.toThrow("unsafeSeconds");
    await expect(
      service.replace(existing.id, { name: "Renamed", unsafeSeconds: true }),
    ).resolves.toMatchObject({ name: "Renamed" });
  });

  it("leaves definitions intact on cancellation and append failure", async () => {
    const existing = storedJob({ maxRuns: 10 });
    const cancelled = makeService({
      events: [created(existing)],
      approval: null,
    });
    await expect(
      cancelled.service.replace(existing.id, { maxRuns: 20 }),
    ).rejects.toThrow("replacement cancelled");
    expect(cancelled.service.get(existing.id)?.maxRuns).toBe(10);

    const store = new MemoryStore([], "disk full");
    const failed = makeService({ events: [created(existing)], store });
    await expect(failed.service.pause(existing.id, "pause")).rejects.toThrow(
      "disk full",
    );
    expect(failed.service.get(existing.id)?.state).toBe("active");
  });

  it("pauses, resumes, selects trimmed selectors, and deletes", async () => {
    const existing = storedJob();
    const { service, store } = makeService({ events: [created(existing)] });

    await expect(
      service.pause(" daily ", "operator request"),
    ).resolves.toMatchObject({
      state: "paused",
      pauseReason: "operator request",
    });
    await expect(service.resume(existing.id)).resolves.toMatchObject({
      state: "active",
    });
    await service.delete(" daily ");

    expect(service.list()).toEqual([]);
    expect(store.appended.map((event) => event.type)).toEqual([
      "job_replaced",
      "job_replaced",
      "job_deleted",
    ]);
  });
});

describe("CronService execution authorization", () => {
  it("returns an opaque token and protects active execution state from mutation", () => {
    const existing = storedJob();
    const { service } = makeService({ events: [created(existing)] });

    const token = service.beginExecution(existing.id, false);
    expect(typeof token).toBe("string");
    const snapshot = service.getActiveExecution();
    expect(snapshot).toMatchObject({
      token,
      jobId: existing.id,
      adaptive: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { token: string }).token = "tampered";
    }).toThrow();
    expect(service.getActiveExecution()?.token).toBe(token);

    expect(() => service.endExecution("wrong-token")).toThrow("does not match");
    expect(service.getActiveExecution()?.token).toBe(token);
    service.endExecution(token);
    expect(service.getActiveExecution()).toBeUndefined();
  });

  it("requires the active opaque token for adaptive decisions and binds its job", async () => {
    const existing = storedJob({
      schedule: {
        kind: "adaptive",
        nextWakeAt: "2026-07-14T13:00:00.000Z",
        fallbackUsed: false,
      },
    });
    const { service, store } = makeService({ events: [created(existing)] });
    const token = service.beginExecution(existing.id, true);

    await expect(
      service.setAdaptiveWakeup(
        "wrong-token",
        new Date("2026-07-14T14:00:00.000Z"),
        "later",
      ),
    ).rejects.toThrow("does not match");
    store.failure = "disk full";
    await expect(
      service.setAdaptiveWakeup(
        token,
        new Date("2026-07-14T14:00:00.000Z"),
        "later",
      ),
    ).rejects.toThrow("disk full");
    expect(service.getActiveExecution()).toMatchObject({ decisionMade: false });
    expect(service.get(existing.id)?.schedule).toEqual(existing.schedule);

    store.failure = undefined;
    await service.setAdaptiveWakeup(
      token,
      new Date("2026-07-14T14:00:00.000Z"),
      "later",
    );

    expect(service.getActiveExecution()).toMatchObject({ decisionMade: true });
    expect(service.get(existing.id)?.schedule).toMatchObject({
      kind: "adaptive",
      nextWakeAt: "2026-07-14T14:00:00.000Z",
    });
    expect(store.appended.at(-1)?.type).toBe("job_replaced");
  });

  it("stops only the adaptive job bound to the active token", async () => {
    const existing = storedJob({
      schedule: {
        kind: "adaptive",
        nextWakeAt: "2026-07-14T13:00:00.000Z",
        fallbackUsed: false,
      },
    });
    const { service } = makeService({ events: [created(existing)] });
    const token = service.beginExecution(existing.id, true);

    await service.stopAdaptive(token, "work complete");

    expect(service.getActiveExecution()).toMatchObject({ decisionMade: true });
    expect(service.get(existing.id)).toMatchObject({
      state: "paused",
      pauseReason: "work complete",
    });
  });
});

describe("CronService metrics and observers", () => {
  it("keeps legacy checkpoints mutable when skip metrics are absent", async () => {
    const existing = storedJob();
    const checkpoint: CronEvent = {
      version: 1,
      type: "metrics_checkpoint",
      at: NOW,
      jobs: [
        {
          id: existing.id,
          runCount: 1,
          attributedTokens: 10,
          consecutiveFailures: 0,
        },
      ],
    };
    const { service } = makeService({
      events: [created(existing), checkpoint],
    });

    await expect(service.pause(existing.id)).resolves.toMatchObject({
      state: "paused",
    });
  });

  it("rejects unknown outcomes without changing registry, dirtiness, or observers", async () => {
    const existing = storedJob();
    const changed = vi.fn();
    const { service } = makeService({
      events: [created(existing)],
      onChanged: changed,
    });
    const before = service.list();
    const malformed = {
      outcome: "unknown",
      tokens: 1,
    } as unknown as DispatchResult;

    await expect(
      service.recordRun(
        existing.id,
        malformed,
        new Date("2026-07-14T13:00:00.000Z"),
      ),
    ).rejects.toThrow("outcome");

    expect(service.list()).toEqual(before);
    expect(service.shouldFlushCheckpoint({ maxRuns: 0, maxAgeMs: 0 })).toBe(
      false,
    );
    expect(changed).not.toHaveBeenCalled();
  });

  it("rejects aggregate counter overflow before publishing metrics", async () => {
    const existing = storedJob({ attributedTokens: Number.MAX_VALUE });
    const changed = vi.fn();
    const { service } = makeService({
      events: [created(existing)],
      onChanged: changed,
    });
    const before = service.list();

    await expect(
      service.recordRun(
        existing.id,
        { outcome: "settled", tokens: Number.MAX_VALUE },
        new Date("2026-07-14T13:00:00.000Z"),
      ),
    ).rejects.toThrow("attributedTokens");

    expect(service.list()).toEqual(before);
    expect(service.shouldFlushCheckpoint({ maxRuns: 0, maxAgeMs: 0 })).toBe(
      false,
    );
    expect(changed).not.toHaveBeenCalled();
  });

  it("distinguishes interim dispatch from final settlement timestamps", async () => {
    const existing = storedJob();
    const { service, clock } = makeService({ events: [created(existing)] });
    const scheduledAt = new Date("2026-07-14T13:00:00.000Z");

    await service.recordRun(
      existing.id,
      { outcome: "dispatched", tokens: 0 },
      scheduledAt,
    );
    expect(service.get(existing.id)).toMatchObject({
      runCount: 0,
      lastOccurrenceAt: scheduledAt.toISOString(),
      lastDispatchAt: NOW,
      lastTechnicalOutcome: "dispatched",
    });

    clock.advanceBy(5_000);
    await service.recordRun(
      existing.id,
      { outcome: "settled", tokens: 40 },
      scheduledAt,
    );
    expect(service.get(existing.id)).toMatchObject({
      runCount: 1,
      attributedTokens: 40,
      consecutiveFailures: 0,
      lastDispatchAt: NOW,
      lastSettledAt: "2026-07-14T12:00:05.000Z",
      lastTechnicalOutcome: "settled",
    });
  });

  it.each([
    "failed",
    "timed_out",
    "aborted",
  ] as const)("records dispatch timing and failures for final %s outcomes", async (outcome) => {
    const existing = storedJob();
    const { service } = makeService({ events: [created(existing)] });

    await service.recordRun(
      existing.id,
      { outcome, tokens: 5 },
      new Date("2026-07-14T13:00:00.000Z"),
    );

    expect(service.get(existing.id)).toMatchObject({
      runCount: 1,
      attributedTokens: 5,
      consecutiveFailures: 1,
      lastDispatchAt: NOW,
      lastTechnicalOutcome: outcome,
    });
  });

  it("records both timestamps when settlement is the only final result", async () => {
    const existing = storedJob();
    const { service } = makeService({ events: [created(existing)] });

    await service.recordRun(
      existing.id,
      { outcome: "settled", tokens: 3 },
      new Date("2026-07-14T13:00:00.000Z"),
    );

    expect(service.get(existing.id)).toMatchObject({
      lastDispatchAt: NOW,
      lastSettledAt: NOW,
    });
  });

  it("marks metrics dirty before safely notifying observers", async () => {
    let service!: CronService;
    let dirtyAtNotification = false;
    const observerError = vi.fn();
    ({ service } = makeService({
      events: [created()],
      onChanged: () => {
        dirtyAtNotification = service.shouldFlushCheckpoint({
          maxRuns: 1,
          maxAgeMs: 999,
        });
        throw new Error("observer failed");
      },
      onObserverError: observerError,
    }));

    await expect(
      service.recordRun(
        "abcd1234",
        { outcome: "failed", tokens: 1 },
        new Date("2026-07-14T13:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
    expect(dirtyAtNotification).toBe(true);
    expect(observerError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("records skipped occurrences without counting them as runs or failures", async () => {
    const existing = storedJob();
    const store = new MemoryStore();
    const { service } = makeService({
      events: [created(existing)],
      store,
    });
    const skippedAt = new Date("2026-07-14T13:00:00.000Z");
    await expect(
      service.recordSkip(existing.id, skippedAt),
    ).resolves.toBeUndefined();
    expect(service.get(existing.id)).toMatchObject({
      runCount: 0,
      consecutiveFailures: 0,
      skippedRuns: 1,
      lastSkippedAt: skippedAt.toISOString(),
    });
    expect(
      service.shouldFlushCheckpoint({ maxRuns: 1, maxAgeMs: 60_000 }),
    ).toBe(true);

    await service.flushCheckpoint();
    expect(store.appended.at(-1)).toMatchObject({
      type: "metrics_checkpoint",
      jobs: [
        expect.objectContaining({
          id: existing.id,
          skippedRuns: 1,
          lastSkippedAt: skippedAt.toISOString(),
        }),
      ],
    });
    const replayed = makeService({
      events: [created(existing), ...store.appended],
    }).service;
    expect(replayed.get(existing.id)).toMatchObject({
      skippedRuns: 1,
      lastSkippedAt: skippedAt.toISOString(),
    });
  });

  it("flushes all dirty metrics and retains dirtiness after append failure", async () => {
    const existing = storedJob();
    const store = new MemoryStore();
    const { service, clock } = makeService({
      events: [created(existing)],
      store,
    });

    await service.recordRun(
      existing.id,
      { outcome: "failed", tokens: 25 },
      new Date("2026-07-14T13:00:00.000Z"),
    );
    expect(
      service.shouldFlushCheckpoint({ maxRuns: 2, maxAgeMs: 60_000 }),
    ).toBe(false);
    clock.advanceBy(60_000);
    expect(
      service.shouldFlushCheckpoint({ maxRuns: 2, maxAgeMs: 60_000 }),
    ).toBe(true);

    store.failure = "disk full";
    await expect(service.flushCheckpoint()).rejects.toThrow("disk full");
    expect(service.shouldFlushCheckpoint({ maxRuns: 1, maxAgeMs: 0 })).toBe(
      true,
    );
    store.failure = undefined;
    await service.flushCheckpoint();
    expect(store.appended.at(-1)).toMatchObject({
      type: "metrics_checkpoint",
      jobs: [expect.objectContaining({ id: existing.id, runCount: 1 })],
    });
    expect(service.shouldFlushCheckpoint({ maxRuns: 1, maxAgeMs: 0 })).toBe(
      false,
    );
  });

  it("keeps unflushed metrics when another definition is persisted", async () => {
    const existing = storedJob();
    const { service } = makeService({ events: [created(existing)] });
    await service.recordRun(
      existing.id,
      { outcome: "settled", tokens: 40 },
      new Date("2026-07-14T13:00:00.000Z"),
    );

    await service.create(validDraft({ name: "Another job" }));

    expect(service.get(existing.id)).toMatchObject({
      runCount: 1,
      attributedTokens: 40,
    });
  });

  it("resets failures on settlement and auto-pauses after three failures", async () => {
    const existing = storedJob();
    const { service } = makeService({ events: [created(existing)] });
    const scheduledAt = new Date("2026-07-14T13:00:00.000Z");

    await service.recordRun(
      existing.id,
      { outcome: "failed", tokens: 1 },
      scheduledAt,
    );
    await service.recordRun(
      existing.id,
      { outcome: "settled", tokens: 2 },
      scheduledAt,
    );
    expect(service.get(existing.id)?.consecutiveFailures).toBe(0);
    await service.recordRun(
      existing.id,
      { outcome: "timed_out", tokens: 0 },
      scheduledAt,
    );
    await service.recordRun(
      existing.id,
      { outcome: "aborted", tokens: 0 },
      scheduledAt,
    );
    await service.recordRun(
      existing.id,
      { outcome: "failed", tokens: 0 },
      scheduledAt,
    );

    expect(service.get(existing.id)).toMatchObject({
      state: "paused",
      consecutiveFailures: 3,
      runCount: 5,
    });
  });
});
