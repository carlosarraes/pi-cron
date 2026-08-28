import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
  EditableDraft,
  ExecutionDraft,
  ScheduleInput,
} from "../commands/parse.js";
import {
  buildJobDraft,
  buildJobPatch,
  type CreationFields,
  type CronRuntimeRef,
  formatJob,
  formatJobList,
  selectJobFromService,
} from "../commands/register.js";
import { describeSchedule } from "../domain/schedule.js";
import type { CronJob } from "../domain/types.js";
import {
  type CronCreateInput,
  CronCreateParams,
  CronDeleteParams,
  CronListParams,
  CronRunParams,
  type CronUpdateInput,
  CronUpdateParams,
  CronWakeupParams,
} from "./schemas.js";

export function registerCronTools(
  pi: ExtensionAPI,
  runtime: CronRuntimeRef,
): void {
  pi.registerTool({
    name: "cron_create",
    label: "Cron Create",
    description:
      "Create one session-scoped cron job. Main mode is the default; isolated mode requires an explicit tools list.",
    promptSnippet:
      "Create a fixed, cron, one-shot, or adaptive scheduled prompt",
    promptGuidelines: [
      "Use cron_create only when the user clearly wants future or recurring work; the tool executes immediately without confirmation.",
      "Prefer main mode for cron_create unless the user explicitly requests isolation. Isolated jobs require an explicit tools list; skills do not grant tools. Use tools=[] only for text-only jobs.",
    ],
    parameters: CronCreateParams,
    async execute(_id, input, _signal, _update, ctx) {
      runtime.assertWritable?.();
      const draft = buildJobDraft(pi, ctx, creationFromTool(input));
      const job = await runtime.requireService().create(draft, {
        approvalMode: "automatic",
      });
      return toolResult(`Created ${job.name} (${job.id})`, job);
    },
    renderCall: (args, theme, context) =>
      renderMutationCall(
        `cron_create ${args.name ?? ""}`.trim(),
        args,
        "create",
        context.expanded,
        theme,
      ),
    renderResult: renderMutationResult,
  });

  pi.registerTool({
    name: "cron_list",
    label: "Cron List",
    description:
      "List session-scoped cron jobs, overlap policy, skip history, and runtime status.",
    promptSnippet:
      "List active, paused, missed, completed, and expired cron jobs",
    promptGuidelines: [
      "Use cron_list before updating or deleting a job when its exact ID is unknown, and to verify run count, last outcome, execution mode, tools, and notification behavior.",
    ],
    parameters: CronListParams,
    async execute() {
      const jobs = runtime.requireService().list();
      const scheduler = runtime.getScheduler();
      const statuses = Object.fromEntries(
        jobs.map((job) => [
          job.id,
          scheduler?.getRuntimeStatus(job.id) ?? { state: "idle" as const },
        ]),
      );
      const runtimeLines = jobs
        .filter((job) => statuses[job.id]?.state !== "idle")
        .map((job) => `${job.id} runtime=${statuses[job.id]?.state}`);
      return {
        content: [
          {
            type: "text" as const,
            text: [formatJobList(jobs), ...runtimeLines].join("\n"),
          },
        ],
        details: { action: "list", jobs, statuses },
      };
    },
    renderResult: renderCronResult,
  });

  pi.registerTool({
    name: "cron_update",
    label: "Cron Update",
    description: "Update, pause, or resume one cron job.",
    promptSnippet:
      "Update one cron job by exact ID, name, or unambiguous prefix",
    promptGuidelines: [
      "Use cron_update for configuration or state changes; the tool executes immediately without confirmation.",
      "When cron_update changes a main job to isolated mode, provide its complete tools list explicitly; skills do not grant tools.",
    ],
    parameters: CronUpdateParams,
    async execute(_id, input, _signal, _update, ctx) {
      runtime.assertWritable?.();
      const service = runtime.requireService();
      const current = selectJobFromService(service, input.selector);
      const editable = patchFromTool(input, current);
      if (input.timezone !== undefined && !hasSchedule(input)) {
        throw new Error("cron_update timezone requires a cron schedule change");
      }
      if (input.state !== undefined && Object.keys(editable).length > 0) {
        throw new Error(
          "cron_update state cannot be combined with configuration changes",
        );
      }
      let job: CronJob;
      if (input.state === "paused") {
        job = await service.pause(input.selector, "Paused by cron_update");
      } else if (input.state === "active") {
        job = await service.resume(input.selector);
      } else {
        const patch = buildJobPatch(
          pi,
          ctx,
          editable,
          new Date(),
          input.timezone,
          current,
        );
        if (Object.keys(patch).length === 0) {
          throw new Error("cron_update requires at least one field to change");
        }
        job = await service.replace(current.id, patch, {
          approvalMode: "automatic",
        });
      }
      return toolResult(`Updated ${job.name} (${job.id})`, job);
    },
    renderCall: (args, theme, context) =>
      renderMutationCall(
        `cron_update ${args.selector}`,
        args,
        "update",
        context.expanded,
        theme,
      ),
    renderResult: renderMutationResult,
  });

  pi.registerTool({
    name: "cron_delete",
    label: "Cron Delete",
    description: "Delete one session-scoped cron job.",
    promptSnippet: "Delete one cron job",
    promptGuidelines: [
      "Use cron_delete only after identifying the intended job.",
    ],
    parameters: CronDeleteParams,
    async execute(_id, input) {
      runtime.assertWritable?.();
      const service = runtime.requireService();
      const job = selectJobFromService(service, input.selector);
      await service.delete(job.id);
      return toolResult(`Deleted ${job.name}`, job);
    },
    renderCall: (args, theme) =>
      new Text(theme.fg("toolTitle", `cron_delete ${args.selector}`), 0, 0),
    renderResult: renderCronResult,
  });

  pi.registerTool({
    name: "cron_run",
    label: "Cron Run",
    description: "Queue one active cron job immediately.",
    promptSnippet: "Run one existing cron job now",
    promptGuidelines: [
      "Use cron_run to trigger an existing job without changing its cadence.",
    ],
    parameters: CronRunParams,
    async execute(_id, input) {
      runtime.assertWritable?.();
      const service = runtime.requireService();
      const job = selectJobFromService(service, input.selector);
      const scheduler = runtime.getScheduler();
      if (!scheduler)
        throw new Error("Cron scheduler is read-only in this process");
      await scheduler.runNow(job.id);
      return toolResult(`Queued ${job.name}`, job);
    },
    renderCall: (args, theme) =>
      new Text(theme.fg("toolTitle", `cron_run ${args.selector}`), 0, 0),
    renderResult: renderCronResult,
  });

  pi.registerTool({
    name: "cron_wakeup",
    label: "Cron Wakeup",
    description:
      "Choose the next wakeup or stop the currently executing adaptive job.",
    promptSnippet: "Set the next delay for the active adaptive cron run",
    promptGuidelines: [
      "Every adaptive cron run must call cron_wakeup exactly once with delay or stop=true.",
    ],
    parameters: CronWakeupParams,
    async execute(_id, input) {
      const executor = runtime.getMainExecutor();
      if (!executor)
        throw new Error("cron_wakeup is unavailable outside main execution");
      await executor.applyWakeup(input);
      return {
        content: [
          {
            type: "text" as const,
            text: input.stop
              ? "Adaptive job stopped."
              : `Next wakeup set to ${input.delay}.`,
          },
        ],
        details: { action: "wakeup", ...input },
      };
    },
    renderResult: renderCronResult,
  });
}

function creationFromTool(input: CronCreateInput): CreationFields {
  return {
    name: input.name,
    prompt: input.prompt,
    schedule: scheduleFromTool(input),
    timezone: input.timezone,
    execution: executionFromTool(input),
    overlap: input.overlap,
    expires: input.expires,
    maxRuns: input.maxRuns,
    tokenBudget: input.tokenBudget,
    unsafeSeconds: input.unsafeSeconds,
  };
}

function patchFromTool(
  input: CronUpdateInput,
  current: CronJob,
): EditableDraft {
  const patch: EditableDraft = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.prompt !== undefined) patch.prompt = input.prompt;
  if (hasSchedule(input)) patch.schedule = scheduleFromTool(input);
  const hasExecution =
    input.mode !== undefined ||
    input.model !== undefined ||
    input.effort !== undefined ||
    input.notify !== undefined ||
    input.timeout !== undefined ||
    input.tools !== undefined ||
    input.skills !== undefined ||
    input.extensions !== undefined;
  if (hasExecution) {
    patch.execution = executionFromTool(
      input,
      true,
      current.execution.kind === "isolated",
    );
  }
  if (input.overlap !== undefined) patch.overlap = input.overlap;
  if (input.expires !== undefined) patch.expires = input.expires;
  if (input.maxRuns !== undefined) patch.maxRuns = input.maxRuns;
  if (input.tokenBudget !== undefined) patch.tokenBudget = input.tokenBudget;
  if (input.unsafeSeconds !== undefined)
    patch.unsafeSeconds = input.unsafeSeconds ? true : undefined;
  return patch;
}

function scheduleFromTool(input: {
  every?: string;
  cron?: string;
  in?: string;
  at?: string;
  adaptive?: boolean;
}): ScheduleInput {
  const selected = [
    input.every !== undefined &&
      ({ kind: "interval", value: input.every } as const),
    input.cron !== undefined && ({ kind: "cron", value: input.cron } as const),
    input.in !== undefined && ({ kind: "in", value: input.in } as const),
    input.at !== undefined && ({ kind: "at", value: input.at } as const),
    input.adaptive === true && ({ kind: "adaptive" } as const),
  ].filter((value): value is ScheduleInput => value !== false);
  if (selected.length !== 1) {
    throw new Error(
      "Choose exactly one schedule: every, cron, in, at, or adaptive=true",
    );
  }
  return selected[0] as ScheduleInput;
}

function hasSchedule(input: {
  every?: string;
  cron?: string;
  in?: string;
  at?: string;
  adaptive?: boolean;
}): boolean {
  return (
    input.every !== undefined ||
    input.cron !== undefined ||
    input.in !== undefined ||
    input.at !== undefined ||
    input.adaptive === true
  );
}

function executionFromTool(
  input: {
    mode?: "main" | "isolated";
    model?: string;
    effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    notify?: boolean;
    timeout?: string;
    tools?: string[];
    skills?: string[];
    extensions?: string[];
  },
  update = false,
  hasIsolatedBaseline = false,
): ExecutionDraft {
  const isolated =
    input.mode === "isolated" ||
    input.model !== undefined ||
    input.effort !== undefined ||
    (update ? input.notify !== undefined : input.notify === true) ||
    input.timeout !== undefined ||
    input.tools !== undefined ||
    input.skills !== undefined ||
    input.extensions !== undefined;
  if (!isolated) return { kind: "main" };
  if (input.mode === "main") {
    throw new Error(
      "Isolated model, effort, notify, timeout, and resources require mode=isolated",
    );
  }
  if (input.tools === undefined && !hasIsolatedBaseline) {
    throw new Error(
      "Isolated cron jobs require explicit tools; pass tools=[...] or tools=[] for a text-only job",
    );
  }
  return {
    kind: "isolated",
    model: input.model,
    effort: input.effort,
    notify: input.notify,
    timeout: input.timeout,
    tools: input.tools,
    skills: input.skills,
    extensions: input.extensions,
  };
}

function toolResult(text: string, job: CronJob) {
  return {
    content: [{ type: "text" as const, text: `${text}\n${formatJob(job)}` }],
    details: { action: "job", job },
  };
}

type MutationInput = Partial<CronCreateInput & CronUpdateInput>;

function renderMutationCall(
  title: string,
  args: MutationInput,
  kind: "create" | "update",
  expanded: boolean,
  theme: { fg(color: string, value: string): string },
): Text {
  const compact = `${title} · ${formatMutationInput(args, kind)}`;
  if (!expanded) return new Text(theme.fg("toolTitle", compact), 0, 0);
  const details = JSON.stringify(args, null, 2) ?? "";
  const text = `${theme.fg("toolTitle", compact)}\n${theme.fg("muted", details)}`;
  return new Text(text, 0, 0);
}

function formatMutationInput(
  input: MutationInput,
  kind: "create" | "update",
): string {
  const overlap = input.overlap ?? (kind === "create" ? "queue" : "unchanged");
  const parts = [formatInputSchedule(input, kind), `overlap ${overlap}`];
  const changesExecution =
    input.mode !== undefined ||
    input.model !== undefined ||
    input.effort !== undefined ||
    input.notify !== undefined ||
    input.timeout !== undefined ||
    input.tools !== undefined ||
    input.skills !== undefined ||
    input.extensions !== undefined;
  if (kind === "update" && !changesExecution) {
    parts.push("mode unchanged", "tools unchanged", "notify unchanged");
    return parts.join(" · ");
  }

  const isolated =
    input.mode === "isolated" ||
    input.model !== undefined ||
    input.effort !== undefined ||
    (kind === "update" ? input.notify !== undefined : input.notify === true) ||
    input.timeout !== undefined ||
    input.tools !== undefined ||
    input.skills !== undefined ||
    input.extensions !== undefined;
  parts.push(isolated ? "isolated" : "main");
  if (!isolated) {
    parts.push("tools inherited", "notify n/a");
  } else {
    let tools = "tools unchanged";
    if (input.tools !== undefined) {
      tools = `tools ${input.tools.join(",") || "none"}`;
    } else if (kind === "create") {
      tools = "tools omitted";
    }
    parts.push(tools);

    const keepsNotify = input.notify === undefined && kind === "update";
    const notify = keepsNotify
      ? "notify unchanged"
      : `notify ${input.notify === true ? "on" : "off"}`;
    parts.push(notify);
  }
  return parts.join(" · ");
}

function formatInputSchedule(
  input: MutationInput,
  kind: "create" | "update",
): string {
  if (input.every !== undefined) return `every ${input.every}`;
  if (input.cron !== undefined) return `cron ${input.cron}`;
  if (input.in !== undefined) return `in ${input.in}`;
  if (input.at !== undefined) return `at ${input.at}`;
  if (input.adaptive === true) return "adaptive";
  return kind === "create" ? "schedule missing" : "schedule unchanged";
}

function renderMutationResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: { job?: CronJob };
  },
  options: { expanded: boolean },
  theme: { fg(color: string, value: string): string },
): Text {
  const first = result.content[0];
  const fullText = first?.type === "text" ? (first.text ?? "") : "";
  if (options.expanded) return new Text(theme.fg("muted", fullText), 0, 0);

  const firstLine = fullText.split("\n")[0] ?? "";
  const job = result.details?.job;
  const text = job
    ? `${firstLine} · ${formatJobConfiguration(job)}`
    : firstLine;
  return new Text(theme.fg("muted", text), 0, 0);
}

function formatJobConfiguration(job: CronJob): string {
  const parts = [
    describeSchedule(job.schedule),
    `overlap ${job.overlap ?? "queue"}`,
    job.execution.kind,
  ];
  if (job.execution.kind === "main") {
    parts.push("tools inherited", "notify n/a");
  } else {
    parts.push(`tools ${job.execution.tools.join(",") || "none"}`);
    parts.push(`notify ${job.execution.notify ? "on" : "off"}`);
  }
  return parts.join(" · ");
}

function renderCronResult(
  result: { content: Array<{ type: string; text?: string }> },
  _options: unknown,
  theme: { fg(color: string, value: string): string },
) {
  const first = result.content[0];
  const text = first?.type === "text" ? (first.text ?? "") : "";
  return new Text(theme.fg("muted", text), 0, 0);
}
