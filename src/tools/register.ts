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
    description: "Create one approved session-scoped cron job.",
    promptSnippet:
      "Create a fixed, cron, one-shot, or adaptive scheduled prompt",
    promptGuidelines: [
      "Use cron_create only when the user wants future or recurring work; creation requires interactive approval.",
    ],
    parameters: CronCreateParams,
    async execute(_id, input, _signal, _update, ctx) {
      runtime.assertWritable?.();
      const draft = buildJobDraft(pi, ctx, creationFromTool(input));
      const job = await runtime.requireService().create(draft);
      return toolResult(`Created ${job.name} (${job.id})`, job);
    },
    renderCall: (args, theme) =>
      new Text(
        theme.fg("toolTitle", `cron_create ${args.name ?? ""}`.trim()),
        0,
        0,
      ),
    renderResult: renderCronResult,
  });

  pi.registerTool({
    name: "cron_list",
    label: "Cron List",
    description: "List session-scoped cron jobs and runtime status.",
    promptSnippet:
      "List active, paused, missed, completed, and expired cron jobs",
    promptGuidelines: [
      "Use cron_list before updating or deleting a job when its exact ID is unknown.",
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
      "Use cron_update for configuration or state changes; privilege increases require approval.",
    ],
    parameters: CronUpdateParams,
    async execute(_id, input, _signal, _update, ctx) {
      runtime.assertWritable?.();
      const service = runtime.requireService();
      const editable = patchFromTool(input);
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
        const current = selectJobFromService(service, input.selector);
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
        job = await service.replace(current.id, patch);
      }
      return toolResult(
        `Updated ${job.name}: ${describeSchedule(job.schedule)}`,
        job,
      );
    },
    renderCall: (args, theme) =>
      new Text(theme.fg("toolTitle", `cron_update ${args.selector}`), 0, 0),
    renderResult: renderCronResult,
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
    expires: input.expires,
    maxRuns: input.maxRuns,
    tokenBudget: input.tokenBudget,
    unsafeSeconds: input.unsafeSeconds,
  };
}

function patchFromTool(input: CronUpdateInput): EditableDraft {
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
  if (hasExecution) patch.execution = executionFromTool(input, true);
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

function renderCronResult(
  result: { content: Array<{ type: string; text?: string }> },
  _options: unknown,
  theme: { fg(color: string, value: string): string },
) {
  const first = result.content[0];
  const text = first?.type === "text" ? (first.text ?? "") : "";
  return new Text(theme.fg("muted", text), 0, 0);
}
