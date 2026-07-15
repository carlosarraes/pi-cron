import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CronEvent, CronJob } from "../src/domain/types.js";
import piCron from "../src/index.js";
import { CronRuntime } from "../src/runtime.js";
import { FakeClock } from "./helpers/fakes.js";

const NOW = "2026-07-15T10:00:00.000Z";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: "job-1",
    name: "Report",
    prompt: { kind: "text", text: "Run report" },
    schedule: { kind: "interval", intervalMs: 60_000, anchorAt: NOW },
    state: "active",
    execution: { kind: "main" },
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-07-22T10:00:00.000Z",
    runCount: 0,
    attributedTokens: 0,
    consecutiveFailures: 0,
    approval: { approvedAt: NOW, fingerprint: "ok" },
    originSessionId: "session-1",
    ...overrides,
  };
}

function event(current = job()): CronEvent {
  return { version: 1, type: "job_created", at: NOW, job: current };
}

function customEntry(data: CronEvent) {
  return {
    type: "custom",
    customType: "pi-cron/event",
    data,
  };
}

class FakeLease {
  acquired: string[] = [];
  heartbeats = 0;
  releases = 0;
  constructor(
    private readonly result:
      | { owned: true }
      | {
          owned: false;
          owner: {
            pid: number;
            processStartedAt: string;
            heartbeatAt: string;
            sessionId: string;
          };
        } = { owned: true },
  ) {}
  async acquire(sessionId: string) {
    this.acquired.push(sessionId);
    return this.result;
  }
  async heartbeat(): Promise<void> {
    this.heartbeats += 1;
  }
  async release(): Promise<void> {
    this.releases += 1;
  }
}

function setup(
  options: {
    entries?: unknown[];
    sessionId?: string;
    lease?: FakeLease;
    reason?: "startup" | "reload" | "new" | "resume" | "fork";
  } = {},
) {
  const entries = options.entries ?? [];
  const sessionId = options.sessionId ?? "session-1";
  const appended: Array<{ type: string; data: unknown }> = [];
  const sent: string[] = [];
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  const pi = {
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    sendUserMessage: (prompt: string) => sent.push(prompt),
    sendMessage: vi.fn(),
    getCommands: () => [],
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/project",
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => sessionId,
    },
    modelRegistry: { getAvailable: () => [] },
    model: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    ui: {
      setStatus: (_key: string, value: string | undefined) =>
        statuses.push(value),
      notify: (message: string) => notifications.push(message),
      confirm: vi.fn(async () => true),
    },
  } as unknown as ExtensionContext;
  const clock = new FakeClock(new Date(NOW));
  const lease = options.lease ?? new FakeLease();
  const intervals = new Map<number, () => void>();
  let nextInterval = 1;
  const runtime = new CronRuntime(pi, {
    clock,
    leaseFactory: () => lease,
    setInterval: (fn) => {
      const id = nextInterval++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (handle) => intervals.delete(handle as number),
  });
  return {
    runtime,
    ctx,
    pi,
    clock,
    lease,
    appended,
    sent,
    statuses,
    notifications,
    intervals,
    start: () => runtime.start(ctx, options.reason ?? "startup"),
  };
}

async function settleAsync(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("CronRuntime", () => {
  it("replays the active branch, acquires the lease, starts one scheduler timer, and sets footer", async () => {
    const configured = setup({ entries: [customEntry(event())] });
    await configured.start();

    expect(configured.runtime.requireService().list()).toHaveLength(1);
    expect(configured.lease.acquired).toEqual(["session-1"]);
    expect(configured.clock.pendingTimerCount()).toBe(1);
    expect(configured.intervals.size).toBe(1);
    expect(configured.statuses.at(-1)).toContain("cron 1");
  });

  it("enters read-only mode when another live process owns the lease", async () => {
    const lease = new FakeLease({
      owned: false,
      owner: {
        pid: 42,
        processStartedAt: NOW,
        heartbeatAt: NOW,
        sessionId: "session-1",
      },
    });
    const configured = setup({ entries: [customEntry(event())], lease });
    await configured.start();

    expect(configured.runtime.getScheduler()).toBeUndefined();
    expect(configured.clock.pendingTimerCount()).toBe(0);
    expect(configured.intervals.size).toBe(0);
    expect(configured.runtime.requireService().list()).toHaveLength(1);
    expect(() => configured.runtime.assertWritable()).toThrow("read-only");
    expect(configured.appended).toEqual([]);
  });

  it("classifies expired, exhausted, and missed one-shot jobs on resume", async () => {
    const entries = [
      customEntry(
        event(job({ id: "expired", name: "Expired", expiresAt: NOW })),
      ),
      customEntry(
        event(job({ id: "maxed", name: "Maxed", maxRuns: 1, runCount: 1 })),
      ),
      customEntry(
        event(
          job({
            id: "missed",
            name: "Missed",
            schedule: {
              kind: "once",
              at: "2026-07-15T09:00:00.000Z",
              original: "1h",
            },
          }),
        ),
      ),
    ];
    const configured = setup({ entries, reason: "resume" });
    await configured.start();
    const states = Object.fromEntries(
      configured.runtime
        .requireService()
        .list()
        .map((current) => [current.id, current.state]),
    );
    expect(states).toEqual({
      expired: "expired",
      maxed: "completed",
      missed: "missed",
    });
    expect(
      configured.appended.filter((entry) => entry.type === "pi-cron/event"),
    ).toHaveLength(3);
  });

  it("pauses inherited jobs in a fork", async () => {
    const configured = setup({
      entries: [customEntry(event())],
      sessionId: "fork-session",
      reason: "fork",
    });
    await configured.start();
    expect(configured.runtime.requireService().get("job-1")).toMatchObject({
      state: "paused",
      pauseReason: expect.stringContaining("fork"),
    });
  });

  it("starts a new empty session without inherited jobs", async () => {
    const configured = setup({
      entries: [],
      reason: "new",
      sessionId: "new-session",
    });
    await configured.start();
    expect(configured.runtime.requireService().list()).toEqual([]);
    expect(configured.clock.pendingTimerCount()).toBe(0);
  });

  it("bridges main dispatch through agent settlement and records the run", async () => {
    const configured = setup({ entries: [customEntry(event())] });
    await configured.start();
    const running = configured.runtime.getScheduler()?.runNow("job-1");
    await settleAsync();
    expect(configured.sent).toEqual(["Run report"]);

    await configured.runtime.onAgentSettled(configured.ctx);
    await running;

    expect(configured.runtime.requireService().get("job-1")?.runCount).toBe(1);
  });

  it("reload is idempotent and releases the previous runtime", async () => {
    const configured = setup({ entries: [customEntry(event())] });
    await configured.start();
    expect(configured.clock.pendingTimerCount()).toBe(1);
    await configured.runtime.start(configured.ctx, "reload");
    expect(configured.lease.releases).toBe(1);
    expect(configured.clock.pendingTimerCount()).toBe(1);
    expect(configured.intervals.size).toBe(1);
  });

  it("stop-all clears pending work but leaves scheduling restartable", async () => {
    const configured = setup({ entries: [customEntry(event())] });
    await configured.start();
    await configured.runtime.requireService().pause("job-1", "stop all");
    await configured.runtime.stopAll();
    expect(configured.clock.pendingTimerCount()).toBe(0);

    await configured.runtime.requireService().resume("job-1");
    expect(configured.clock.pendingTimerCount()).toBe(1);
  });

  it("shutdown clears scheduler, heartbeat, lease, and footer", async () => {
    const configured = setup({ entries: [customEntry(event())] });
    await configured.start();
    await configured.runtime.stop(configured.ctx);
    expect(configured.clock.pendingTimerCount()).toBe(0);
    expect(configured.intervals.size).toBe(0);
    expect(configured.lease.releases).toBe(1);
    expect(configured.statuses.at(-1)).toBeUndefined();
    expect(() => configured.runtime.requireService()).toThrow("not started");
  });

  it("heartbeats the lease and fails closed by stopping scheduling on loss", async () => {
    const configured = setup({ entries: [customEntry(event())] });
    await configured.start();
    const heartbeat = [...configured.intervals.values()][0];
    await heartbeat?.();
    await settleAsync();
    expect(configured.lease.heartbeats).toBe(1);
  });
});

describe("extension factory", () => {
  it("registers resources and lifecycle listeners without starting timers", () => {
    const handlers: string[] = [];
    const tools: string[] = [];
    const commands: string[] = [];
    const renderers: string[] = [];
    const pi = {
      on: (name: string) => handlers.push(name),
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
      registerEntryRenderer: (name: string) => renderers.push(name),
    } as unknown as ExtensionAPI;

    piCron(pi);

    expect(commands).toEqual(["cron"]);
    expect(tools).toEqual([
      "cron_create",
      "cron_list",
      "cron_update",
      "cron_delete",
      "cron_run",
      "cron_wakeup",
    ]);
    expect(renderers).toEqual(["pi-cron/run", "pi-cron/result"]);
    expect(handlers).toEqual([
      "session_start",
      "session_tree",
      "agent_settled",
      "session_shutdown",
    ]);
  });
});
