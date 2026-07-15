import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  DefaultResourceLoader,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../src/domain/types.js";
import {
  buildResourceLoader,
  IsolatedExecutor,
  type IsolatedSession,
  resolveModel,
} from "../../src/execution/isolated-executor.js";

const NOW = "2026-07-15T10:00:00.000Z";

function model(
  provider: string,
  id: string,
  name = id,
  reasoning = true,
): Model<Api> {
  return { provider, id, name, reasoning } as Model<Api>;
}

function isolatedJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: "job-1",
    name: "Isolated report",
    prompt: { kind: "text", text: "Report" },
    schedule: { kind: "interval", intervalMs: 60_000, anchorAt: NOW },
    state: "active",
    execution: {
      kind: "isolated",
      model: "openai/model-a",
      effort: "medium",
      tools: ["read"],
      skills: [],
      extensions: [],
      notify: false,
      timeoutMs: 60_000,
    },
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

function registry(models: Model<Api>[]) {
  return { getAvailable: () => models } as Pick<ModelRegistry, "getAvailable">;
}

class FakeService {
  active:
    | { token: string; jobId: string; adaptive: boolean; decisionMade: boolean }
    | undefined;
  wakeups: unknown[] = [];
  stops: string[] = [];

  beginExecution(jobId: string, adaptive: boolean): string {
    this.active = { token: "token", jobId, adaptive, decisionMade: false };
    return "token";
  }
  getActiveExecution() {
    return this.active;
  }
  endExecution(token: string): void {
    if (token !== this.active?.token) throw new Error("wrong token");
    this.active = undefined;
  }
  async setAdaptiveWakeup(
    token: string,
    at: Date,
    reason: string,
  ): Promise<void> {
    if (token !== this.active?.token) throw new Error("wrong token");
    this.active.decisionMade = true;
    this.wakeups.push({ at, reason });
  }
  async stopAdaptive(token: string, reason: string): Promise<void> {
    if (token !== this.active?.token) throw new Error("wrong token");
    this.active.decisionMade = true;
    this.stops.push(reason);
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function assistant(text: string, tokens: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { totalTokens: tokens },
  };
}

function harness(options: {
  currentJob?: CronJob;
  session?: Partial<IsolatedSession>;
  models?: Model<Api>[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}) {
  const service = new FakeService();
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const captured: Record<string, unknown>[] = [];
  const fakeLoader = {
    reload: vi.fn(async () => undefined),
  } as unknown as DefaultResourceLoader;
  const session: IsolatedSession = {
    messages: [assistant("done", 12), assistant("more", 8)],
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    bindExtensions: vi.fn(async () => undefined),
    ...options.session,
  };
  const executor = new IsolatedExecutor({
    cwd: "/project",
    agentDir: "/agent",
    modelRegistry: registry(options.models ?? [model("openai", "model-a")]),
    pi: {
      appendEntry: (type, data) => entries.push({ type, data }),
      sendMessage: (message, sendOptions) =>
        messages.push({ message, options: sendOptions }),
    },
    service,
    resolver: { resolve: async () => "resolved prompt" },
    now: () => new Date(NOW),
    resourceLoaderFactory: () => fakeLoader,
    createSession: async (createOptions) => {
      captured.push(createOptions);
      return { session };
    },
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  });
  return { executor, service, entries, messages, captured, session };
}

async function settleAsync(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("resolveModel", () => {
  const models = [
    model("openai", "gpt-5", "GPT Five"),
    model("anthropic", "sonnet", "Claude Sonnet"),
  ];

  it("resolves exact provider/id, id, name, and unique fuzzy matches", () => {
    const source = registry(models);
    expect(resolveModel(source, "openai/gpt-5").id).toBe("gpt-5");
    expect(resolveModel(source, "SONNET").provider).toBe("anthropic");
    expect(resolveModel(source, "GPT Five").id).toBe("gpt-5");
    expect(resolveModel(source, "claude").id).toBe("sonnet");
  });

  it("fails unavailable and ambiguous model requests", () => {
    expect(() => resolveModel(registry(models), "missing")).toThrow(
      "unavailable",
    );
    expect(() =>
      resolveModel(
        registry([model("a", "shared"), model("b", "shared")]),
        "shared",
      ),
    ).toThrow("Ambiguous");
  });
});

describe("buildResourceLoader", () => {
  it("disables defaults and filters extensions and skills to approvals", () => {
    let captured: Record<string, unknown> | undefined;
    buildResourceLoader(
      {
        cwd: "/project",
        agentDir: "/agent",
        approved: { extensions: ["safe-ext"], skills: ["audit"] },
      },
      (options) => {
        captured = options as unknown as Record<string, unknown>;
        return {} as DefaultResourceLoader;
      },
    );
    expect(captured).toMatchObject({ noPromptTemplates: true, noThemes: true });
    const extensionOverride = captured?.extensionsOverride as (base: {
      extensions: Array<{ path: string }>;
      errors: unknown[];
      runtime: object;
    }) => { extensions: Array<{ path: string }> };
    expect(
      extensionOverride({
        extensions: [{ path: "/x/safe-ext.ts" }, { path: "/x/no.ts" }],
        errors: [],
        runtime: {},
      }).extensions,
    ).toEqual([{ path: "/x/safe-ext.ts" }]);
    const skillsOverride = captured?.skillsOverride as (base: {
      skills: Array<{ name: string }>;
      diagnostics: unknown[];
    }) => { skills: Array<{ name: string }> };
    expect(
      skillsOverride({
        skills: [{ name: "audit" }, { name: "other" }],
        diagnostics: [],
      }).skills,
    ).toEqual([{ name: "audit" }]);
  });
});

describe("IsolatedExecutor", () => {
  it("creates a fresh restricted session and aggregates assistant usage", async () => {
    const { executor, captured, session, entries, messages } = harness({});
    const result = await executor.execute(isolatedJob(), new Date(NOW));

    expect(result).toEqual({ outcome: "settled", tokens: 20 });
    expect(captured[0]).toMatchObject({
      thinkingLevel: "medium",
      tools: ["read"],
      sessionManager: expect.anything(),
      customTools: [],
    });
    expect(session.prompt).toHaveBeenCalledWith("resolved prompt");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(entries[0]).toMatchObject({ type: "pi-cron/result" });
    expect(messages).toEqual([]);
  });

  it("rejects effort unsupported by the selected model", async () => {
    const noReasoning = isolatedJob({
      execution: {
        kind: "isolated",
        model: "openai/plain",
        effort: "medium",
        tools: [],
        skills: [],
        extensions: [],
        notify: false,
        timeoutMs: 60_000,
      },
    });
    const { executor } = harness({
      models: [model("openai", "plain", "Plain", false)],
    });
    await expect(
      executor.execute(noReasoning, new Date(NOW)),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("unavailable"),
    });
  });

  it("binds approved extensions and wakes the parent only when notify is true", async () => {
    const notifying = isolatedJob({
      execution: {
        kind: "isolated",
        model: "openai/model-a",
        effort: "medium",
        tools: [],
        skills: [],
        extensions: ["safe-ext"],
        notify: true,
        timeoutMs: 60_000,
      },
    });
    const { executor, session, messages } = harness({});
    await executor.execute(notifying, new Date(NOW));
    expect(session.bindExtensions).toHaveBeenCalledOnce();
    expect(messages[0]?.options).toEqual({
      deliverAs: "followUp",
      triggerTurn: true,
    });
  });

  it("truncates displayed output and errors to 500 Unicode characters", async () => {
    const long = "🙂".repeat(600);
    const { executor, entries } = harness({
      session: { messages: [assistant(long, 1)] },
    });
    await executor.execute(isolatedJob(), new Date(NOW));
    const data = entries[0]?.data as { summary: string };
    expect([...data.summary]).toHaveLength(500);
    expect(data.summary.endsWith("…")).toBe(true);

    const failed = harness({
      session: {
        prompt: vi.fn(async () => {
          throw new Error(long);
        }),
      },
    });
    const result = await failed.executor.execute(isolatedJob(), new Date(NOW));
    expect([...(result.error ?? "")]).toHaveLength(500);
  });

  it("times out, aborts, disposes, and reports timed_out", async () => {
    const gate = deferred();
    let timerCallback: (() => void) | undefined;
    const base = harness({
      session: {
        prompt: vi.fn(() => gate.promise),
        abort: vi.fn(async () => gate.resolve()),
      },
      setTimer: (callback) => {
        timerCallback = callback;
        return 1;
      },
      clearTimer: vi.fn(),
    });
    const result = base.executor.execute(isolatedJob(), new Date(NOW));
    await settleAsync();
    timerCallback?.();
    await expect(result).resolves.toMatchObject({ outcome: "timed_out" });
    expect(base.session.abort).toHaveBeenCalledOnce();
  });

  it("aborts all active sessions on shutdown", async () => {
    const gate = deferred();
    const { executor, session } = harness({
      session: {
        prompt: vi.fn(() => gate.promise),
        abort: vi.fn(async () => gate.resolve()),
      },
    });
    const result = executor.execute(isolatedJob(), new Date(NOW));
    await settleAsync();
    await executor.abortAll();
    await expect(result).resolves.toMatchObject({ outcome: "aborted" });
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it("applies the adaptive omission fallback before ending execution", async () => {
    const adaptive = isolatedJob({
      schedule: {
        kind: "adaptive",
        nextWakeAt: "2026-07-15T10:01:00.000Z",
        fallbackUsed: false,
      },
    });
    const { executor, service } = harness({});

    await executor.execute(adaptive, new Date(NOW));

    expect(service.wakeups).toHaveLength(1);
    expect((service.wakeups[0] as { at: Date }).at.toISOString()).toBe(
      "2026-07-15T10:20:00.000Z",
    );
  });

  it("offers cron_wakeup only to adaptive isolated runs", async () => {
    const adaptive = isolatedJob({
      schedule: {
        kind: "adaptive",
        nextWakeAt: "2026-07-15T10:01:00.000Z",
        fallbackUsed: false,
      },
    });
    const gate = deferred();
    const { executor, captured, service } = harness({
      session: { prompt: vi.fn(() => gate.promise) },
    });
    const result = executor.execute(adaptive, new Date(NOW));
    await settleAsync();
    const tools = captured[0]?.customTools as Array<{
      execute: (
        id: string,
        input: { delay: string; reason: string },
      ) => Promise<unknown>;
    }>;
    expect(tools).toHaveLength(1);
    await tools[0]?.execute("call", { delay: "5m", reason: "later" });
    expect(service.wakeups).toHaveLength(1);
    gate.resolve();
    await result;

    const normal = harness({});
    await normal.executor.execute(isolatedJob(), new Date(NOW));
    expect(normal.captured[0]?.customTools).toEqual([]);
  });
});
