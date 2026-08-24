import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ProposedJob } from "../../src/domain/types.js";
import {
  fingerprintJob,
  formatApproval,
  UiApprovalPort,
} from "../../src/ui/approval.js";
import {
  initialWizardState,
  reduceWizard,
  runCronWizard,
} from "../../src/ui/wizard.js";

const NOW = new Date("2026-07-15T10:00:00.000Z");

function proposal(): ProposedJob {
  return {
    version: 1,
    id: "job-1",
    name: "Report",
    prompt: { kind: "text", text: "Full multiline\nprompt" },
    schedule: {
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "UTC",
    },
    state: "active",
    execution: {
      kind: "isolated",
      model: "openai/model-a",
      effort: "high",
      tools: ["read"],
      skills: ["review"],
      extensions: ["safe"],
      notify: true,
      timeoutMs: 60_000,
    },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    expiresAt: "2026-07-22T10:00:00.000Z",
    maxRuns: 10,
    tokenBudget: 20_000,
    runCount: 0,
    attributedTokens: 0,
    consecutiveFailures: 0,
    originSessionId: "session",
  };
}

function wizardContext(options: {
  selections: Array<string | undefined>;
  editor?: string | undefined;
  inputs?: Array<string | undefined>;
  notify?: boolean;
  models?: Model<Api>[];
}) {
  const titles: string[] = [];
  const selections = [...options.selections];
  const inputs = [...(options.inputs ?? [])];
  const ctx = {
    mode: "rpc",
    modelRegistry: {
      getAvailable: () =>
        options.models ??
        ([
          {
            provider: "openai",
            id: "model-a",
            name: "Model A",
            reasoning: true,
          } as Model<Api>,
        ] as Model<Api>[]),
    },
    ui: {
      select: vi.fn(async (title: string) => {
        titles.push(title);
        return selections.shift();
      }),
      editor: vi.fn(async () => options.editor),
      input: vi.fn(async () => inputs.shift()),
      confirm: vi.fn(async () => options.notify ?? false),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, titles };
}

describe("wizard reducer", () => {
  it("advances through the five named steps in order", () => {
    let state = initialWizardState({
      schedule: { kind: "adaptive" },
      prompt: "work",
    });
    const steps = [state.step];
    for (let index = 0; index < 4; index += 1) {
      state = reduceWizard(state, { type: "next" });
      steps.push(state.step);
    }
    expect(steps).toEqual([
      "schedule",
      "prompt",
      "execution",
      "limits",
      "review",
    ]);
  });

  it("retains entered values on back navigation", () => {
    let state = initialWizardState({
      step: "execution",
      schedule: { kind: "interval", value: "15m" },
      prompt: "keep me",
      execution: { kind: "main" },
    });
    state = reduceWizard(state, { type: "back" });
    expect(state).toMatchObject({
      step: "prompt",
      prompt: "keep me",
      schedule: { kind: "interval", value: "15m" },
    });
  });

  it("keeps same-step validation errors and cancellation state", () => {
    let state = initialWizardState();
    state = reduceWizard(state, { type: "next" });
    expect(state).toMatchObject({
      step: "schedule",
      error: "Choose a schedule",
    });
    state = reduceWizard(state, { type: "cancel" });
    expect(state.cancelled).toBe(true);
  });
});

describe("runCronWizard", () => {
  it("builds a main-session draft with an exact next-run preview", async () => {
    const { ctx, titles } = wizardContext({
      selections: [
        "Every 5m",
        "Continue",
        "Main session — inherits model + effort at fire time",
        "Use defaults (7d expiry, 3-failure pause)",
        "Continue to approval",
      ],
      editor: "preserve\nmultiline",
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const result = await runCronWizard(ctx);
    vi.useRealTimers();

    expect(result).toMatchObject({
      prompt: { kind: "text", text: "preserve\nmultiline" },
      schedule: { kind: "interval", intervalMs: 300_000 },
      execution: { kind: "main" },
    });
    expect(titles).toEqual(
      expect.arrayContaining([
        "1/5 Schedule",
        "2/5 Prompt",
        "3/5 Execution",
        "4/5 Limits",
        expect.stringContaining("next 2026-07-15T10:05:00.000Z"),
      ]),
    );
  });

  it("pins isolated model/effort and selected resources", async () => {
    const { ctx } = wizardContext({
      selections: [
        "Adaptive",
        "Continue",
        "Isolated",
        "openai/model-a",
        "high",
        "Use defaults (7d expiry, 3-failure pause)",
        "Continue to approval",
      ],
      editor: "adaptive work",
      notify: true,
      inputs: ["read,bash", "review", "safe-ext"],
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const result = await runCronWizard(ctx);
    vi.useRealTimers();

    expect(result?.execution).toEqual({
      kind: "isolated",
      model: "openai/model-a",
      effort: "high",
      tools: ["read", "bash"],
      skills: ["review"],
      extensions: ["safe-ext"],
      notify: true,
      timeoutMs: 30 * 60_000,
    });
  });

  it("cancels without producing a draft", async () => {
    const { ctx } = wizardContext({ selections: ["Cancel"] });
    await expect(runCronWizard(ctx)).resolves.toBeUndefined();
  });

  it("rejects noninteractive JSON/print modes with strict guidance", async () => {
    const { ctx } = wizardContext({ selections: [] });
    Object.assign(ctx, { mode: "json" });
    await expect(runCronWizard(ctx)).rejects.toThrow("strict /cron add flags");
  });
});

describe("UiApprovalPort", () => {
  it("formats normalized complete approval text and fingerprint", () => {
    const text = formatApproval(proposal(), NOW);
    expect(text).toContain("Full multiline\nprompt");
    expect(text).toContain("Next run: 2026-07-16T09:00:00.000Z");
    expect(text).toContain("Timezone: UTC");
    expect(text).toContain("Model: openai/model-a");
    expect(text).toContain("Tools: read");
    expect(text).toContain("Notify parent: yes");
    expect(text).toContain("Credentials warning");
    expect(text).toContain(fingerprintJob(proposal()));
    expect(fingerprintJob(proposal())).toHaveLength(64);
  });

  it("returns approval on confirmation and undefined on cancellation", async () => {
    const confirm = vi.fn(async () => true);
    const ctx = { hasUI: true, ui: { confirm } } as unknown as Pick<
      ExtensionContext,
      "hasUI" | "ui"
    >;
    const port = new UiApprovalPort(ctx, () => NOW);
    await expect(port.approve(proposal(), "create")).resolves.toEqual({
      approvedAt: NOW.toISOString(),
      fingerprint: fingerprintJob(proposal()),
    });
    confirm.mockResolvedValue(false);
    await expect(
      port.approve(proposal(), "privilege_increase"),
    ).resolves.toBeUndefined();
  });

  it("auto-approves without interactive UI or confirmation", async () => {
    const confirm = vi.fn(async () => false);
    const ctx = { hasUI: false, ui: { confirm } } as unknown as Pick<
      ExtensionContext,
      "hasUI" | "ui"
    >;
    await expect(
      new UiApprovalPort(ctx, () => NOW).approve(
        proposal(),
        "create",
        "automatic",
      ),
    ).resolves.toEqual({
      approvedAt: NOW.toISOString(),
      fingerprint: fingerprintJob(proposal()),
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects interactive approval without UI", async () => {
    const ctx = { hasUI: false, ui: {} } as unknown as Pick<
      ExtensionContext,
      "hasUI" | "ui"
    >;
    await expect(
      new UiApprovalPort(ctx).approve(proposal(), "create"),
    ).rejects.toThrow("interactive approval");
  });
});
