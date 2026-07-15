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

class MemoryStore implements EventStore {
  readonly appended: CronEvent[] = [];

  constructor(
    private readonly loaded: CronEvent[] = [],
    private readonly failure?: string,
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
    ...validDraft(),
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
  } as CronJob;
}

function created(job = storedJob()): CronEvent {
  return { version: 1, type: "job_created", at: NOW, job };
}

function makeService({
  events = [],
  store = new MemoryStore(),
  approval = { approvedAt: NOW, fingerprint: "approved-new" },
  onChanged,
}: {
  events?: CronEvent[];
  store?: MemoryStore;
  approval?: CronJob["approval"] | null;
  onChanged?: () => void;
} = {}) {
  const approvals: ApprovalPort = {
    approve: vi.fn(async (_job: ProposedJob, _reason) => approval ?? undefined),
  };
  const clock = new FakeClock(new Date(NOW));
  const service = new CronService({
    events,
    store,
    approvals,
    clock,
    sessionId: "session-1",
    idFactory: () => "deadbeef",
    onChanged,
  });
  return { service, store, approvals, clock };
}

describe("CronService creation", () => {
  it("creates an approved job with defaults and appends before publishing it", async () => {
    const changed = vi.fn();
    const { service, store, approvals } = makeService({ onChanged: changed });

    const result = await service.create(
      validDraft({ name: undefined, execution: undefined }),
    );

    expect(result).toMatchObject({
      id: "deadbeef",
      name: "job-deadbeef",
      execution: { kind: "main" },
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: "2026-07-21T12:00:00.000Z",
      approval: { fingerprint: "approved-new" },
    });
    expect(approvals.approve).toHaveBeenCalledWith(
      expect.objectContaining({ id: "deadbeef" }),
      "create",
    );
    expect(store.appended).toHaveLength(1);
    expect(service.list()).toEqual([result]);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("cancels creation when approval is declined", async () => {
    const { service, store } = makeService({ approval: null });

    await expect(service.create(validDraft())).rejects.toThrow(
      "Cron job creation cancelled",
    );
    expect(store.appended).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  it("rejects malformed approval data before it reaches durable storage", async () => {
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

  it("rejects recursive creation during any active scheduled execution", async () => {
    const existing = storedJob();
    const { service } = makeService({ events: [created(existing)] });
    service.beginExecution(existing.id, false);

    await expect(
      service.create(validDraft({ name: "nested" })),
    ).rejects.toThrow("Scheduled runs cannot create cron jobs");
  });

  it("does not mutate memory when durable append fails", async () => {
    const store = new MemoryStore([], "disk full");
    const { service } = makeService({ store });

    await expect(service.create(validDraft())).rejects.toThrow("disk full");
    expect(service.list()).toEqual([]);
  });
});

describe("CronService definition mutations", () => {
  it("replaces tighter edits without approval and privilege increases with approval", async () => {
    const existing = storedJob({ maxRuns: 10 });
    const { service, approvals, store } = makeService({
      events: [created(existing)],
    });

    const tightened = await service.replace(existing.id, {
      name: "Renamed",
      maxRuns: 5,
    });
    expect(tightened.approval).toEqual(existing.approval);
    expect(approvals.approve).not.toHaveBeenCalled();

    const increased = await service.replace(existing.id, { maxRuns: 20 });
    expect(increased.approval.fingerprint).toBe("approved-new");
    expect(approvals.approve).toHaveBeenCalledWith(
      expect.objectContaining({ maxRuns: 20 }),
      "privilege_increase",
    );
    expect(store.appended.map((event) => event.type)).toEqual([
      "job_replaced",
      "job_replaced",
    ]);
  });

  it("leaves the prior definition intact when replacement approval is cancelled", async () => {
    const existing = storedJob({ maxRuns: 10 });
    const { service, store } = makeService({
      events: [created(existing)],
      approval: null,
    });

    await expect(service.replace(existing.id, { maxRuns: 20 })).rejects.toThrow(
      "Cron job replacement cancelled",
    );
    expect(service.get(existing.id)?.maxRuns).toBe(10);
    expect(store.appended).toEqual([]);
  });

  it("pauses, resumes, selects, and deletes through append-first events", async () => {
    const existing = storedJob();
    const { service, store } = makeService({ events: [created(existing)] });

    expect(service.get(existing.id)?.id).toBe(existing.id);
    const paused = service.pause("daily", "operator request");
    expect(paused).toMatchObject({
      state: "paused",
      pauseReason: "operator request",
    });
    const resumed = service.resume(existing.id);
    expect(resumed.state).toBe("active");
    service.delete("daily");

    expect(service.list()).toEqual([]);
    expect(store.appended.map((event) => event.type)).toEqual([
      "job_replaced",
      "job_replaced",
      "job_deleted",
    ]);
  });
});

describe("CronService execution and checkpoints", () => {
  it("records metrics, failure streaks, and flush thresholds", () => {
    const existing = storedJob();
    const { service, store, clock } = makeService({
      events: [created(existing)],
    });
    const failure: DispatchResult = { outcome: "failed", tokens: 25 };

    service.recordRun(
      existing.id,
      failure,
      new Date("2026-07-14T13:00:00.000Z"),
    );
    expect(service.get(existing.id)).toMatchObject({
      runCount: 1,
      attributedTokens: 25,
      consecutiveFailures: 1,
      lastOccurrenceAt: "2026-07-14T13:00:00.000Z",
      lastTechnicalOutcome: "failed",
    });
    expect(
      service.shouldFlushCheckpoint({ maxRuns: 2, maxAgeMs: 60_000 }),
    ).toBe(false);

    clock.advanceBy(60_000);
    expect(
      service.shouldFlushCheckpoint({ maxRuns: 2, maxAgeMs: 60_000 }),
    ).toBe(true);
    service.flushCheckpoint();
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]).toMatchObject({
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
    service.recordRun(
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

  it("resets failures on settlement and auto-pauses after three failures", () => {
    const existing = storedJob();
    const { service } = makeService({ events: [created(existing)] });
    const scheduledAt = new Date("2026-07-14T13:00:00.000Z");

    service.recordRun(
      existing.id,
      { outcome: "failed", tokens: 1 },
      scheduledAt,
    );
    service.recordRun(
      existing.id,
      { outcome: "settled", tokens: 2 },
      scheduledAt,
    );
    expect(service.get(existing.id)?.consecutiveFailures).toBe(0);
    service.recordRun(
      existing.id,
      { outcome: "timed_out", tokens: 0 },
      scheduledAt,
    );
    service.recordRun(
      existing.id,
      { outcome: "aborted", tokens: 0 },
      scheduledAt,
    );
    service.recordRun(
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

  it("owns one execution token and immediately persists adaptive decisions", () => {
    const existing = storedJob({
      schedule: { kind: "adaptive", nextWakeAt: NOW, fallbackUsed: false },
    });
    const { service, store } = makeService({ events: [created(existing)] });

    const execution = service.beginExecution(existing.id, true);
    expect(service.getActiveExecution()).toEqual(execution);
    expect(() => service.beginExecution(existing.id, true)).toThrow(
      "execution is already active",
    );

    service.setAdaptiveWakeup(
      existing.id,
      new Date("2026-07-14T14:00:00.000Z"),
      "continue later",
    );
    expect(execution.decisionMade).toBe(true);
    expect(service.get(existing.id)?.schedule).toEqual({
      kind: "adaptive",
      nextWakeAt: "2026-07-14T14:00:00.000Z",
      fallbackUsed: false,
    });
    expect(store.appended.at(-1)?.type).toBe("job_replaced");

    service.endExecution(execution.token);
    expect(service.getActiveExecution()).toBeUndefined();
  });

  it("stops an adaptive job with a persisted pause reason", () => {
    const existing = storedJob({
      schedule: { kind: "adaptive", nextWakeAt: NOW, fallbackUsed: false },
    });
    const { service } = makeService({ events: [created(existing)] });
    const execution = service.beginExecution(existing.id, true);

    service.stopAdaptive(existing.id, "work complete");

    expect(execution.decisionMade).toBe(true);
    expect(service.get(existing.id)).toMatchObject({
      state: "paused",
      pauseReason: "work complete",
    });
  });
});
