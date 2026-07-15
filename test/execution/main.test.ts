import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveExecution } from "../../src/core/service.js";
import type { CronJob } from "../../src/domain/types.js";
import { MainExecutor } from "../../src/execution/main-executor.js";
import {
  BUILTIN_MAINTENANCE_PROMPT,
  PromptResolver,
} from "../../src/execution/prompt-resolver.js";
import { FakeClock } from "../helpers/fakes.js";

const NOW = "2026-07-15T10:00:00.000Z";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-cron-main-"));
  tempDirs.push(path);
  return path;
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: "job-1",
    name: "Job one",
    prompt: { kind: "text", text: "Do the thing" },
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
    originSessionId: "session",
    ...overrides,
  };
}

function sourceInfo(path: string) {
  return {
    path,
    source: "local",
    scope: "user" as const,
    origin: "top-level" as const,
  };
}

class FakeExecutionService {
  readonly jobs = new Map<string, CronJob>();
  active:
    | { token: string; jobId: string; adaptive: boolean; decisionMade: boolean }
    | undefined;
  ended: string[] = [];
  wakeups: Array<{ at: Date; reason: string; fallbackUsed: boolean }> = [];
  stops: string[] = [];

  constructor(initial: CronJob) {
    this.jobs.set(initial.id, structuredClone(initial));
  }

  get(id: string): CronJob | undefined {
    const value = this.jobs.get(id);
    return value ? structuredClone(value) : undefined;
  }

  beginExecution(jobId: string, adaptive: boolean): string {
    this.active = {
      token: "execution-token",
      jobId,
      adaptive,
      decisionMade: false,
    };
    return this.active.token;
  }

  getActiveExecution(): ActiveExecution | undefined {
    return this.active ? Object.freeze({ ...this.active }) : undefined;
  }

  endExecution(token: string): void {
    if (token !== this.active?.token) throw new Error("wrong token");
    this.ended.push(token);
    this.active = undefined;
  }

  async setAdaptiveWakeup(
    token: string,
    at: Date,
    reason: string,
    fallbackUsed = false,
  ): Promise<void> {
    if (token !== this.active?.token) throw new Error("wrong token");
    this.active.decisionMade = true;
    this.wakeups.push({ at, reason, fallbackUsed });
    const current = this.jobs.get(this.active.jobId);
    if (current) {
      this.jobs.set(current.id, {
        ...current,
        schedule: {
          kind: "adaptive",
          nextWakeAt: at.toISOString(),
          fallbackUsed,
        },
      });
    }
  }

  async stopAdaptive(token: string, reason: string): Promise<void> {
    if (token !== this.active?.token) throw new Error("wrong token");
    this.active.decisionMade = true;
    this.stops.push(reason);
  }
}

async function settleAsync(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function mainHarness(current = job()) {
  const service = new FakeExecutionService(current);
  const entries: Array<{ type: string; data: unknown }> = [];
  const sent: Array<{ prompt: string; options: unknown }> = [];
  let usage = 100;
  const pi = {
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    sendUserMessage(prompt: string, options?: unknown) {
      sent.push({ prompt, options });
    },
  };
  const clock = new FakeClock(new Date(NOW));
  const executor = new MainExecutor({
    pi,
    service,
    resolver: {
      resolve: async (value: CronJob) =>
        value.prompt.kind === "text" ? value.prompt.text : "resolved",
    },
    clock,
    readUsage: () => usage,
  });
  return {
    executor,
    service,
    entries,
    sent,
    clock,
    setUsage(value: number) {
      usage = value;
    },
    pi,
  };
}

describe("PromptResolver", () => {
  it("returns plain text prompts unchanged", async () => {
    const root = await tempDir();
    const resolver = new PromptResolver({
      pi: { getCommands: () => [] },
      cwd: root,
      agentDir: root,
      isProjectTrusted: () => true,
    });
    await expect(resolver.resolve(job())).resolves.toBe("Do the thing");
  });

  it("uses trusted project maintenance, then global, then built-in", async () => {
    const root = await tempDir();
    const agentDir = join(root, "agent");
    await mkdir(join(root, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(root, ".pi", "cron.md"), "project maintenance");
    await writeFile(join(agentDir, "cron.md"), "global maintenance");
    const maintenance = job({ prompt: { kind: "maintenance" } });
    const trusted = new PromptResolver({
      pi: { getCommands: () => [] },
      cwd: root,
      agentDir,
      isProjectTrusted: () => true,
    });
    const untrusted = new PromptResolver({
      pi: { getCommands: () => [] },
      cwd: root,
      agentDir,
      isProjectTrusted: () => false,
    });

    await expect(trusted.resolve(maintenance)).resolves.toBe(
      "project maintenance",
    );
    await expect(untrusted.resolve(maintenance)).resolves.toBe(
      "global maintenance",
    );
    await rm(join(agentDir, "cron.md"));
    await expect(untrusted.resolve(maintenance)).resolves.toBe(
      BUILTIN_MAINTENANCE_PROMPT,
    );
  });

  it("expands prompt-template arguments after stripping frontmatter", async () => {
    const root = await tempDir();
    const template = join(root, "review.md");
    await writeFile(
      template,
      `---
description: Review
---
$1|$@|$ARGUMENTS|\${2:-fallback}|\${@:2}|\${@:2:1}`,
    );
    const resolver = new PromptResolver({
      pi: {
        getCommands: () => [
          {
            name: "review",
            source: "prompt",
            sourceInfo: sourceInfo(template),
          },
        ],
      },
      cwd: root,
      agentDir: root,
      isProjectTrusted: () => true,
    });
    const scheduled = job({
      prompt: {
        kind: "command",
        name: "review",
        args: "one 'two words'",
        source: "prompt",
      },
    });

    await expect(resolver.resolve(scheduled)).resolves.toBe(
      "one|one two words|one two words|two words|two words|two words",
    );
  });

  it("resolves only the currently loaded command with matching provenance", async () => {
    const root = await tempDir();
    const resolver = new PromptResolver({
      pi: {
        getCommands: () => [
          { name: "audit", source: "skill", sourceInfo: sourceInfo(root) },
        ],
      },
      cwd: root,
      agentDir: root,
      isProjectTrusted: () => true,
    });
    await expect(
      resolver.resolve(
        job({
          prompt: {
            kind: "command",
            name: "audit",
            args: "--quick",
            source: "skill",
          },
        }),
      ),
    ).resolves.toContain("loaded skill 'audit'");
    await expect(
      resolver.resolve(
        job({
          prompt: {
            kind: "command",
            name: "audit",
            args: "",
            source: "prompt",
          },
        }),
      ),
    ).rejects.toThrow("unavailable");
  });

  it("rejects maintenance and template files over 25,000 bytes", async () => {
    const root = await tempDir();
    await writeFile(join(root, "cron.md"), "x".repeat(25_001));
    const resolver = new PromptResolver({
      pi: { getCommands: () => [] },
      cwd: root,
      agentDir: root,
      isProjectTrusted: () => false,
    });
    await expect(
      resolver.resolve(job({ prompt: { kind: "maintenance" } })),
    ).rejects.toThrow("25000");
  });
});

describe("MainExecutor", () => {
  it("sends exactly one resolved prompt and settles with attributed tokens", async () => {
    const harness = mainHarness();
    const result = harness.executor.execute(job(), new Date(NOW));
    await settleAsync();

    expect(harness.sent).toEqual([
      { prompt: "Do the thing", options: { deliverAs: "followUp" } },
    ]);
    expect(harness.entries[0]).toMatchObject({ type: "pi-cron/run" });
    harness.setUsage(145);
    await harness.executor.settle();

    await expect(result).resolves.toEqual({ outcome: "settled", tokens: 45 });
    expect(harness.entries.map((entry) => entry.type)).toEqual([
      "pi-cron/run",
      "pi-cron/result",
    ]);
    expect(harness.service.ended).toEqual(["execution-token"]);
  });

  it("does not inject transcript marker content into the model prompt", async () => {
    const harness = mainHarness(
      job({ prompt: { kind: "text", text: "ONLY THIS" } }),
    );
    const result = harness.executor.execute(
      job({ prompt: { kind: "text", text: "ONLY THIS" } }),
      new Date(NOW),
    );
    await settleAsync();
    expect(harness.sent[0]?.prompt).toBe("ONLY THIS");
    expect(harness.sent[0]?.prompt).not.toContain("pi-cron/run");
    harness.executor.abortPending();
    await result;
  });

  it("turns synchronous delivery failures into failed results", async () => {
    const harness = mainHarness();
    harness.pi.sendUserMessage = () => {
      throw new Error("delivery broke");
    };
    await expect(
      harness.executor.execute(job(), new Date(NOW)),
    ).resolves.toEqual({
      outcome: "failed",
      tokens: 0,
      error: "delivery broke",
    });
    expect(harness.executor.isIdle()).toBe(true);
  });

  it("applies bounded adaptive delay and self-stop decisions", async () => {
    const adaptive = job({
      schedule: {
        kind: "adaptive",
        nextWakeAt: "2026-07-15T10:01:00.000Z",
        fallbackUsed: false,
      },
    });
    const harness = mainHarness(adaptive);
    const first = harness.executor.execute(adaptive, new Date(NOW));
    await settleAsync();
    await harness.executor.applyWakeup({ delay: "5m", reason: "check later" });
    expect(harness.service.wakeups[0]).toMatchObject({
      reason: "check later",
      fallbackUsed: false,
    });
    expect(harness.service.wakeups[0]?.at.toISOString()).toBe(
      "2026-07-15T10:05:00.000Z",
    );
    await harness.executor.settle();
    await first;

    const secondHarness = mainHarness(adaptive);
    const second = secondHarness.executor.execute(adaptive, new Date(NOW));
    await settleAsync();
    await secondHarness.executor.applyWakeup({ stop: true, reason: "done" });
    expect(secondHarness.service.stops).toEqual(["done"]);
    await secondHarness.executor.settle();
    await second;
  });

  it("rejects wakeup outside adaptive execution and invalid bounds", async () => {
    const harness = mainHarness();
    await expect(
      harness.executor.applyWakeup({ delay: "5m", reason: "later" }),
    ).rejects.toThrow("only available");
    const adaptive = job({
      schedule: {
        kind: "adaptive",
        nextWakeAt: "2026-07-15T10:01:00.000Z",
        fallbackUsed: false,
      },
    });
    const active = mainHarness(adaptive);
    const result = active.executor.execute(adaptive, new Date(NOW));
    await settleAsync();
    await expect(
      active.executor.applyWakeup({ delay: "30s", reason: "too fast" }),
    ).rejects.toThrow("between 1m and 1h");
    await expect(
      active.executor.applyWakeup({ delay: "2h", reason: "too slow" }),
    ).rejects.toThrow("between 1m and 1h");
    active.executor.abortPending();
    await result;
  });

  it("uses one 20-minute fallback, then pauses on a second omission", async () => {
    const firstJob = job({
      schedule: {
        kind: "adaptive",
        nextWakeAt: "2026-07-15T10:01:00.000Z",
        fallbackUsed: false,
      },
    });
    const first = mainHarness(firstJob);
    const firstResult = first.executor.execute(firstJob, new Date(NOW));
    await settleAsync();
    await first.executor.settle();
    await firstResult;
    expect(first.service.wakeups[0]?.at.toISOString()).toBe(
      "2026-07-15T10:20:00.000Z",
    );
    expect(first.service.wakeups[0]?.fallbackUsed).toBe(true);

    const secondJob = job({
      schedule: {
        kind: "adaptive",
        nextWakeAt: "2026-07-15T10:20:00.000Z",
        fallbackUsed: true,
      },
    });
    const second = mainHarness(secondJob);
    const secondResult = second.executor.execute(secondJob, new Date(NOW));
    await settleAsync();
    await second.executor.settle();
    await secondResult;
    expect(second.service.stops[0]).toContain("two adaptive runs");
  });

  it("aborts a pending bridge and clamps negative usage after compaction", async () => {
    const harness = mainHarness();
    const result = harness.executor.execute(job(), new Date(NOW));
    await settleAsync();
    harness.setUsage(10);
    harness.executor.abortPending("shutdown");
    await expect(result).resolves.toEqual({
      outcome: "aborted",
      tokens: 0,
      error: "shutdown",
    });
    expect(harness.executor.isIdle()).toBe(true);
  });

  it("rejects a second main execution while one is pending", async () => {
    const harness = mainHarness();
    const first = harness.executor.execute(job(), new Date(NOW));
    await expect(
      harness.executor.execute(job({ id: "job-2" }), new Date(NOW)),
    ).rejects.toThrow("already active");
    await settleAsync();
    harness.executor.abortPending();
    await first;
  });
});
