import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionDraft, ScheduleInput } from "../commands/parse.js";
import type { JobDraft } from "../core/service.js";
import {
  nextOccurrence,
  parseDuration,
  resolveSchedule,
} from "../domain/schedule.js";
import { DEFAULT_LIMITS, type OverlapPolicy } from "../domain/types.js";

export type WizardStep =
  | "schedule"
  | "prompt"
  | "execution"
  | "overlap"
  | "limits"
  | "review";

export interface LimitsDraft {
  expires?: string;
  maxRuns?: number;
  tokenBudget?: number;
  timeout?: string;
}

export interface WizardState {
  step: WizardStep;
  schedule?: ScheduleInput;
  prompt: string;
  execution: ExecutionDraft;
  overlap: OverlapPolicy;
  limits: LimitsDraft;
  error?: string;
  cancelled?: boolean;
}

export type WizardAction =
  | { type: "set_schedule"; schedule: ScheduleInput }
  | { type: "set_prompt"; prompt: string }
  | { type: "set_execution"; execution: ExecutionDraft }
  | { type: "set_overlap"; overlap: OverlapPolicy }
  | { type: "set_limits"; limits: LimitsDraft }
  | { type: "next" }
  | { type: "back" }
  | { type: "error"; message: string }
  | { type: "cancel" };

export type WizardResult = JobDraft | undefined;

const STEPS: WizardStep[] = [
  "schedule",
  "prompt",
  "execution",
  "overlap",
  "limits",
  "review",
];

export function initialWizardState(
  seed: Partial<WizardState> = {},
): WizardState {
  return {
    step: seed.step ?? "schedule",
    schedule: seed.schedule,
    prompt: seed.prompt ?? "",
    execution: seed.execution ?? { kind: "main" },
    overlap: seed.overlap ?? "queue",
    limits: seed.limits ?? {},
    error: seed.error,
  };
}

export function reduceWizard(
  state: WizardState,
  action: WizardAction,
): WizardState {
  switch (action.type) {
    case "set_schedule":
      return { ...state, schedule: action.schedule, error: undefined };
    case "set_prompt":
      return { ...state, prompt: action.prompt, error: undefined };
    case "set_execution":
      return { ...state, execution: action.execution, error: undefined };
    case "set_overlap":
      return { ...state, overlap: action.overlap, error: undefined };
    case "set_limits":
      return { ...state, limits: { ...action.limits }, error: undefined };
    case "back":
      return {
        ...state,
        step: STEPS[Math.max(0, STEPS.indexOf(state.step) - 1)] as WizardStep,
        error: undefined,
      };
    case "cancel":
      return { ...state, cancelled: true };
    case "error":
      return { ...state, error: action.message };
    case "next": {
      const error = validateStep(state);
      if (error) return { ...state, error };
      return {
        ...state,
        step: STEPS[
          Math.min(STEPS.length - 1, STEPS.indexOf(state.step) + 1)
        ] as WizardStep,
        error: undefined,
      };
    }
  }
}

export async function runCronWizard(
  ctx: ExtensionCommandContext,
  seed: Partial<WizardState> = {},
): Promise<WizardResult> {
  if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
    throw new Error(
      "/cron add requires TUI or RPC mode; use strict /cron add flags",
    );
  }
  let state = initialWizardState(seed);

  while (!state.cancelled) {
    switch (state.step) {
      case "schedule": {
        const selected = await ctx.ui.select("1/6 Schedule", [
          "Every 5m",
          "Every 15m",
          "Every 30m",
          "Every 1h",
          "Every 2h",
          "Every 6h",
          "Every 1d",
          "Every custom",
          "Cron expression",
          "Once in",
          "At timestamp",
          "Adaptive",
          "Cancel",
        ]);
        if (!selected || selected === "Cancel") return undefined;
        let schedule: ScheduleInput;
        if (selected.startsWith("Every ") && selected !== "Every custom") {
          schedule = { kind: "interval", value: selected.slice(6) };
        } else if (selected === "Every custom") {
          const value = await ctx.ui.input("Custom interval", "e.g. 90m");
          if (!value) continue;
          schedule = { kind: "interval", value };
        } else if (selected === "Cron expression") {
          const value = await ctx.ui.input("Five-field cron", "3 9 * * 1-5");
          if (!value) continue;
          schedule = { kind: "cron", value };
        } else if (selected === "Once in") {
          const value = await ctx.ui.input("Delay", "e.g. 45m");
          if (!value) continue;
          schedule = { kind: "in", value };
        } else if (selected === "At timestamp") {
          const value = await ctx.ui.input("Timestamp", "2026-07-15 09:00");
          if (!value) continue;
          schedule = { kind: "at", value };
        } else {
          schedule = { kind: "adaptive" };
        }
        try {
          resolveSchedule(schedule, new Date());
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          state = reduceWizard(state, { type: "error", message });
          ctx.ui.notify(message, "error");
          break;
        }
        state = reduceWizard(state, { type: "set_schedule", schedule });
        state = reduceWizard(state, { type: "next" });
        break;
      }
      case "prompt": {
        const prompt = await ctx.ui.editor("2/6 Prompt", state.prompt);
        if (prompt === undefined) return undefined;
        state = reduceWizard(state, { type: "set_prompt", prompt });
        const next = await ctx.ui.select("2/6 Prompt", [
          "Continue",
          "Back",
          "Cancel",
        ]);
        if (next === "Back") state = reduceWizard(state, { type: "back" });
        else if (!next || next === "Cancel") return undefined;
        else state = reduceWizard(state, { type: "next" });
        break;
      }
      case "execution": {
        const choice = await ctx.ui.select("3/6 Execution", [
          "Main session — inherits model + effort at fire time",
          "Isolated",
          "Back",
          "Cancel",
        ]);
        if (choice === "Back") {
          state = reduceWizard(state, { type: "back" });
          break;
        }
        if (!choice || choice === "Cancel") return undefined;
        if (choice.startsWith("Main")) {
          state = reduceWizard(state, {
            type: "set_execution",
            execution: { kind: "main" },
          });
        } else {
          const execution = await collectIsolatedExecution(
            ctx,
            state.execution,
          );
          if (!execution) break;
          state = reduceWizard(state, { type: "set_execution", execution });
        }
        state = reduceWizard(state, { type: "next" });
        break;
      }
      case "overlap": {
        const choice = await ctx.ui.select("4/6 Overlap", [
          "Queue one missed run (default)",
          "Skip ticks while this job is running",
          "Back",
          "Cancel",
        ]);
        if (choice === "Back") {
          state = reduceWizard(state, { type: "back" });
          break;
        }
        if (!choice || choice === "Cancel") return undefined;
        state = reduceWizard(state, {
          type: "set_overlap",
          overlap: choice.startsWith("Skip") ? "skip" : "queue",
        });
        state = reduceWizard(state, { type: "next" });
        break;
      }
      case "limits": {
        const choice = await ctx.ui.select("5/6 Limits", [
          "Use defaults (7d expiry, 3-failure pause)",
          "Customize",
          "Back",
          "Cancel",
        ]);
        if (choice === "Back") {
          state = reduceWizard(state, { type: "back" });
          break;
        }
        if (!choice || choice === "Cancel") return undefined;
        if (choice === "Customize") {
          try {
            const limits = await collectLimits(
              ctx,
              state.limits,
              state.execution.kind === "isolated",
            );
            if (!limits) break;
            state = reduceWizard(state, { type: "set_limits", limits });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            state = reduceWizard(state, { type: "error", message });
            ctx.ui.notify(message, "error");
            break;
          }
        }
        state = reduceWizard(state, { type: "next" });
        break;
      }
      case "review": {
        const preview = buildDraft(state, new Date());
        const nextAt = nextOccurrence(preview.schedule, new Date());
        const choice = await ctx.ui.select(
          `6/6 Review — next ${nextAt?.toISOString() ?? "none"}`,
          ["Continue to approval", "Back", "Cancel"],
        );
        if (choice === "Back") {
          state = reduceWizard(state, { type: "back" });
          break;
        }
        if (!choice || choice === "Cancel") return undefined;
        return preview;
      }
    }
  }
  return undefined;
}

function validateStep(state: WizardState): string | undefined {
  if (state.step === "schedule" && !state.schedule) return "Choose a schedule";
  if (state.step === "prompt" && state.prompt.trim().length === 0) {
    return "Prompt cannot be empty";
  }
  return undefined;
}

function buildDraft(state: WizardState, now: Date): JobDraft {
  if (!state.schedule) throw new Error("Choose a schedule");
  const execution =
    state.execution.kind === "main"
      ? ({ kind: "main" } as const)
      : {
          kind: "isolated" as const,
          model: state.execution.model as string,
          effort: state.execution.effort ?? "medium",
          tools: state.execution.tools ?? [],
          skills: state.execution.skills ?? [],
          extensions: state.execution.extensions ?? [],
          notify: state.execution.notify === true,
          timeoutMs: state.limits.timeout
            ? parseDuration(state.limits.timeout)
            : state.execution.timeout
              ? parseDuration(state.execution.timeout)
              : DEFAULT_LIMITS.isolatedTimeoutMs,
        };
  return {
    prompt: { kind: "text", text: state.prompt },
    schedule: resolveSchedule(state.schedule, now),
    execution,
    overlap: state.overlap,
    expiresAt: state.limits.expires
      ? parseExpiry(state.limits.expires, now)
      : undefined,
    maxRuns: state.limits.maxRuns,
    tokenBudget: state.limits.tokenBudget,
  };
}

async function collectIsolatedExecution(
  ctx: ExtensionCommandContext,
  previous: ExecutionDraft,
): Promise<ExecutionDraft | undefined> {
  const models = ctx.modelRegistry.getAvailable();
  const labels = models.map((model) => `${model.provider}/${model.id}`);
  const selected = await ctx.ui.select("Isolated model", labels);
  if (!selected) return undefined;
  const model = models[labels.indexOf(selected)];
  if (!model) return undefined;
  const efforts = getSupportedThinkingLevels(model);
  const effort = await ctx.ui.select("Thinking effort", efforts);
  if (!effort) return undefined;
  const notify = await ctx.ui.confirm(
    "Notify parent session?",
    "Wake the parent with one completion summary?",
  );
  const tools = await ctx.ui.input(
    "Approved tools (comma-separated)",
    previous.kind === "isolated" ? previous.tools?.join(",") : "",
  );
  const skills = await ctx.ui.input(
    "Approved skills (comma-separated)",
    previous.kind === "isolated" ? previous.skills?.join(",") : "",
  );
  const extensions = await ctx.ui.input(
    "Approved extensions (comma-separated)",
    previous.kind === "isolated" ? previous.extensions?.join(",") : "",
  );
  return {
    kind: "isolated",
    model: selected,
    effort: effort as NonNullable<
      Extract<ExecutionDraft, { kind: "isolated" }>["effort"]
    >,
    notify,
    tools: csv(tools),
    skills: csv(skills),
    extensions: csv(extensions),
  };
}

async function collectLimits(
  ctx: ExtensionCommandContext,
  previous: LimitsDraft,
  isolated: boolean,
): Promise<LimitsDraft | undefined> {
  const expires = await ctx.ui.input("Expiry", previous.expires ?? "7d");
  if (expires === undefined) return undefined;
  const maxRuns = await ctx.ui.input(
    "Maximum runs (blank for unbounded)",
    previous.maxRuns?.toString() ?? "",
  );
  if (maxRuns === undefined) return undefined;
  const tokenBudget = await ctx.ui.input(
    "Token budget (blank for unbounded)",
    previous.tokenBudget?.toString() ?? "",
  );
  if (tokenBudget === undefined) return undefined;
  const timeout = isolated
    ? await ctx.ui.input("Isolated timeout", previous.timeout ?? "30m")
    : undefined;
  if (isolated && timeout === undefined) return undefined;
  if (expires) parseExpiry(expires, new Date());
  if (timeout) parseDuration(timeout);
  return {
    expires: expires || undefined,
    maxRuns: positiveOptional(maxRuns, "Maximum runs"),
    tokenBudget: positiveOptional(tokenBudget, "Token budget"),
    timeout: timeout || undefined,
  };
}

function parseExpiry(value: string, now: Date): string {
  if (/^[1-9]\d*(?:s|m|h|d)$/.test(value)) {
    return new Date(now.getTime() + parseDuration(value)).toISOString();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) {
    throw new Error("Expiry must be a future duration or timestamp");
  }
  return new Date(timestamp).toISOString();
}

function positiveOptional(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function csv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}
