import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Scheduler } from "../core/scheduler.js";
import type { CronService, JobDraft, JobPatch } from "../core/service.js";
import { selectJob } from "../domain/policy.js";
import {
  describeSchedule,
  parseDuration,
  resolveSchedule,
} from "../domain/schedule.js";
import {
  type CronJob,
  DEFAULT_LIMITS,
  type ExecutionMode,
} from "../domain/types.js";
import type { MainExecutor } from "../execution/main-executor.js";
import {
  type CreateInput,
  type EditableDraft,
  type ExecutionDraft,
  parseCronCommand,
  type ScheduleInput,
} from "./parse.js";

export interface CronRuntimeRef {
  requireService(): CronService;
  assertWritable?(): void;
  getScheduler(): Pick<Scheduler, "runNow" | "getRuntimeStatus"> | undefined;
  getMainExecutor(): Pick<MainExecutor, "applyWakeup"> | undefined;
  runManager(ctx: ExtensionCommandContext): Promise<void>;
  runWizard(
    ctx: ExtensionCommandContext,
    seed?: unknown,
  ): Promise<JobDraft | undefined>;
  stopAll(): Promise<void>;
}

export interface CreationFields {
  name?: string;
  prompt: string;
  schedule: ScheduleInput;
  timezone?: string;
  execution?: ExecutionDraft;
  expires?: string;
  maxRuns?: number;
  tokenBudget?: number;
  unsafeSeconds?: boolean;
}

export function registerCronCommand(
  pi: ExtensionAPI,
  runtime: CronRuntimeRef,
): void {
  pi.registerCommand("cron", {
    description: "Create and manage session-scoped scheduled prompts",
    getArgumentCompletions: (prefix) =>
      [
        "add",
        "list",
        "show",
        "pause",
        "resume",
        "run",
        "edit",
        "delete",
        "stop --all",
      ]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    async handler(args, ctx) {
      await dispatchCronIntent(pi, runtime, parseCronCommand(args), ctx);
    },
  });
}

async function dispatchCronIntent(
  pi: ExtensionAPI,
  runtime: CronRuntimeRef,
  intent: ReturnType<typeof parseCronCommand>,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const service = runtime.requireService();
  switch (intent.kind) {
    case "manager":
      await runtime.runManager(ctx);
      return;
    case "guided_add": {
      runtime.assertWritable?.();
      const draft = await runtime.runWizard(ctx);
      if (!draft) return;
      const created = await service.create(draft);
      notify(ctx, `Created ${created.name} (${created.id})`);
      return;
    }
    case "maintenance": {
      runtime.assertWritable?.();
      const now = new Date();
      const schedule = intent.interval
        ? resolveSchedule({ kind: "interval", value: intent.interval }, now)
        : {
            kind: "maintenance" as const,
            cadence: "adaptive" as const,
          };
      const created = await service.create({
        name: "Maintenance",
        prompt: { kind: "maintenance" },
        schedule,
        execution: { kind: "main" },
      });
      notify(ctx, `Created ${created.name} (${created.id})`);
      return;
    }
    case "create": {
      runtime.assertWritable?.();
      const draft = buildJobDraft(pi, ctx, fromCreateInput(intent.input));
      const created = await service.create(draft);
      notify(ctx, `Created ${created.name} (${created.id})`);
      return;
    }
    case "list":
      notify(ctx, formatJobList(service.list()));
      return;
    case "show": {
      const job = selectJobFromService(service, intent.selector);
      notify(ctx, formatJob(job));
      return;
    }
    case "pause": {
      runtime.assertWritable?.();
      const job = await service.pause(intent.selector, "Paused by user");
      notify(ctx, `Paused ${job.name}`);
      return;
    }
    case "resume": {
      runtime.assertWritable?.();
      const job = await service.resume(intent.selector);
      notify(ctx, `Resumed ${job.name}`);
      return;
    }
    case "run": {
      runtime.assertWritable?.();
      const job = selectJobFromService(service, intent.selector);
      const scheduler = runtime.getScheduler();
      if (!scheduler)
        throw new Error("Cron scheduler is read-only in this process");
      await scheduler.runNow(job.id);
      notify(ctx, `Queued ${job.name}`);
      return;
    }
    case "delete": {
      runtime.assertWritable?.();
      const job = selectJobFromService(service, intent.selector);
      await service.delete(job.id);
      notify(ctx, `Deleted ${job.name}`);
      return;
    }
    case "edit": {
      runtime.assertWritable?.();
      const current = selectJobFromService(service, intent.selector);
      const patch = buildJobPatch(
        pi,
        ctx,
        intent.patch,
        new Date(),
        undefined,
        current,
      );
      const job = await service.replace(current.id, patch);
      notify(ctx, `Updated ${job.name}`);
      return;
    }
    case "stop_all":
      runtime.assertWritable?.();
      for (const job of service
        .list()
        .filter((candidate) => candidate.state === "active")) {
        await service.pause(job.id, "Stopped by /cron stop --all");
      }
      await runtime.stopAll();
      notify(ctx, "Stopped all cron jobs");
  }
}

function fromCreateInput(input: CreateInput): CreationFields {
  return {
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    execution: input.execution,
    expires: input.expires,
    maxRuns: input.maxRuns,
    tokenBudget: input.tokenBudget,
    unsafeSeconds: input.unsafeSeconds,
  };
}

export function buildJobDraft(
  pi: Pick<ExtensionAPI, "getCommands" | "getThinkingLevel">,
  ctx: Pick<ExtensionContext, "model">,
  input: CreationFields,
  now = new Date(),
): JobDraft {
  const unsafeSeconds = input.unsafeSeconds === true;
  return {
    name: input.name,
    prompt: resolvePrompt(pi, input.prompt),
    schedule: resolveSchedule(
      input.schedule,
      now,
      unsafeSeconds,
      input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    execution: resolveExecution(pi, ctx, input.execution),
    expiresAt: resolveExpiry(input.expires, now),
    maxRuns: input.maxRuns,
    tokenBudget: input.tokenBudget,
    unsafeSeconds,
  };
}

export function buildJobPatch(
  pi: Pick<ExtensionAPI, "getCommands" | "getThinkingLevel">,
  ctx: Pick<ExtensionContext, "model">,
  patch: EditableDraft,
  now = new Date(),
  timezone?: string,
  current?: CronJob,
): JobPatch {
  const output: JobPatch = {};
  if (patch.name !== undefined) output.name = patch.name;
  if (patch.prompt !== undefined)
    output.prompt = resolvePrompt(pi, patch.prompt);
  if (patch.schedule !== undefined) {
    output.schedule = resolveSchedule(
      patch.schedule,
      now,
      patch.unsafeSeconds === true,
      timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  }
  if (patch.execution !== undefined) {
    output.execution = resolveExecution(
      pi,
      ctx,
      patch.execution,
      current?.execution,
    );
  }
  if (patch.expires !== undefined)
    output.expiresAt = resolveExpiry(patch.expires, now);
  if (patch.maxRuns !== undefined) output.maxRuns = patch.maxRuns;
  if (patch.tokenBudget !== undefined) output.tokenBudget = patch.tokenBudget;
  if (patch.unsafeSeconds !== undefined)
    output.unsafeSeconds = patch.unsafeSeconds;
  return output;
}

function resolvePrompt(
  pi: Pick<ExtensionAPI, "getCommands">,
  prompt: string,
): CronJob["prompt"] {
  const match = prompt.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return { kind: "text", text: prompt };
  const name = match[1] as string;
  const command = pi.getCommands().find((candidate) => candidate.name === name);
  if (!command || (command.source !== "skill" && command.source !== "prompt")) {
    throw new Error(
      `Scheduled command /${name} must be a loaded skill or prompt template`,
    );
  }
  return {
    kind: "command",
    name,
    args: match[2] ?? "",
    source: command.source,
  };
}

export function resolveExecution(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  ctx: Pick<ExtensionContext, "model">,
  execution: ExecutionDraft | undefined,
  current?: ExecutionMode,
): ExecutionMode {
  if (!execution || execution.kind === "main") return { kind: "main" };
  const baseline = current?.kind === "isolated" ? current : undefined;
  const model =
    execution.model ??
    baseline?.model ??
    (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  if (!model) throw new Error("Isolated execution requires an available model");
  return {
    kind: "isolated",
    model,
    effort: execution.effort ?? baseline?.effort ?? pi.getThinkingLevel(),
    tools: [...(execution.tools ?? baseline?.tools ?? [])],
    skills: [...(execution.skills ?? baseline?.skills ?? [])],
    extensions: [...(execution.extensions ?? baseline?.extensions ?? [])],
    notify: execution.notify ?? baseline?.notify ?? false,
    timeoutMs: execution.timeout
      ? parseDuration(execution.timeout)
      : (baseline?.timeoutMs ?? DEFAULT_LIMITS.isolatedTimeoutMs),
  };
}

function resolveExpiry(
  value: string | undefined,
  now: Date,
): string | undefined {
  if (!value) return undefined;
  if (/^[1-9]\d*(?:s|m|h|d)$/.test(value)) {
    return new Date(now.getTime() + parseDuration(value)).toISOString();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid expiry '${value}'`);
  return new Date(parsed).toISOString();
}

export function selectJobFromService(
  service: CronService,
  selector: string,
): CronJob {
  return selectJob(service.list(), selector);
}

export function formatJobList(jobs: CronJob[]): string {
  if (jobs.length === 0) return "No cron jobs";
  return jobs
    .map((job) => {
      const last = job.lastTechnicalOutcome ?? "never";
      const settled = job.lastSettledAt ?? "never";
      return `${job.id}  ${job.state.padEnd(9)}  ${job.name}  ${describeSchedule(job.schedule)}  ${formatListExecution(job)}  runs=${job.runCount}  last=${last}  settled=${settled}`;
    })
    .join("\n");
}

function formatListExecution(job: CronJob): string {
  if (job.execution.kind === "main") {
    return "exec=main  resources=inherited  notify=n/a";
  }
  const tools = job.execution.tools.join(",") || "none";
  const skills = job.execution.skills.join(",") || "none";
  const extensions = job.execution.extensions.join(",") || "none";
  const notify = job.execution.notify ? "on" : "off";
  return `exec=isolated  model=${job.execution.model}  effort=${job.execution.effort}  tools=${tools}  skills=${skills}  extensions=${extensions}  notify=${notify}  timeout=${job.execution.timeoutMs}ms`;
}

export function formatJob(job: CronJob): string {
  return [
    `${job.name} (${job.id})`,
    `State: ${job.state}`,
    `Schedule: ${describeSchedule(job.schedule)}`,
    `Execution: ${job.execution.kind}`,
    `Runs: ${job.runCount}`,
    `Expires: ${job.expiresAt}`,
  ].join("\n");
}

function notify(ctx: ExtensionContext, message: string): void {
  ctx.ui.notify(message, "info");
}
