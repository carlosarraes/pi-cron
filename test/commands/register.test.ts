import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type CronRuntimeRef,
  registerCronCommand,
} from "../../src/commands/register.js";
import type { SavedCronService } from "../../src/core/saved-service.js";
import type { CronService, JobDraft } from "../../src/core/service.js";
import type { SavedCronDefinition } from "../../src/domain/saved.js";
import type { CronJob } from "../../src/domain/types.js";

const NOW = "2026-07-15T10:00:00.000Z";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: "job-1",
    name: "Report",
    prompt: { kind: "text", text: "Report" },
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

function savedDefinition(
  overrides: Partial<SavedCronDefinition> = {},
): SavedCronDefinition {
  return {
    version: 1,
    id: "save-001",
    name: "Saved report",
    prompt: { kind: "text", text: "TOP SECRET saved prompt" },
    schedule: { kind: "interval", intervalMs: 300_000 },
    execution: { kind: "main" },
    overlap: "queue",
    unsafeSeconds: false,
    expiresAfterMs: 604_800_000,
    createdAt: NOW,
    updatedAt: NOW,
    approval: { approvedAt: NOW, fingerprint: "saved-ok" },
    ...overrides,
  };
}

function setup(
  wizardResult?: JobDraft,
  savedOverrides: Partial<SavedCronDefinition> = {},
) {
  const current = job();
  const saved = savedDefinition(savedOverrides);
  const service = {
    list: vi.fn(() => [current]),
    get: vi.fn((id: string) => (id === current.id ? current : undefined)),
    create: vi.fn(async () => current),
    replace: vi.fn(async () => current),
    pause: vi.fn(async () => ({ ...current, state: "paused" as const })),
    resume: vi.fn(async () => current),
    delete: vi.fn(async () => undefined),
  } as unknown as CronService;
  const savedService = {
    list: vi.fn(async () => [saved]),
    select: vi.fn(async () => saved),
    create: vi.fn(async () => saved),
    copy: vi.fn(async () => saved),
    replace: vi.fn(async () => saved),
    delete: vi.fn(async () => undefined),
  } as unknown as SavedCronService;
  const manager = vi.fn(async () => undefined);
  const wizard = vi.fn(async () => wizardResult);
  const runNow = vi.fn(async () => undefined);
  const stopAll = vi.fn(async () => undefined);
  const assertSavedMutationAllowed = vi.fn();
  const startSaved = vi.fn(async () => current);
  const runtime: CronRuntimeRef = {
    requireService: () => service,
    requireSavedService: () => savedService,
    assertSavedMutationAllowed,
    startSaved,
    getScheduler: () => ({
      runNow,
      getRuntimeStatus: () => ({ state: "idle" }),
    }),
    getMainExecutor: () => undefined,
    runManager: manager,
    runWizard: wizard,
    stopAll,
  };
  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  const pi = {
    registerCommand: (
      _name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      handler = options.handler;
    },
    getCommands: () => [],
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  registerCronCommand(pi, runtime);
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    model: { provider: "openai", id: "model-a" },
    ui: {
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionCommandContext;
  return {
    run: (args: string) => (handler as NonNullable<typeof handler>)(args, ctx),
    service,
    savedService,
    saved,
    assertSavedMutationAllowed,
    startSaved,
    manager,
    wizard,
    runNow,
    stopAll,
    notifications,
  };
}

describe("registerCronCommand", () => {
  it("routes bare /cron to the manager", async () => {
    const { run, manager } = setup();
    await run("");
    expect(manager).toHaveBeenCalledOnce();
  });

  it("routes /cron add to the wizard and creates only on submission", async () => {
    const draft: JobDraft = {
      prompt: { kind: "text", text: "guided" },
      schedule: { kind: "interval", intervalMs: 60_000, anchorAt: NOW },
    };
    const { run, wizard, service } = setup(draft);
    await run("add");
    expect(wizard).toHaveBeenCalledOnce();
    expect(service.create).toHaveBeenCalledWith(draft);

    const cancelled = setup(undefined);
    await cancelled.run("add");
    expect(cancelled.service.create).not.toHaveBeenCalled();
  });

  it("creates strict and shorthand jobs through the shared service", async () => {
    const { run, service } = setup();
    await run('add --every 5m --prompt "check CI" --overlap skip --main');
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: { kind: "text", text: "check CI" },
        schedule: expect.objectContaining({
          kind: "interval",
          intervalMs: 300_000,
        }),
        execution: { kind: "main" },
        overlap: "skip",
      }),
    );

    await run("2h preserve\nmultiline prompt");
    expect(service.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: { kind: "text", text: "preserve\nmultiline prompt" },
      }),
    );
  });

  it("stores loaded skill references and rejects extension commands", async () => {
    let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const service = setup().service;
    const pi = {
      registerCommand: (
        _name: string,
        options: { handler: typeof handler },
      ) => {
        handler = options.handler;
      },
      getCommands: () => [
        { name: "review", source: "skill", sourceInfo: { path: "/skill" } },
        { name: "unsafe", source: "extension", sourceInfo: { path: "/ext" } },
      ],
      getThinkingLevel: () => "medium",
    } as unknown as ExtensionAPI;
    const runtime = {
      ...setup(),
      requireService: () => service,
      getScheduler: () => undefined,
      getMainExecutor: () => undefined,
      runManager: vi.fn(),
      runWizard: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as CronRuntimeRef;
    registerCronCommand(pi, runtime);
    const ctx = {
      model: undefined,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionCommandContext;

    await handler("5m /review 123", ctx);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: {
          kind: "command",
          name: "review",
          args: "123",
          source: "skill",
        },
      }),
    );
    await expect(handler("5m /unsafe", ctx)).rejects.toThrow("skill or prompt");
  });

  it("prints list/show text and dispatches management actions", async () => {
    const configured = setup();
    await configured.run("list");
    expect(configured.notifications.at(-1)).toContain("job-1");
    await configured.run("show job-1");
    expect(configured.notifications.at(-1)).toContain("State: active");
    await configured.run("pause job-1");
    await configured.run("resume job-1");
    await configured.run("run job-1");
    await configured.run("delete job-1");
    expect(configured.service.pause).toHaveBeenCalled();
    expect(configured.service.resume).toHaveBeenCalled();
    expect(configured.runNow).toHaveBeenCalledWith("job-1");
    expect(configured.service.delete).toHaveBeenCalledWith("job-1");
  });

  it("creates, copies, lists, shows, edits, deletes, and starts saved definitions", async () => {
    const configured = setup(undefined, {
      execution: {
        kind: "isolated",
        model: "openai/model-a",
        effort: "medium",
        tools: ["read"],
        skills: ["review"],
        extensions: ["github"],
        notify: false,
        timeoutMs: 60_000,
      },
    });

    await configured.run(
      'save add --every 1h --prompt "saved work" --name reusable',
    );
    expect(configured.assertSavedMutationAllowed).toHaveBeenCalledTimes(1);
    expect(configured.savedService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "reusable",
        prompt: { kind: "text", text: "saved work" },
        schedule: { kind: "interval", intervalMs: 3_600_000 },
      }),
    );

    await configured.run("save Report --name copied-report");
    expect(configured.savedService.copy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1" }),
      "copied-report",
    );

    await configured.run("saved");
    expect(configured.notifications.at(-1)).toContain("stopped");
    expect(configured.notifications.at(-1)).not.toContain("TOP SECRET");

    await configured.run("saved show save-001");
    expect(configured.savedService.select).toHaveBeenCalledWith("save-001");
    expect(configured.notifications.at(-1)).toContain(
      "TOP SECRET saved prompt",
    );

    await configured.run("saved edit save-001 --isolated --effort high");
    expect(configured.savedService.replace).toHaveBeenCalledWith(
      "save-001",
      expect.objectContaining({
        execution: expect.objectContaining({
          kind: "isolated",
          effort: "high",
          tools: ["read"],
          skills: ["review"],
          extensions: ["github"],
        }),
      }),
    );

    await configured.run("saved delete save-001");
    expect(configured.savedService.delete).toHaveBeenCalledWith("save-001");
    expect(configured.assertSavedMutationAllowed).toHaveBeenCalledTimes(4);

    await configured.run("start save-001");
    expect(configured.startSaved).toHaveBeenCalledWith(
      "save-001",
      "interactive",
    );
    expect(configured.notifications.at(-1)).toBe(
      "Started Report (job-1) in this session",
    );
  });

  it("rejects saved mutations and activation during a scheduled run", async () => {
    for (const command of [
      'save add --every 1h --prompt "saved work"',
      "save Report",
      "saved edit save-001 --overlap skip",
      "saved delete save-001",
    ]) {
      const configured = setup();
      configured.assertSavedMutationAllowed.mockImplementation(() => {
        throw new Error("Scheduled runs cannot mutate saved cron definitions");
      });

      await expect(configured.run(command)).rejects.toThrow(
        "Scheduled runs cannot mutate saved cron definitions",
      );
      expect(configured.savedService.create).not.toHaveBeenCalled();
      expect(configured.savedService.copy).not.toHaveBeenCalled();
      expect(configured.savedService.replace).not.toHaveBeenCalled();
      expect(configured.savedService.delete).not.toHaveBeenCalled();
    }

    const activation = setup();
    activation.startSaved.mockRejectedValue(
      new Error("Scheduled runs cannot mutate saved cron definitions"),
    );
    await expect(activation.run("start save-001")).rejects.toThrow(
      "Scheduled runs cannot mutate saved cron definitions",
    );
  });

  it("stops runtime activity and pauses every active job", async () => {
    const configured = setup();
    await configured.run("stop --all");
    expect(configured.stopAll).toHaveBeenCalledOnce();
    expect(configured.service.pause).toHaveBeenCalledWith(
      "job-1",
      "Stopped by /cron stop --all",
    );
  });

  it("propagates parser and mutation errors", async () => {
    const configured = setup();
    await expect(configured.run("add --every 5m")).rejects.toThrow(
      "requires --prompt",
    );
    configured.service.pause = vi.fn(async () => {
      throw new Error("append failed");
    });
    await expect(configured.run("pause job-1")).rejects.toThrow(
      "append failed",
    );
  });
});
