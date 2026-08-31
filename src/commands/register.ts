import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  savedDraftFromJobDraft,
  savedPatchFromJobPatch,
} from "../core/saved-conversion.js";
import type { SavedCronService } from "../core/saved-service.js";
import type { Scheduler } from "../core/scheduler.js";
import type { CronService, JobDraft, JobPatch } from "../core/service.js";
import { selectJob } from "../domain/policy.js";
import type { SavedCronDefinition, SavedSchedule } from "../domain/saved.js";
import {
  describeSchedule,
  parseDuration,
  resolveSchedule,
} from "../domain/schedule.js";
import {
  type ApprovalMode,
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
  requireSavedService?(): SavedCronService;
  assertWritable?(): void;
  assertSavedMutationAllowed?(): void;
  startSaved?(selector: string, approvalMode?: ApprovalMode): Promise<CronJob>;
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
  overlap?: CronJob["overlap"];
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
    description:
      "Create and manage session jobs and project-saved cron definitions",
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
        "save add",
        "saved",
        "saved show",
        "saved edit",
        "saved delete",
        "start",
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
    case "saved_create": {
      runtime.assertSavedMutationAllowed?.();
      const now = new Date();
      const jobDraft = buildJobDraft(
        pi,
        ctx,
        fromCreateInput(intent.input),
        now,
      );
      const saved = await requireSavedService(runtime).create(
        savedDraftFromJobDraft(jobDraft, now),
      );
      notify(ctx, `Saved ${saved.name} (${saved.id}); it is stopped`);
      return;
    }
    case "saved_copy": {
      runtime.assertSavedMutationAllowed?.();
      const source = selectJobFromService(service, intent.selector);
      const saved = await requireSavedService(runtime).copy(
        source,
        intent.name,
      );
      notify(ctx, `Saved ${saved.name} (${saved.id}); it is stopped`);
      return;
    }
    case "saved_list":
      notify(
        ctx,
        formatSavedDefinitionList(await requireSavedService(runtime).list()),
      );
      return;
    case "saved_show": {
      const saved = await requireSavedService(runtime).select(intent.selector);
      notify(ctx, formatSavedDefinition(saved));
      return;
    }
    case "saved_edit": {
      runtime.assertSavedMutationAllowed?.();
      const savedService = requireSavedService(runtime);
      const current = await savedService.select(intent.selector);
      const now = new Date();
      const jobPatch = buildJobPatch(pi, ctx, intent.patch, now, undefined, {
        execution: current.execution,
      });
      const saved = await savedService.replace(
        current.id,
        savedPatchFromJobPatch(jobPatch, now),
      );
      notify(ctx, `Updated saved definition ${saved.name}`);
      return;
    }
    case "saved_delete": {
      runtime.assertSavedMutationAllowed?.();
      const savedService = requireSavedService(runtime);
      const saved = await savedService.select(intent.selector);
      await savedService.delete(saved.id);
      notify(ctx, `Deleted saved definition ${saved.name}`);
      return;
    }
    case "saved_start": {
      if (!runtime.startSaved) {
        throw new Error("Saved cron activation is unavailable");
      }
      const job = await runtime.startSaved(intent.selector, "interactive");
      notify(ctx, `Started ${job.name} (${job.id}) in this session`);
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
    overlap: input.overlap,
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
    overlap: input.overlap,
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
  current?: Pick<CronJob, "execution">,
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
  if (patch.overlap !== undefined) output.overlap = patch.overlap;
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
      const overlap = job.overlap ?? "queue";
      const skipped = job.skippedRuns ?? 0;
      const lastSkipped = job.lastSkippedAt ?? "never";
      return `${job.id}  ${job.state.padEnd(9)}  ${job.name}  ${describeSchedule(job.schedule)}  ${formatListExecution(job)}  overlap=${overlap}  runs=${job.runCount}  skipped=${skipped}  lastSkipped=${lastSkipped}  last=${last}  settled=${settled}`;
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

export function formatSavedDefinitionList(
  definitions: SavedCronDefinition[],
): string {
  if (definitions.length === 0) return "No saved cron definitions";
  return definitions
    .map(
      (definition) =>
        `${definition.id}  stopped  ${definition.name}  ${formatSavedSchedule(definition.schedule)}  ${formatSavedExecution(definition)}  overlap=${definition.overlap}  expiresAfter=${definition.expiresAfterMs}ms  maxRuns=${definition.maxRuns ?? "unbounded"}  budget=${definition.tokenBudget ?? "unbounded"}`,
    )
    .join("\n");
}

export function formatSavedDefinition(definition: SavedCronDefinition): string {
  return [
    `${definition.name} (${definition.id})`,
    "State: stopped (saved definition)",
    `Prompt: ${formatSavedPrompt(definition)}`,
    `Schedule: ${formatSavedSchedule(definition.schedule)}`,
    `Execution: ${formatSavedExecution(definition)}`,
    `Overlap: ${definition.overlap}`,
    `Expires after: ${definition.expiresAfterMs}ms`,
    `Maximum runs: ${definition.maxRuns ?? "unbounded"}`,
    `Token budget: ${definition.tokenBudget ?? "unbounded"}`,
  ].join("\n");
}

export function formatJob(job: CronJob): string {
  return [
    `${job.name} (${job.id})`,
    `State: ${job.state}`,
    `Schedule: ${describeSchedule(job.schedule)}`,
    `Execution: ${job.execution.kind}`,
    `Overlap: ${job.overlap ?? "queue"}`,
    `Runs: ${job.runCount}`,
    `Skipped: ${job.skippedRuns ?? 0}`,
    `Last skipped: ${job.lastSkippedAt ?? "never"}`,
    `Expires: ${job.expiresAt}`,
  ].join("\n");
}

function requireSavedService(runtime: CronRuntimeRef): SavedCronService {
  if (!runtime.requireSavedService) {
    throw new Error("Saved cron definitions are unavailable");
  }
  return runtime.requireSavedService();
}

function formatSavedSchedule(schedule: SavedSchedule): string {
  switch (schedule.kind) {
    case "interval":
      return `every ${schedule.intervalMs}ms`;
    case "cron":
      return `${schedule.expression} (${schedule.timezone})`;
    case "once":
      return schedule.timing.kind === "relative"
        ? `once after ${schedule.timing.delayMs}ms`
        : `once at ${schedule.timing.at}`;
    case "adaptive":
      return "adaptive";
    case "maintenance":
      return schedule.cadence === "adaptive"
        ? "maintenance (adaptive)"
        : `maintenance every ${schedule.cadence.intervalMs}ms`;
  }
}

function formatSavedExecution(definition: SavedCronDefinition): string {
  if (definition.execution.kind === "main")
    return "exec=main resources=inherited";
  const execution = definition.execution;
  return `exec=isolated model=${execution.model} effort=${execution.effort} tools=${execution.tools.join(",") || "none"} skills=${execution.skills.join(",") || "none"} extensions=${execution.extensions.join(",") || "none"} notify=${execution.notify ? "on" : "off"} timeout=${execution.timeoutMs}ms`;
}

function formatSavedPrompt(definition: SavedCronDefinition): string {
  const prompt = definition.prompt;
  if (prompt.kind === "text") return prompt.text;
  if (prompt.kind === "maintenance") return "maintenance";
  return `/${prompt.name}${prompt.args ? ` ${prompt.args}` : ""} (${prompt.source})`;
}

function notify(ctx: ExtensionContext, message: string): void {
  ctx.ui.notify(message, "info");
}
