import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  type ExecutionDraft,
  parseCronCommand,
  type ScheduleInput,
} from "./commands/parse.js";
import type { CronRuntimeRef } from "./commands/register.js";
import { PiEventStore } from "./core/event-store.js";
import { type LeaseRecord, RuntimeLease } from "./core/lease.js";
import { Scheduler } from "./core/scheduler.js";
import { CronService, type JobDraft } from "./core/service.js";
import { selectJob } from "./domain/policy.js";
import type {
  Clock,
  CronJob,
  Dispatcher,
  DispatchResult,
} from "./domain/types.js";
import { makeJobId } from "./domain/types.js";
import { IsolatedExecutor } from "./execution/isolated-executor.js";
import { MainExecutor } from "./execution/main-executor.js";
import { PromptResolver } from "./execution/prompt-resolver.js";
import { UiApprovalPort } from "./ui/approval.js";
import { runCronManager } from "./ui/manager.js";
import { updateCronStatus } from "./ui/status.js";
import { runCronWizard, type WizardState } from "./ui/wizard.js";

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  setTimeout(fn: () => void, ms: number): unknown {
    return setTimeout(fn, ms);
  }
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}

interface LeasePort {
  acquire(
    sessionId: string,
  ): Promise<{ owned: true } | { owned: false; owner: LeaseRecord }>;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface CronRuntimeDependencies {
  clock?: Clock;
  leaseFactory?: () => LeasePort;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class CronRuntime implements CronRuntimeRef {
  private readonly pi: ExtensionAPI;
  private readonly clock: Clock;
  private readonly leaseFactory: () => LeasePort;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private service: CronService | undefined;
  private scheduler: Scheduler | undefined;
  private mainExecutor: MainExecutor | undefined;
  private isolatedExecutor: IsolatedExecutor | undefined;
  private promptResolver: PromptResolver | undefined;
  private lease: LeasePort | undefined;
  private heartbeatHandle: unknown;
  private ctx: ExtensionContext | undefined;
  private readOnlyOwner: LeaseRecord | undefined;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(pi: ExtensionAPI, dependencies: CronRuntimeDependencies = {}) {
    this.pi = pi;
    this.clock = dependencies.clock ?? new SystemClock();
    this.leaseFactory = dependencies.leaseFactory ?? (() => new RuntimeLease());
    this.setIntervalFn =
      dependencies.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      dependencies.clearInterval ??
      ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  start(
    ctx: ExtensionContext,
    reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
  ): Promise<void> {
    return this.serialize(async () => {
      await this.stopInternal();
      this.ctx = ctx;
      const store = new PiEventStore(this.pi, ctx.sessionManager);
      this.service = new CronService({
        events: store.load(),
        store,
        approvals: new UiApprovalPort(ctx, () => this.clock.now()),
        clock: this.clock,
        sessionId: ctx.sessionManager.getSessionId(),
        idFactory: () => makeJobId(),
        onChanged: () => this.refreshUi(),
        onObserverError: (error) => this.notifyError(error),
      });
      this.lease = this.leaseFactory();
      const acquired = await this.lease.acquire(
        ctx.sessionManager.getSessionId(),
      );
      this.readOnlyOwner = acquired.owned ? undefined : acquired.owner;
      if (acquired.owned) {
        await this.classifyResume(reason);
        this.buildExecutors(ctx);
        this.scheduler?.start();
        this.heartbeatHandle = this.setIntervalFn(() => {
          void this.heartbeat().catch((error) => this.loseLease(error));
        }, 30_000);
      }
      this.refreshUi();
    });
  }

  stop(ctx?: ExtensionContext): Promise<void> {
    return this.serialize(async () => {
      await this.stopInternal();
      (ctx ?? this.ctx)?.ui.setStatus("pi-cron", undefined);
    });
  }

  onAgentSettled(ctx?: ExtensionContext): Promise<void> {
    return this.serialize(async () => {
      await this.mainExecutor?.settle();
      await this.scheduler?.onAgentSettled();
      if (ctx) this.ctx = ctx;
      this.refreshUi();
    });
  }

  requireService(): CronService {
    if (!this.service) throw new Error("Cron runtime is not started");
    return this.service;
  }

  getScheduler(): Scheduler | undefined {
    return this.scheduler;
  }

  getMainExecutor(): MainExecutor | undefined {
    return this.mainExecutor;
  }

  async runWizard(
    ctx: ExtensionCommandContext,
    seed?: Partial<WizardState>,
  ): Promise<JobDraft | undefined> {
    return runCronWizard(ctx, seed);
  }

  async runManager(ctx: ExtensionCommandContext): Promise<void> {
    const service = this.requireService();
    await runCronManager(ctx, {
      readOnlyOwner: this.readOnlyOwner,
      now: () => this.clock.now(),
      actions: {
        jobs: () => service.list(),
        runtimeStatus: (jobId) =>
          this.scheduler?.getRuntimeStatus(jobId) ?? { state: "idle" },
        add: async () => {
          this.requireWritable();
          const draft = await this.runWizard(ctx);
          if (draft) await service.create(draft);
        },
        togglePause: async (jobId) => {
          this.requireWritable();
          const job = service.get(jobId);
          if (!job) throw new Error(`Cron job '${jobId}' not found`);
          if (job.state === "paused") await service.resume(jobId);
          else await service.pause(jobId, "Paused from cron manager");
        },
        runNow: async (jobId) => {
          this.requireWritable();
          await this.scheduler?.runNow(jobId);
        },
        edit: async (jobId) => {
          this.requireWritable();
          const current = service.get(jobId);
          if (!current) throw new Error(`Cron job '${jobId}' not found`);
          const draft = await this.runWizard(ctx, seedFromJob(current));
          if (draft) await service.replace(jobId, draft);
        },
        remove: async (jobId) => {
          this.requireWritable();
          const current = service.get(jobId);
          if (!current) return;
          const confirmed = await ctx.ui.confirm(
            "Delete cron job?",
            `${current.name} (${current.id})`,
          );
          if (confirmed) await service.delete(jobId);
        },
        command: async (value) => this.dispatchManagerCommand(value, ctx),
        onError: (error) => this.notifyError(error),
      },
    });
  }

  assertWritable(): void {
    this.requireWritable();
  }

  async stopAll(): Promise<void> {
    const scheduler = this.scheduler;
    const hadIsolatedRun = !(this.isolatedExecutor?.isIdle() ?? true);
    scheduler?.stop();
    await this.isolatedExecutor?.abortAll();
    if (hadIsolatedRun) await scheduler?.waitForIdle();
    if (this.ctx && this.promptResolver && this.service) {
      this.isolatedExecutor = this.createIsolatedExecutor(
        this.ctx,
        this.service,
        this.promptResolver,
      );
    }
    scheduler?.start();
    this.refreshUi();
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(operation, operation);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private async stopInternal(): Promise<void> {
    if (this.heartbeatHandle !== undefined) {
      this.clearIntervalFn(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }
    const scheduler = this.scheduler;
    const isolated = this.isolatedExecutor;
    const service = this.service;
    const lease = this.lease;
    let firstError: unknown;
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };

    scheduler?.stop();
    try {
      this.mainExecutor?.abortPending("session shutdown");
    } catch (error) {
      firstError ??= error;
    }
    await attempt(async () => isolated?.abortAll());
    await attempt(async () => scheduler?.waitForIdle());
    await attempt(async () => service?.flushCheckpoint());
    await attempt(async () => lease?.release());
    this.ctx?.ui.setStatus("pi-cron", undefined);
    this.scheduler = undefined;
    this.mainExecutor = undefined;
    this.isolatedExecutor = undefined;
    this.promptResolver = undefined;
    this.service = undefined;
    this.lease = undefined;
    this.ctx = undefined;
    this.readOnlyOwner = undefined;
    if (firstError) throw firstError;
  }

  private buildExecutors(ctx: ExtensionContext): void {
    const service = this.requireService();
    const resolver = new PromptResolver({
      pi: this.pi,
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      isProjectTrusted: () => ctx.isProjectTrusted(),
    });
    this.promptResolver = resolver;
    this.mainExecutor = new MainExecutor({
      pi: this.pi,
      service,
      resolver,
      clock: this.clock,
      readUsage: () => ctx.getContextUsage()?.tokens ?? 0,
    });
    this.isolatedExecutor = this.createIsolatedExecutor(ctx, service, resolver);
    const dispatcher: Dispatcher = {
      isIdle: () =>
        ctx.isIdle() &&
        (this.mainExecutor?.isIdle() ?? true) &&
        (this.isolatedExecutor?.isIdle() ?? true),
      execute: (job, scheduledAt) => this.executeJob(job, scheduledAt),
    };
    this.scheduler = new Scheduler({
      service,
      dispatcher,
      clock: this.clock,
      onError: (error) => this.notifyError(error),
    });
  }

  private createIsolatedExecutor(
    ctx: ExtensionContext,
    service: CronService,
    resolver: PromptResolver,
  ): IsolatedExecutor {
    return new IsolatedExecutor({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      modelRegistry: ctx.modelRegistry,
      pi: this.pi,
      service,
      resolver,
      now: () => this.clock.now(),
    });
  }

  private executeJob(job: CronJob, scheduledAt: Date): Promise<DispatchResult> {
    if (job.execution.kind === "main") {
      if (!this.mainExecutor) throw new Error("Main cron executor unavailable");
      return this.mainExecutor.execute(job, scheduledAt);
    }
    if (!this.isolatedExecutor) {
      throw new Error("Isolated cron executor unavailable");
    }
    return this.isolatedExecutor.execute(job, scheduledAt);
  }

  private async classifyResume(
    reason: "startup" | "reload" | "new" | "resume" | "fork",
  ): Promise<void> {
    const service = this.requireService();
    const sessionId = this.ctx?.sessionManager.getSessionId();
    const now = this.clock.now().getTime();
    for (const job of service.list()) {
      if (job.state !== "active") continue;
      if (reason === "fork" && job.originSessionId !== sessionId) {
        await service.transitionState(
          job.id,
          "paused",
          "Inherited into a fork; resume explicitly",
        );
      } else if (Date.parse(job.expiresAt) <= now) {
        await service.transitionState(job.id, "expired", "Job expired");
      } else if (job.maxRuns !== undefined && job.runCount >= job.maxRuns) {
        await service.transitionState(
          job.id,
          "completed",
          "Maximum runs reached",
        );
      } else if (
        job.tokenBudget !== undefined &&
        job.attributedTokens >= job.tokenBudget
      ) {
        await service.transitionState(
          job.id,
          "completed",
          "Token budget reached",
        );
      } else if (
        job.schedule.kind === "once" &&
        Date.parse(job.schedule.at) <= now &&
        job.runCount === 0
      ) {
        await service.transitionState(
          job.id,
          "missed",
          "One-shot occurrence passed while Pi was not running",
        );
      }
    }
  }

  private async heartbeat(): Promise<void> {
    await this.lease?.heartbeat();
  }

  private loseLease(error: unknown): void {
    if (this.heartbeatHandle !== undefined) {
      this.clearIntervalFn(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }
    this.scheduler?.stop();
    this.scheduler = undefined;
    this.mainExecutor?.abortPending("runtime lease ownership lost");
    void this.isolatedExecutor?.abortAll();
    this.notifyError(error);
    this.refreshUi();
  }

  private refreshUi(): void {
    if (!this.ctx || !this.service) return;
    this.scheduler?.refresh();
    updateCronStatus(this.ctx, this.service, this.scheduler, this.clock.now());
  }

  private notifyError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.ctx?.ui.notify(`pi-cron: ${message}`, "error");
  }

  private requireWritable(): void {
    if (this.readOnlyOwner || !this.scheduler) {
      throw new Error("Cron scheduler is read-only in this process");
    }
  }

  private async dispatchManagerCommand(
    value: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const service = this.requireService();
    const intent = parseCronCommand(value);
    switch (intent.kind) {
      case "guided_add": {
        const draft = await this.runWizard(ctx);
        if (draft) await service.create(draft);
        return;
      }
      case "pause":
        await service.pause(intent.selector, "Paused from cron manager");
        return;
      case "resume":
        await service.resume(intent.selector);
        return;
      case "run": {
        const job = selectJob(service.list(), intent.selector);
        await this.scheduler?.runNow(job.id);
        return;
      }
      case "delete":
        await service.delete(intent.selector);
        return;
      default:
        throw new Error(
          "Manager command supports add, pause, resume, run, and delete",
        );
    }
  }
}

function seedFromJob(job: CronJob): Partial<WizardState> {
  return {
    schedule: scheduleInputFromJob(job),
    prompt:
      job.prompt.kind === "text"
        ? job.prompt.text
        : job.prompt.kind === "maintenance"
          ? ""
          : `/${job.prompt.name}${job.prompt.args ? ` ${job.prompt.args}` : ""}`,
    execution: executionDraftFromJob(job),
    overlap: job.overlap ?? "queue",
    limits: {
      expires: job.expiresAt,
      maxRuns: job.maxRuns,
      tokenBudget: job.tokenBudget,
      timeout:
        job.execution.kind === "isolated"
          ? `${Math.ceil(job.execution.timeoutMs / 60_000)}m`
          : undefined,
    },
  };
}

function scheduleInputFromJob(job: CronJob): ScheduleInput {
  switch (job.schedule.kind) {
    case "interval":
      return {
        kind: "interval",
        value: `${job.schedule.intervalMs / 60_000}m`,
      };
    case "cron":
      return { kind: "cron", value: job.schedule.expression };
    case "once":
      return { kind: "at", value: job.schedule.at };
    case "adaptive":
      return { kind: "adaptive" };
    case "maintenance":
      return job.schedule.cadence === "adaptive"
        ? { kind: "adaptive" }
        : {
            kind: "interval",
            value: `${job.schedule.cadence.intervalMs / 60_000}m`,
          };
  }
}

function executionDraftFromJob(job: CronJob): ExecutionDraft {
  if (job.execution.kind === "main") return { kind: "main" };
  return {
    kind: "isolated",
    model: job.execution.model,
    effort: job.execution.effort,
    tools: [...job.execution.tools],
    skills: [...job.execution.skills],
    extensions: [...job.execution.extensions],
    notify: job.execution.notify,
    timeout: `${Math.ceil(job.execution.timeoutMs / 60_000)}m`,
  };
}
