import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { CronRuntimeRef } from "../../src/commands/register.js";
import type { SavedCronService } from "../../src/core/saved-service.js";
import type { CronService } from "../../src/core/service.js";
import type { SavedCronDefinition } from "../../src/domain/saved.js";
import type { CronJob } from "../../src/domain/types.js";
import { registerCronTools } from "../../src/tools/register.js";
import {
  CronCreateParams,
  CronDeleteParams,
  CronListParams,
  CronRunParams,
  CronSavedCopyParams,
  CronSavedCreateParams,
  CronSavedDeleteParams,
  CronSavedListParams,
  CronSavedStartParams,
  CronSavedUpdateParams,
  CronUpdateParams,
  CronWakeupParams,
} from "../../src/tools/schemas.js";

const NOW = "2026-07-15T10:00:00.000Z";

function fakeTheme(): Theme {
  return {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  } as unknown as Theme;
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface RenderedComponent {
  render(width: number): string[];
}

interface CapturedTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute(
    id: string,
    input: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: ExtensionContext,
  ): Promise<ToolResult>;
  renderCall?(
    args: Record<string, unknown>,
    theme: Theme,
    context: { expanded: boolean },
  ): RenderedComponent;
  renderResult?(
    result: ToolResult,
    options: { expanded: boolean },
    theme: Theme,
  ): RenderedComponent;
}

function job(): CronJob {
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
  };
}

function savedDefinition(
  overrides: Partial<SavedCronDefinition> = {},
): SavedCronDefinition {
  return {
    version: 1,
    id: "save1234",
    name: "Saved report",
    prompt: { kind: "text", text: "Saved secret" },
    schedule: { kind: "interval", intervalMs: 300_000 },
    execution: { kind: "main" },
    overlap: "queue",
    unsafeSeconds: false,
    expiresAfterMs: 7 * 24 * 60 * 60_000,
    createdAt: NOW,
    updatedAt: NOW,
    approval: { approvedAt: NOW, fingerprint: "saved-ok" },
    ...overrides,
  };
}

function setup(
  overrides: Partial<CronService> = {},
  savedOverrides: Partial<SavedCronService> = {},
) {
  const current = job();
  const saved = savedDefinition();
  const service = {
    list: vi.fn(() => [current]),
    get: vi.fn((id: string) => (id === current.id ? current : undefined)),
    create: vi.fn(async () => current),
    replace: vi.fn(async () => current),
    pause: vi.fn(async () => ({ ...current, state: "paused" as const })),
    resume: vi.fn(async () => current),
    delete: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as CronService;
  const savedService = {
    list: vi.fn(async () => [saved]),
    select: vi.fn(async () => saved),
    create: vi.fn(async () => saved),
    copy: vi.fn(async () => saved),
    replace: vi.fn(async () => saved),
    delete: vi.fn(async () => undefined),
    ...savedOverrides,
  } as unknown as SavedCronService;
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (tool: unknown) => {
      const captured = tool as CapturedTool;
      tools.set(captured.name, captured);
    },
    getCommands: () => [],
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const applyWakeup = vi.fn(async () => undefined);
  const runNow = vi.fn(async () => undefined);
  const assertSavedMutationAllowed = vi.fn();
  const startSaved = vi.fn(async () => ({
    ...current,
    savedDefinitionId: saved.id,
  }));
  const runtime: CronRuntimeRef = {
    requireService: () => service,
    requireSavedService: () => savedService,
    assertSavedMutationAllowed,
    startSaved,
    getScheduler: () => ({
      runNow,
      getRuntimeStatus: () => ({ state: "idle" }),
    }),
    getMainExecutor: () => ({ applyWakeup }),
    runManager: vi.fn(async () => undefined),
    runWizard: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
  };
  registerCronTools(pi, runtime);
  const ctx = {
    model: { provider: "openai", id: "model-a" },
  } as ExtensionContext;
  return {
    tools,
    service,
    savedService,
    assertSavedMutationAllowed,
    startSaved,
    applyWakeup,
    runNow,
    ctx,
  };
}

async function execute(
  tool: CapturedTool | undefined,
  input: unknown,
  ctx: ExtensionContext,
): Promise<ToolResult> {
  if (!tool) throw new Error("tool not registered");
  return tool.execute("call", input, undefined, undefined, ctx);
}

describe("cron tool schemas", () => {
  it("defines all twelve strict schemas", () => {
    expect(Value.Check(CronCreateParams, { prompt: "x", every: "5m" })).toBe(
      true,
    );
    expect(Value.Check(CronListParams, {})).toBe(true);
    expect(
      Value.Check(CronUpdateParams, { selector: "job", state: "paused" }),
    ).toBe(true);
    expect(Value.Check(CronDeleteParams, { selector: "job" })).toBe(true);
    expect(Value.Check(CronRunParams, { selector: "job" })).toBe(true);
    expect(
      Value.Check(CronWakeupParams, { delay: "5m", reason: "later" }),
    ).toBe(true);
    expect(
      Value.Check(CronCreateParams, { prompt: "x", every: "5m", extra: true }),
    ).toBe(false);
    expect(
      Value.Check(CronCreateParams, {
        prompt: "x",
        every: "5m",
        overlap: "skip",
      }),
    ).toBe(true);
    expect(
      Value.Check(CronCreateParams, {
        prompt: "x",
        every: "5m",
        overlap: "later",
      }),
    ).toBe(false);
    expect(Value.Check(CronWakeupParams, { delay: "5m" })).toBe(false);

    expect(
      Value.Check(CronSavedCreateParams, { prompt: "x", every: "5m" }),
    ).toBe(true);
    expect(
      Value.Check(CronSavedCopyParams, {
        selector: "job",
        name: "template",
      }),
    ).toBe(true);
    expect(Value.Check(CronSavedListParams, {})).toBe(true);
    expect(
      Value.Check(CronSavedUpdateParams, {
        selector: "template",
        overlap: "skip",
      }),
    ).toBe(true);
    expect(Value.Check(CronSavedDeleteParams, { selector: "template" })).toBe(
      true,
    );
    expect(Value.Check(CronSavedStartParams, { selector: "template" })).toBe(
      true,
    );
    expect(
      Value.Check(CronSavedUpdateParams, {
        selector: "template",
        state: "paused",
      }),
    ).toBe(false);
    expect(
      Value.Check(CronSavedCreateParams, {
        prompt: "x",
        every: "5m",
        extra: true,
      }),
    ).toBe(false);
    expect(Value.Check(CronSavedCopyParams, {})).toBe(false);
    expect(Value.Check(CronSavedUpdateParams, {})).toBe(false);
    expect(Value.Check(CronSavedDeleteParams, {})).toBe(false);
    expect(Value.Check(CronSavedStartParams, {})).toBe(false);
    expect(
      Value.Check(CronSavedUpdateParams, {
        selector: "template",
        overlap: "later",
      }),
    ).toBe(false);
    expect(
      Value.Check(CronSavedCopyParams, {
        selector: "job",
        name: "x".repeat(101),
      }),
    ).toBe(false);
  });
});

describe("registerCronTools", () => {
  it("registers the complete compact tool surface", () => {
    const { tools } = setup();
    expect([...tools.keys()]).toEqual([
      "cron_create",
      "cron_list",
      "cron_update",
      "cron_delete",
      "cron_run",
      "cron_wakeup",
      "cron_saved_create",
      "cron_saved_copy",
      "cron_saved_list",
      "cron_saved_update",
      "cron_saved_delete",
      "cron_saved_start",
    ]);
    for (const tool of tools.values()) {
      expect(tool.promptSnippet).toBeTruthy();
      expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
    }
    expect(tools.get("cron_create")?.promptGuidelines?.join(" ")).toContain(
      "Prefer main mode",
    );
    expect(tools.get("cron_create")?.promptGuidelines?.join(" ")).toContain(
      "skills do not grant tools",
    );
  });

  it("lists run history needed to confirm whether a job triggered", async () => {
    const current = job();
    current.runCount = 4;
    current.skippedRuns = 2;
    current.lastSkippedAt = NOW;
    current.lastTechnicalOutcome = "settled";
    current.lastSettledAt = NOW;
    current.execution = {
      kind: "isolated",
      model: "openai/model-a",
      effort: "medium",
      tools: [],
      skills: ["pr-sweep"],
      extensions: [],
      notify: false,
      timeoutMs: 30 * 60_000,
    };
    const { tools, ctx } = setup({
      list: vi.fn(() => [current]),
    });

    const result = await execute(tools.get("cron_list"), {}, ctx);

    expect(result.content[0].text).toContain("job-1");
    expect(result.content[0].text).toContain("runs=4");
    expect(result.content[0].text).toContain("overlap=queue");
    expect(result.content[0].text).toContain("skipped=2");
    expect(result.content[0].text).toContain(`lastSkipped=${NOW}`);
    expect(result.content[0].text).toContain("last=settled");
    expect(result.content[0].text).toContain(`settled=${NOW}`);
    expect(result.content[0].text).toContain("exec=isolated");
    expect(result.content[0].text).toContain("tools=none");
    expect(result.content[0].text).toContain("notify=off");
    expect(result.content[0].text).toContain("model=openai/model-a");
    expect(result.content[0].text).toContain("effort=medium");
    expect(result.content[0].text).toContain("skills=pr-sweep");
    expect(result.content[0].text).toContain("extensions=none");
    expect(result.content[0].text).toContain("timeout=1800000ms");
  });

  it("lists never for jobs that have not settled", async () => {
    const { tools, ctx } = setup();

    const result = await execute(tools.get("cron_list"), {}, ctx);

    expect(result.content[0].text).toContain("last=never");
    expect(result.content[0].text).toContain("settled=never");
  });

  it("requests automatic approval when creating from the LLM tool", async () => {
    const { tools, service, ctx } = setup();

    await execute(
      tools.get("cron_create"),
      { prompt: "check", every: "5m", overlap: "skip" },
      ctx,
    );

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ overlap: "skip" }),
      { approvalMode: "automatic" },
    );
  });

  it("rejects the tool-less isolated configuration from the failed Mac job", async () => {
    const { tools, service, ctx } = setup();

    await expect(
      execute(
        tools.get("cron_create"),
        {
          name: "pr-sweep",
          prompt: "run the sweep",
          every: "10m",
          mode: "isolated",
          timeout: "30m",
          skills: ["pr-sweep"],
          notify: false,
        },
        ctx,
      ),
    ).rejects.toThrow("require explicit tools");
    expect(service.create).not.toHaveBeenCalled();
  });

  it("allows explicit empty tools for an isolated text-only job", async () => {
    const { tools, service, ctx } = setup();

    await execute(
      tools.get("cron_create"),
      {
        prompt: "write a greeting without using tools",
        every: "10m",
        mode: "isolated",
        tools: [],
      },
      ctx,
    );

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({ kind: "isolated", tools: [] }),
      }),
      { approvalMode: "automatic" },
    );
  });

  it("rejects converting a main job to isolated without explicit tools", async () => {
    const { tools, service, ctx } = setup();

    await expect(
      execute(
        tools.get("cron_update"),
        {
          selector: "job-1",
          mode: "isolated",
          skills: ["pr-sweep"],
        },
        ctx,
      ),
    ).rejects.toThrow("require explicit tools");
    expect(service.replace).not.toHaveBeenCalled();
  });

  it("retains tools when updating an existing isolated job", async () => {
    const isolated = job();
    isolated.execution = {
      kind: "isolated",
      model: "openai/model-a",
      effort: "medium",
      tools: ["read", "bash"],
      skills: ["pr-sweep"],
      extensions: [],
      notify: false,
      timeoutMs: 30 * 60_000,
    };
    const { tools, service, ctx } = setup({
      list: vi.fn(() => [isolated]),
      get: vi.fn(() => isolated),
    });

    await execute(
      tools.get("cron_update"),
      { selector: "job-1", notify: true, overlap: "skip" },
      ctx,
    );

    expect(service.replace).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        execution: expect.objectContaining({
          kind: "isolated",
          tools: ["read", "bash"],
          notify: true,
        }),
        overlap: "skip",
      }),
      { approvalMode: "automatic" },
    );
  });

  it("shows create configuration while keeping the prompt collapsed", async () => {
    const isolated = job();
    isolated.overlap = "skip";
    isolated.skippedRuns = 1;
    isolated.lastSkippedAt = NOW;
    isolated.execution = {
      kind: "isolated",
      model: "openai/model-a",
      effort: "medium",
      tools: ["read", "bash"],
      skills: ["pr-sweep"],
      extensions: [],
      notify: false,
      timeoutMs: 30 * 60_000,
    };
    const { tools, ctx } = setup({
      create: vi.fn(async () => isolated),
    });
    const tool = tools.get("cron_create");
    if (!tool?.renderCall || !tool.renderResult) {
      throw new Error("cron_create renderers were not registered");
    }
    const args = {
      prompt: "check the build",
      every: "5m",
      overlap: "skip" as const,
      mode: "isolated",
      tools: ["read", "bash"],
      notify: false,
    };
    const theme = fakeTheme();
    const collapsedCall = tool
      .renderCall(args, theme, { expanded: false })
      .render(1_000)
      .join("\n")
      .trimEnd();
    const expandedCall = tool
      .renderCall(args, theme, { expanded: true })
      .render(1_000)
      .join("\n")
      .trimEnd();
    const result = await execute(tool, args, ctx);
    const collapsedResult = tool
      .renderResult(result, { expanded: false }, theme)
      .render(1_000)
      .join("\n")
      .trimEnd();
    const expandedResult = tool
      .renderResult(result, { expanded: true }, theme)
      .render(1_000)
      .join("\n")
      .trimEnd();

    expect(collapsedCall).toBe(
      "cron_create · every 5m · overlap skip · isolated · tools read,bash · notify off",
    );
    expect(collapsedCall).not.toContain("check the build");
    expect(expandedCall).toContain('"prompt": "check the build"');
    expect(collapsedResult).toBe(
      "Created Report (job-1) · every 1m · overlap skip · isolated · tools read,bash · notify off",
    );
    expect(expandedResult).toContain("Schedule: every 1m");
    expect(expandedResult).toContain(`Last skipped: ${NOW}`);
  });

  it("shows inherited main-session resources without exposing the prompt", async () => {
    const { tools, ctx } = setup();
    const tool = tools.get("cron_create");
    if (!tool?.renderCall || !tool.renderResult) {
      throw new Error("cron_create renderers were not registered");
    }
    const args = { prompt: "check the build", every: "5m" };
    const theme = fakeTheme();
    const collapsedCall = tool
      .renderCall(args, theme, { expanded: false })
      .render(1_000)
      .join("\n")
      .trimEnd();
    const result = await execute(tool, args, ctx);
    const collapsedResult = tool
      .renderResult(result, { expanded: false }, theme)
      .render(1_000)
      .join("\n")
      .trimEnd();

    expect(collapsedCall).toBe(
      "cron_create · every 5m · overlap queue · main · tools inherited · notify n/a",
    );
    expect(collapsedCall).not.toContain("check the build");
    expect(collapsedResult).toBe(
      "Created Report (job-1) · every 1m · overlap queue · main · tools inherited · notify n/a",
    );
  });

  it("shows unchanged execution fields on schedule-only updates", async () => {
    const { tools } = setup();
    const tool = tools.get("cron_update");
    if (!tool?.renderCall) {
      throw new Error("cron_update renderer was not registered");
    }

    const collapsedCall = tool
      .renderCall({ selector: "job-1", every: "2h" }, fakeTheme(), {
        expanded: false,
      })
      .render(1_000)
      .join("\n")
      .trimEnd();

    expect(collapsedCall).toBe(
      "cron_update job-1 · every 2h · overlap unchanged · mode unchanged · tools unchanged · notify unchanged",
    );
  });

  it("shows update configuration while keeping the prompt collapsed", async () => {
    const { tools, ctx } = setup();
    const tool = tools.get("cron_update");
    if (!tool?.renderCall || !tool.renderResult) {
      throw new Error("cron_update renderers were not registered");
    }
    const args = {
      selector: "job-1",
      prompt: "new instructions",
      every: "2h",
      maxRuns: 3,
      mode: "isolated" as const,
      tools: ["read", "bash"],
      notify: true,
    };
    const theme = fakeTheme();
    const collapsedCall = tool
      .renderCall(args, theme, { expanded: false })
      .render(1_000)
      .join("\n")
      .trimEnd();
    const expandedCall = tool
      .renderCall(args, theme, { expanded: true })
      .render(1_000)
      .join("\n")
      .trimEnd();
    const result = await execute(tool, args, ctx);
    const collapsedResult = tool
      .renderResult(result, { expanded: false }, theme)
      .render(1_000)
      .join("\n")
      .trimEnd();
    const expandedResult = tool
      .renderResult(result, { expanded: true }, theme)
      .render(1_000)
      .join("\n")
      .trimEnd();

    expect(collapsedCall).toBe(
      "cron_update job-1 · every 2h · overlap unchanged · isolated · tools read,bash · notify on",
    );
    expect(collapsedCall).not.toContain("new instructions");
    expect(expandedCall).toContain('"prompt": "new instructions"');
    expect(expandedCall).toContain('"every": "2h"');
    expect(expandedCall).toContain('"maxRuns": 3');
    expect(collapsedResult).toBe(
      "Updated Report (job-1) · every 1m · overlap queue · main · tools inherited · notify n/a",
    );
    expect(expandedResult).toContain("Schedule: every 1m");
  });

  it("propagates creation failures", async () => {
    const cancelled = setup({
      create: vi.fn(async () => {
        throw new Error("Cron job creation cancelled");
      }),
    });
    await expect(
      execute(
        cancelled.tools.get("cron_create"),
        { prompt: "check", every: "5m" },
        cancelled.ctx,
      ),
    ).rejects.toThrow("cancelled");
  });

  it("propagates recursive creation rejection as a failed tool", async () => {
    const recursive = setup({
      create: vi.fn(async () => {
        throw new Error("Scheduled runs cannot create cron jobs");
      }),
    });
    await expect(
      execute(
        recursive.tools.get("cron_create"),
        { prompt: "again", adaptive: true },
        recursive.ctx,
      ),
    ).rejects.toThrow("cannot create cron jobs");
  });

  it("rejects invalid schedule combinations before service mutation", async () => {
    const { tools, service, ctx } = setup();
    await expect(
      execute(
        tools.get("cron_create"),
        { prompt: "x", every: "5m", adaptive: true },
        ctx,
      ),
    ).rejects.toThrow("exactly one schedule");
    expect(service.create).not.toHaveBeenCalled();
  });

  it("updates, runs, deletes, and wakes through runtime adapters", async () => {
    const { tools, service, runNow, applyWakeup, ctx } = setup();
    await execute(
      tools.get("cron_update"),
      { selector: "job-1", state: "paused" },
      ctx,
    );
    expect(service.pause).toHaveBeenCalled();
    await execute(
      tools.get("cron_update"),
      { selector: "job-1", every: "2h" },
      ctx,
    );
    expect(service.replace).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      {
        approvalMode: "automatic",
      },
    );
    await execute(tools.get("cron_run"), { selector: "job-1" }, ctx);
    expect(runNow).toHaveBeenCalledWith("job-1");
    await execute(tools.get("cron_delete"), { selector: "job-1" }, ctx);
    expect(service.delete).toHaveBeenCalledWith("job-1");
    await execute(
      tools.get("cron_wakeup"),
      { delay: "5m", reason: "later" },
      ctx,
    );
    expect(applyWakeup).toHaveBeenCalledWith({ delay: "5m", reason: "later" });
  });

  it("creates and copies stopped saved definitions with automatic approval", async () => {
    const { tools, savedService, assertSavedMutationAllowed, ctx } = setup();

    await execute(
      tools.get("cron_saved_create"),
      { prompt: "save this", every: "5m", overlap: "skip" },
      ctx,
    );
    expect(assertSavedMutationAllowed).toHaveBeenCalledTimes(1);
    expect(savedService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: { kind: "text", text: "save this" },
        schedule: { kind: "interval", intervalMs: 300_000 },
        overlap: "skip",
      }),
      { approvalMode: "automatic" },
    );

    await execute(
      tools.get("cron_saved_copy"),
      { selector: "job-1", name: "Reusable" },
      ctx,
    );
    expect(assertSavedMutationAllowed).toHaveBeenCalledTimes(2);
    expect(savedService.copy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1" }),
      "Reusable",
      { approvalMode: "automatic" },
    );
  });

  it("lists saved definitions without requiring mutation access", async () => {
    const { tools, savedService, assertSavedMutationAllowed, ctx } = setup();

    const result = await execute(tools.get("cron_saved_list"), {}, ctx);

    expect(savedService.list).toHaveBeenCalledOnce();
    expect(assertSavedMutationAllowed).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("save1234  stopped");
    expect(result.content[0].text).toContain("every 300000ms");
    expect(result.content[0].text).toContain("exec=main resources=inherited");
    expect(result.content[0].text).toContain("overlap=queue");
    expect(result.content[0].text).not.toContain("Saved secret");
  });

  it("updates and deletes saved definitions through guarded mutations", async () => {
    const { tools, savedService, assertSavedMutationAllowed, ctx } = setup();

    await execute(
      tools.get("cron_saved_update"),
      { selector: "saved", every: "2h", overlap: "skip" },
      ctx,
    );
    expect(savedService.select).toHaveBeenCalledWith("saved");
    expect(savedService.replace).toHaveBeenCalledWith(
      "save1234",
      expect.objectContaining({
        schedule: { kind: "interval", intervalMs: 7_200_000 },
        overlap: "skip",
      }),
      { approvalMode: "automatic" },
    );

    await execute(tools.get("cron_saved_delete"), { selector: "saved" }, ctx);
    expect(savedService.delete).toHaveBeenCalledWith("save1234");
    expect(assertSavedMutationAllowed).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh saved activation in the current session with automatic approval", async () => {
    const { tools, startSaved, assertSavedMutationAllowed, ctx } = setup();
    startSaved.mockResolvedValue({
      ...job(),
      savedDefinitionId: "save1234",
      state: "active",
      runCount: 0,
      attributedTokens: 0,
      consecutiveFailures: 0,
      skippedRuns: 0,
    });

    const result = await execute(
      tools.get("cron_saved_start"),
      { selector: "saved" },
      ctx,
    );

    expect(startSaved).toHaveBeenCalledWith("saved", "automatic");
    expect(assertSavedMutationAllowed).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Started Report (job-1)");
    expect(result.details).toEqual(
      expect.objectContaining({
        job: expect.objectContaining({
          savedDefinitionId: "save1234",
          state: "active",
          runCount: 0,
          attributedTokens: 0,
          consecutiveFailures: 0,
          skippedRuns: 0,
          schedule: { kind: "interval", intervalMs: 60_000, anchorAt: NOW },
        }),
      }),
    );
  });

  it("rejects every saved catalog mutation when a scheduled run is active", async () => {
    const configured = setup();
    configured.assertSavedMutationAllowed.mockImplementation(() => {
      throw new Error("Scheduled runs cannot mutate saved cron definitions");
    });
    const cases: Array<{
      tool: string;
      input: Record<string, unknown>;
      mutation: unknown;
    }> = [
      {
        tool: "cron_saved_create",
        input: { prompt: "x", every: "5m" },
        mutation: configured.savedService.create,
      },
      {
        tool: "cron_saved_copy",
        input: { selector: "job-1" },
        mutation: configured.savedService.copy,
      },
      {
        tool: "cron_saved_update",
        input: { selector: "saved", overlap: "skip" },
        mutation: configured.savedService.replace,
      },
      {
        tool: "cron_saved_delete",
        input: { selector: "saved" },
        mutation: configured.savedService.delete,
      },
    ];

    for (const testCase of cases) {
      await expect(
        execute(
          configured.tools.get(testCase.tool),
          testCase.input,
          configured.ctx,
        ),
      ).rejects.toThrow("cannot mutate saved cron definitions");
      expect(testCase.mutation).not.toHaveBeenCalled();
    }
    expect(configured.assertSavedMutationAllowed).toHaveBeenCalledTimes(4);
  });

  it("propagates recursive saved-start rejection", async () => {
    const configured = setup();
    configured.startSaved.mockRejectedValue(
      new Error("Scheduled runs cannot mutate saved cron definitions"),
    );

    await expect(
      execute(
        configured.tools.get("cron_saved_start"),
        { selector: "saved" },
        configured.ctx,
      ),
    ).rejects.toThrow("cannot mutate saved cron definitions");
    expect(configured.startSaved).toHaveBeenCalledWith("saved", "automatic");
  });

  it("rejects invalid saved schedules before catalog mutation", async () => {
    const { tools, savedService, ctx } = setup();

    await expect(
      execute(
        tools.get("cron_saved_create"),
        { prompt: "x", every: "5m", adaptive: true },
        ctx,
      ),
    ).rejects.toThrow("exactly one schedule");
    expect(savedService.create).not.toHaveBeenCalled();

    await expect(
      execute(tools.get("cron_saved_create"), { prompt: "x" }, ctx),
    ).rejects.toThrow("exactly one schedule");
  });

  it("propagates saved catalog trust failures", async () => {
    const configured = setup(
      {},
      {
        list: vi.fn(async () => {
          throw new Error("Saved cron definitions require a trusted project");
        }),
      },
    );

    await expect(
      execute(configured.tools.get("cron_saved_list"), {}, configured.ctx),
    ).rejects.toThrow("trusted project");
  });

  it("keeps saved mutation prompts out of collapsed rendering", async () => {
    const { tools, ctx } = setup();
    const create = tools.get("cron_saved_create");
    const update = tools.get("cron_saved_update");
    if (!create?.renderCall || !create.renderResult || !update?.renderCall) {
      throw new Error("saved mutation renderers were not registered");
    }
    const theme = fakeTheme();
    const args = {
      prompt: "secret prompt",
      every: "5m",
      mode: "isolated" as const,
      tools: ["read"],
      overlap: "skip" as const,
    };
    const collapsedCall = create
      .renderCall(args, theme, { expanded: false })
      .render(1_000)
      .join("\n");
    const expandedCall = create
      .renderCall(args, theme, { expanded: true })
      .render(1_000)
      .join("\n");
    const result = await execute(create, args, ctx);
    const collapsedResult = create
      .renderResult(result, { expanded: false }, theme)
      .render(1_000)
      .join("\n");
    const collapsedUpdate = update
      .renderCall(
        { selector: "saved", prompt: "new secret", every: "2h" },
        theme,
        { expanded: false },
      )
      .render(1_000)
      .join("\n");

    expect(collapsedCall).toContain("every 5m");
    expect(collapsedCall).toContain("tools read");
    expect(collapsedCall).toContain("overlap skip");
    expect(collapsedCall).not.toContain("secret prompt");
    expect(expandedCall).toContain("secret prompt");
    expect(collapsedResult).toContain("save1234  stopped");
    expect(collapsedResult).not.toContain("Saved secret");
    expect(collapsedUpdate).toContain("every 2h");
    expect(collapsedUpdate).toContain("overlap unchanged");
    expect(collapsedUpdate).toContain("mode unchanged");
    expect(collapsedUpdate).toContain("tools unchanged");
    expect(collapsedUpdate).not.toContain("new secret");
  });

  it("fails wakeup outside an active main execution", async () => {
    const configured = setup();
    const runtime = {
      requireService: () => configured.service,
      getScheduler: () => undefined,
      getMainExecutor: () => undefined,
      runManager: vi.fn(),
      runWizard: vi.fn(),
      stopAll: vi.fn(),
    } as unknown as CronRuntimeRef;
    const tools = new Map<string, CapturedTool>();
    const pi = {
      registerTool: (tool: unknown) => {
        const captured = tool as CapturedTool;
        tools.set(captured.name, captured);
      },
      getCommands: () => [],
      getThinkingLevel: () => "medium",
    } as unknown as ExtensionAPI;
    registerCronTools(pi, runtime);
    await expect(
      execute(
        tools.get("cron_wakeup"),
        { stop: true, reason: "done" },
        configured.ctx,
      ),
    ).rejects.toThrow("unavailable");
  });
});
