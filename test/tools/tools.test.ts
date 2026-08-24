import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { CronRuntimeRef } from "../../src/commands/register.js";
import type { CronService } from "../../src/core/service.js";
import type { CronJob } from "../../src/domain/types.js";
import { registerCronTools } from "../../src/tools/register.js";
import {
  CronCreateParams,
  CronDeleteParams,
  CronListParams,
  CronRunParams,
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

function setup(overrides: Partial<CronService> = {}) {
  const current = job();
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
  const runtime: CronRuntimeRef = {
    requireService: () => service,
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
  return { tools, service, applyWakeup, runNow, ctx };
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
  it("defines all six strict schemas", () => {
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
    expect(Value.Check(CronWakeupParams, { delay: "5m" })).toBe(false);
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
    ]);
    for (const tool of tools.values()) {
      expect(tool.promptSnippet).toBeTruthy();
      expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
    }
  });

  it("lists jobs without requiring UI", async () => {
    const { tools, ctx } = setup();
    const result = await execute(tools.get("cron_list"), {}, ctx);
    expect(result.content[0].text).toContain("job-1");
  });

  it("requests automatic approval when creating from the LLM tool", async () => {
    const { tools, service, ctx } = setup();

    await execute(
      tools.get("cron_create"),
      { prompt: "check", every: "5m" },
      ctx,
    );

    expect(service.create).toHaveBeenCalledWith(expect.any(Object), {
      approvalMode: "automatic",
    });
  });

  it("keeps create details collapsed until tool output is expanded", async () => {
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

    expect(collapsedCall).toBe("cron_create");
    expect(expandedCall).toContain('"prompt": "check the build"');
    expect(collapsedResult).toBe("Created Report (job-1)");
    expect(collapsedResult).not.toContain("Prompt:");
    expect(expandedResult).toContain("Schedule: every 1m");
  });

  it("keeps update details collapsed until tool output is expanded", async () => {
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

    expect(collapsedCall).toBe("cron_update job-1");
    expect(expandedCall).toContain('"prompt": "new instructions"');
    expect(expandedCall).toContain('"every": "2h"');
    expect(expandedCall).toContain('"maxRuns": 3');
    expect(collapsedResult).toBe("Updated Report: every 1m");
    expect(collapsedResult).not.toContain("Schedule:");
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
