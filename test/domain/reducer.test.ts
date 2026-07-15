import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiEventStore } from "../../src/core/event-store.js";
import { reduceEvents } from "../../src/domain/reducer.js";
import type { CronEvent, CronJob } from "../../src/domain/types.js";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: "job-1",
    name: "first",
    prompt: { kind: "text", text: "Do the work" },
    schedule: {
      kind: "interval",
      intervalMs: 60_000,
      anchorAt: "2026-07-14T12:00:00.000Z",
    },
    state: "active",
    execution: { kind: "main" },
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
    expiresAt: "2026-07-21T12:00:00.000Z",
    runCount: 0,
    attributedTokens: 0,
    consecutiveFailures: 0,
    approval: {
      approvedAt: "2026-07-14T12:00:00.000Z",
      fingerprint: "approved",
    },
    originSessionId: "session-1",
    ...overrides,
  };
}

function created(value: CronJob): CronEvent {
  return {
    version: 1,
    type: "job_created",
    at: "2026-07-14T12:00:00.000Z",
    job: value,
  };
}

function customEntry(customType: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    id: crypto.randomUUID(),
    parentId: null,
    timestamp: "2026-07-14T12:00:00.000Z",
    customType,
    data,
  };
}

describe("reduceEvents", () => {
  it("replays job creation without retaining the event payload reference", () => {
    const original = job();

    const jobs = reduceEvents([created(original)]);
    original.name = "mutated later";

    expect(jobs.get(original.id)?.name).toBe("first");
  });

  it("replaces an existing job", () => {
    const replacement = job({
      name: "replacement",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });

    const jobs = reduceEvents([
      created(job()),
      {
        version: 1,
        type: "job_replaced",
        at: "2026-07-15T00:00:00.000Z",
        job: replacement,
      },
    ]);

    expect(jobs.get(replacement.id)?.name).toBe("replacement");
  });

  it("applies a deletion tombstone", () => {
    const original = job();

    const jobs = reduceEvents([
      created(original),
      {
        version: 1,
        type: "job_deleted",
        at: "2026-07-15T00:00:00.000Z",
        jobId: original.id,
      },
    ]);

    expect(jobs.has(original.id)).toBe(false);
  });

  it("merges metrics checkpoints into jobs that still exist", () => {
    const original = job();

    const jobs = reduceEvents([
      created(original),
      {
        version: 1,
        type: "metrics_checkpoint",
        at: "2026-07-15T00:00:00.000Z",
        jobs: [
          {
            id: original.id,
            runCount: 2,
            attributedTokens: 350,
            consecutiveFailures: 1,
            lastOccurrenceAt: "2026-07-15T00:00:00.000Z",
            lastTechnicalOutcome: "failed",
          },
          {
            id: "deleted-job",
            runCount: 1,
            attributedTokens: 10,
            consecutiveFailures: 0,
          },
        ],
      },
    ]);

    expect(jobs.get(original.id)).toMatchObject({
      name: "first",
      runCount: 2,
      attributedTokens: 350,
      consecutiveFailures: 1,
      lastTechnicalOutcome: "failed",
    });
    expect(jobs.has("deleted-job")).toBe(false);
  });

  it("fails on unsupported event versions", () => {
    const unsupported = {
      ...created(job()),
      version: 2,
    } as unknown as CronEvent;

    expect(() => reduceEvents([unsupported])).toThrow(
      "Unsupported pi-cron event version: 2",
    );
  });

  it.each([
    { version: 1, type: "job_created", at: "2026-07-14T12:00:00.000Z" },
    { version: 1, type: "unknown", at: "2026-07-14T12:00:00.000Z" },
  ])("fails safely on malformed event %#", (malformed) => {
    expect(() => reduceEvents([malformed as CronEvent])).toThrow(
      "Malformed pi-cron event",
    );
  });

  it("rejects a created event with an incomplete job", () => {
    const incomplete = {
      version: 1,
      type: "job_created",
      at: "2026-07-14T12:00:00.000Z",
      job: { version: 1, id: "incomplete" },
    } as unknown as CronEvent;

    expect(() => reduceEvents([incomplete])).toThrow("Malformed pi-cron event");
  });

  it("rejects a checkpoint with an invalid optional metric field", () => {
    const invalidCheckpoint = {
      version: 1,
      type: "metrics_checkpoint",
      at: "2026-07-15T00:00:00.000Z",
      jobs: [
        {
          id: "job-1",
          runCount: 1,
          attributedTokens: 10,
          consecutiveFailures: 0,
          lastDispatchAt: 42,
        },
      ],
    } as unknown as CronEvent;

    expect(() => reduceEvents([created(job()), invalidCheckpoint])).toThrow(
      "Malformed pi-cron event",
    );
  });

  it("rejects a checkpoint containing a job configuration key", () => {
    const invalidCheckpoint = {
      version: 1,
      type: "metrics_checkpoint",
      at: "2026-07-15T00:00:00.000Z",
      jobs: [
        {
          id: "job-1",
          runCount: 1,
          attributedTokens: 10,
          consecutiveFailures: 0,
          name: "unauthorized replacement",
        },
      ],
    } as unknown as CronEvent;

    expect(() => reduceEvents([created(job()), invalidCheckpoint])).toThrow(
      "Malformed pi-cron event",
    );
  });
});

describe("PiEventStore", () => {
  it("replays only pi-cron custom entries on the active branch", () => {
    const activeJob = job();
    const getBranch = vi.fn(() => [
      customEntry("other-extension", { value: 1 }),
      customEntry("pi-cron/event", created(activeJob)),
      customEntry("pi-cron/event", {
        version: 1,
        type: "job_deleted",
        at: "2026-07-15T00:00:00.000Z",
        jobId: activeJob.id,
      }),
    ]);
    const appendEntry = vi.fn();
    const store = new PiEventStore(
      { appendEntry } as Pick<ExtensionAPI, "appendEntry">,
      { getBranch } as Pick<ExtensionContext["sessionManager"], "getBranch">,
    );

    expect(reduceEvents(store.load()).size).toBe(0);
    expect(getBranch).toHaveBeenCalledOnce();
  });

  it("does not replay events from a divergent branch", () => {
    const activeJob = job({ id: "active" });
    const divergentJob = job({ id: "divergent" });
    const getBranch = vi.fn(() => [
      customEntry("pi-cron/event", created(activeJob)),
    ]);
    const getEntries = vi.fn(() => [
      customEntry("pi-cron/event", created(activeJob)),
      customEntry("pi-cron/event", created(divergentJob)),
    ]);
    const store = new PiEventStore(
      { appendEntry: vi.fn() } as Pick<ExtensionAPI, "appendEntry">,
      { getBranch, getEntries } as unknown as Pick<
        ExtensionContext["sessionManager"],
        "getBranch"
      >,
    );

    expect([...reduceEvents(store.load()).keys()]).toEqual(["active"]);
    expect(getEntries).not.toHaveBeenCalled();
  });

  it("appends events under the pi-cron custom type", () => {
    const appendEntry = vi.fn();
    const event = created(job());
    const store = new PiEventStore(
      { appendEntry } as Pick<ExtensionAPI, "appendEntry">,
      { getBranch: () => [] } as Pick<
        ExtensionContext["sessionManager"],
        "getBranch"
      >,
    );

    store.append(event);

    expect(appendEntry).toHaveBeenCalledWith("pi-cron/event", event);
  });
});
