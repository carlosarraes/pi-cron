import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../src/domain/types.js";
import {
  formatDuration,
  renderRow,
  visibleColumns,
} from "../../src/ui/format.js";
import type { CronManagerActions } from "../../src/ui/manager.js";
import { CronManagerComponent, runCronManager } from "../../src/ui/manager.js";
import {
  registerCronRenderers,
  updateCronStatus,
} from "../../src/ui/status.js";

const NOW = new Date("2026-07-15T10:00:00.000Z");

function job(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id,
    name: `Job ${id}`,
    prompt: { kind: "text", text: `Prompt for ${id}\nsecond line` },
    schedule: {
      kind: "interval",
      intervalMs: 60_000,
      anchorAt: NOW.toISOString(),
    },
    state: "active",
    execution: { kind: "main" },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    expiresAt: "2026-07-22T10:00:00.000Z",
    runCount: 0,
    attributedTokens: 0,
    consecutiveFailures: 0,
    approval: { approvedAt: NOW.toISOString(), fingerprint: "ok" },
    originSessionId: "session",
    ...overrides,
  };
}

function fakeTheme(): Theme {
  return {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  } as unknown as Theme;
}

function managerHarness(
  initialJobs = [job("one"), job("two")],
  readOnly = false,
) {
  let jobs = initialJobs;
  const requestRender = vi.fn();
  const actions: CronManagerActions = {
    jobs: () => jobs,
    runtimeStatus: (id) =>
      id === "two"
        ? { state: "pending", pendingSince: NOW.toISOString() }
        : { state: "idle" },
    add: vi.fn(async () => undefined),
    togglePause: vi.fn(async () => undefined),
    runNow: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async (id) => {
      jobs = jobs.filter((current) => current.id !== id);
    }),
    command: vi.fn(async () => undefined),
    close: vi.fn(),
    onError: vi.fn(),
  };
  const component = new CronManagerComponent({
    tui: { requestRender },
    theme: fakeTheme(),
    actions,
    readOnlyOwner: readOnly ? { pid: 42 } : undefined,
    now: () => NOW,
  });
  return { component, actions, requestRender };
}

async function settleAsync(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

describe("manager formatting", () => {
  it("uses responsive wide, medium, and narrow columns", () => {
    expect(visibleColumns(120)).toEqual([
      "state",
      "name",
      "schedule",
      "next",
      "last",
      "runs",
      "mode",
      "expires",
    ]);
    expect(visibleColumns(100)).not.toContain("last");
    expect(visibleColumns(80)).not.toContain("runs");
    expect(visibleColumns(60)).not.toContain("expires");
    for (const width of [60, 80, 100, 120]) {
      expect(visibleColumns(width)).toEqual(
        expect.arrayContaining(["state", "name", "schedule", "next"]),
      );
    }
  });

  it("renders ANSI-safe bounded rows and human durations", () => {
    const columns = visibleColumns(60);
    const values = Object.fromEntries(
      columns.map((column) => [
        column,
        `\u001b[31mvery long ${column} value\u001b[0m`,
      ]),
    ) as Record<(typeof columns)[number], string>;
    const rendered = renderRow({ id: "x", values }, columns, 60);
    expect(visibleWidth(rendered)).toBeLessThanOrEqual(60);
    expect(formatDuration(90_000)).toBe("1m");
    expect(formatDuration(-60_000)).toBe("1m ago");
  });
});

describe("CronManagerComponent", () => {
  it("renders rows, state icon plus text, and full selected details", () => {
    const { component } = managerHarness();
    const text = component.render(120).join("\n");
    expect(text).toContain("● active");
    expect(text).toContain("◷ pending");
    expect(text).toContain("Prompt for one");
    expect(text).toContain("second line");
  });

  it("selects jobs and dispatches add/pause/run/edit/delete keys", async () => {
    const { component, actions } = managerHarness();
    component.handleInput("\u001b[B");
    expect(component.selectedJobId()).toBe("two");
    component.handleInput("p");
    component.handleInput("r");
    component.handleInput("e");
    component.handleInput("x");
    component.handleInput("a");
    await settleAsync();
    expect(actions.togglePause).toHaveBeenCalledWith("two");
    expect(actions.runNow).toHaveBeenCalledWith("two");
    expect(actions.edit).toHaveBeenCalledWith("two");
    expect(actions.remove).toHaveBeenCalledWith("two");
    expect(actions.add).toHaveBeenCalledOnce();
  });

  it("supports search, colon command mode, and completion", async () => {
    const { component, actions } = managerHarness();
    component.handleInput("/");
    for (const char of "two") component.handleInput(char);
    expect(component.render(100).join("\n")).toContain("Job two");
    expect(component.render(100).join("\n")).not.toContain("Job one");
    component.handleInput("\u001b");

    component.handleInput(":");
    component.handleInput("p");
    component.handleInput("\t");
    component.handleInput("\r");
    await settleAsync();
    expect(actions.command).toHaveBeenCalledWith("pause ".trim());
  });

  it("renders empty and read-only states and blocks mutations", async () => {
    const empty = managerHarness([], true);
    expect(empty.component.render(80).join("\n")).toContain("READ-ONLY");
    expect(empty.component.render(80).join("\n")).toContain("No cron jobs");
    empty.component.handleInput("a");
    empty.component.handleInput("p");
    await settleAsync();
    expect(empty.actions.add).not.toHaveBeenCalled();
    expect(empty.actions.togglePause).not.toHaveBeenCalled();
  });

  it("closes on q or escape", () => {
    const first = managerHarness();
    first.component.handleInput("q");
    expect(first.actions.close).toHaveBeenCalledOnce();
    const second = managerHarness();
    second.component.handleInput("\u001b");
    expect(second.actions.close).toHaveBeenCalledOnce();
  });
});

describe("runCronManager", () => {
  it("returns focus after the custom manager closes", async () => {
    const base = managerHarness();
    const ctx = {
      mode: "tui",
      ui: {
        custom: vi.fn(async (factory) => {
          const component = factory(
            { requestRender: vi.fn() },
            fakeTheme(),
            {},
            () => undefined,
          );
          expect(component).toBeInstanceOf(CronManagerComponent);
        }),
      },
    } as unknown as ExtensionCommandContext;
    const { close: _close, ...actions } = base.actions;
    await runCronManager(ctx, { actions });
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
  });
});

describe("status and transcript renderers", () => {
  it("sets and clears ambient footer status", () => {
    const setStatus = vi.fn();
    const ctx = { ui: { setStatus } } as unknown as ExtensionCommandContext;
    updateCronStatus(
      ctx,
      { list: () => [job("one")] },
      {
        nextDue: () => ({
          jobId: "one",
          name: "Job one",
          at: new Date(NOW.getTime() + 60_000),
        }),
      },
      NOW,
    );
    expect(setStatus).toHaveBeenLastCalledWith(
      "pi-cron",
      "cron 1 · next Job one in 1m",
    );
    updateCronStatus(ctx, { list: () => [] }, undefined, NOW);
    expect(setStatus).toHaveBeenLastCalledWith("pi-cron", undefined);
  });

  it("registers collapsed and expanded run/result entry renderers", () => {
    type Renderer = (
      entry: { data: unknown },
      options: { expanded: boolean },
      theme: Theme,
    ) => { render(width: number): string[] };
    const renderers = new Map<string, Renderer>();
    const pi = {
      registerEntryRenderer: (name: string, renderer: Renderer) =>
        renderers.set(name, renderer),
    } as unknown as ExtensionAPI;
    registerCronRenderers(pi);
    expect([...renderers.keys()]).toEqual(["pi-cron/run", "pi-cron/result"]);
    const theme = fakeTheme();
    const run = renderers.get("pi-cron/run")?.(
      {
        data: {
          jobId: "one",
          scheduledAt: NOW.toISOString(),
          dispatchedAt: NOW.toISOString(),
        },
      },
      { expanded: false },
      theme,
    );
    const result = renderers.get("pi-cron/result")?.(
      {
        data: { jobId: "one", outcome: "settled", tokens: 12, summary: "done" },
      },
      { expanded: true },
      theme,
    );
    expect(run?.render(100).join("\n")).toContain("cron ▶ one");
    expect(result?.render(100).join("\n")).toContain("Usage: 12 tokens");
  });
});
