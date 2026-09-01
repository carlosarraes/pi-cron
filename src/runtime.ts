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
import { ProjectCronStore } from "./core/project-cron-store.js";
import { materializeSavedDefinition } from "./core/saved-conversion.js";
import { SavedCronService } from "./core/saved-service.js";
import { Scheduler } from "./core/scheduler.js";
import { CronService, type JobDraft } from "./core/service.js";
import { selectJob } from "./domain/policy.js";
import type { SavedDefinitionStore } from "./domain/saved.js";
import type {
  ApprovalMode,
  Clock,
  CronJob,
  Dispatcher,
  DispatchResult,
} from "./domain/types.js";
import { makeJobId } from "./domain/types.js";
import { IsolatedExecutor } from "./execution/isolated-executor.js";
import { MainExecutor } from "./execution/main-executor.js";
import { PromptResolver } from "./execution/prompt-resolver.js";
import { validateActivationResources } from "./execution/resource-validator.js";
import { UiApprovalPort } from "./ui/approval.js";
import { runCronManager } from "./ui/manager.js";
import { UiSavedApprovalPort } from "./ui/saved-approval.js";
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

type LeaseResult = { owned: true } | { owned: false; owner: LeaseRecord };

interface LeasePort {
  acquire(sessionId: string): Promise<LeaseResult>;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

const GENERATION_CANCELLED = Symbol("generation-cancelled");

interface RecoveryCleanup {
  scheduler: Scheduler | undefined;
  isolatedExecutor: IsolatedExecutor | undefined;
}

const RECOVERY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;

export interface CronRuntimeDependencies {
  clock?: Clock;
  leaseFactory?: () => LeasePort;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  savedStoreFactory?: (ctx: ExtensionContext) => SavedDefinitionStore;
}

export class CronRuntime implements CronRuntimeRef {
  private readonly pi: ExtensionAPI;
  private readonly clock: Clock;
  private readonly leaseFactory: () => LeasePort;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly savedStoreFactory: (
    ctx: ExtensionContext,
  ) => SavedDefinitionStore;
  private service: CronService | undefined;
  private savedService: SavedCronService | undefined;
  private scheduler: Scheduler | undefined;
  private mainExecutor: MainExecutor | undefined;
  private isolatedExecutor: IsolatedExecutor | undefined;
  private promptResolver: PromptResolver | undefined;
  private lease: LeasePort | undefined;
  private heartbeatHandle: unknown;
  private recoveryHandle: unknown;
  private recoveryAttempt = 0;
  private retryExistingLease = false;
  private releaseLeaseBeforeAcquire = false;
  private recoveryCleanup: RecoveryCleanup | undefined;
  private cleanupErrorNotified = false;
  private generation = 0;
  private generationAbortController = new AbortController();
  private lossNotified = false;
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
    this.savedStoreFactory =
      dependencies.savedStoreFactory ??
      ((ctx) =>
        new ProjectCronStore({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          isProjectTrusted: () => ctx.isProjectTrusted(),
        }));
  }

  start(
    ctx: ExtensionContext,
    reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
  ): Promise<void> {
    const generation = this.advanceGeneration();
    return this.serialize(async () => {
      if (generation !== this.generation) return;
      await this.stopInternal();
      if (generation !== this.generation) return;
      this.ctx = ctx;
      this.rebuildServices(ctx);
      const candidate = this.leaseFactory();
      let acquired: LeaseResult | undefined;
      try {
        acquired = await this.acquireForGeneration(
          candidate,
          ctx.sessionManager.getSessionId(),
          generation,
        );
      } catch (error) {
        if (generation !== this.generation) return;
        this.lease = candidate;
        await this.enterRecovery(generation, error, false);
        this.refreshUi();
        return;
      }
      if (!acquired || generation !== this.generation) return;
      this.lease = candidate;
      this.readOnlyOwner = acquired.owned ? undefined : acquired.owner;
      if (acquired.owned) {
        await this.classifyResume(reason);
        this.buildExecutors(ctx);
        this.scheduler?.start();
        this.startHeartbeat(generation);
      } else {
        await this.enterRecovery(generation, undefined, false);
      }
      this.refreshUi();
    });
  }

  stop(ctx?: ExtensionContext): Promise<void> {
    this.advanceGeneration();
    return this.serialize(async () => {
      const currentCtx = ctx ?? this.ctx;
      await this.stopInternal();
      currentCtx?.ui.setStatus("pi-cron", undefined);
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

  requireSavedService(): SavedCronService {
    if (!this.savedService) throw new Error("Cron runtime is not started");
    return this.savedService;
  }

  assertSavedMutationAllowed(): void {
    if (this.requireService().getActiveExecution()) {
      throw new Error("Scheduled runs cannot mutate saved cron definitions");
    }
  }

  async startSaved(
    selector: string,
    approvalMode: ApprovalMode = "interactive",
  ): Promise<CronJob> {
    this.requireWritable();
    this.assertSavedMutationAllowed();
    const ctx = this.ctx;
    if (!ctx) throw new Error("Cron runtime is not started");
    const definition = await this.requireSavedService().select(selector);
    const draft = materializeSavedDefinition(definition, this.clock.now());
    await validateActivationResources({
      pi: this.pi,
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      modelRegistry: ctx.modelRegistry,
      prompt: draft.prompt,
      schedule: draft.schedule,
      execution: draft.execution ?? { kind: "main" },
    });
    return this.requireService().activateSaved(definition.id, draft, {
      approvalMode,
    });
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

  private advanceGeneration(): number {
    this.generationAbortController.abort();
    this.generationAbortController = new AbortController();
    this.generation += 1;
    return this.generation;
  }

  private async stopInternal(): Promise<void> {
    this.clearHeartbeat();
    if (this.recoveryHandle !== undefined) {
      this.clock.clearTimeout(this.recoveryHandle);
      this.recoveryHandle = undefined;
    }
    this.recoveryAttempt = 0;
    this.retryExistingLease = false;
    this.releaseLeaseBeforeAcquire = false;
    this.lossNotified = false;
    const recoveryCleanup = this.recoveryCleanup;
    const scheduler = this.scheduler ?? recoveryCleanup?.scheduler;
    const isolated = this.isolatedExecutor ?? recoveryCleanup?.isolatedExecutor;
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
    this.recoveryCleanup = undefined;
    this.cleanupErrorNotified = false;
    this.service = undefined;
    this.savedService = undefined;
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
      if (
        (reason === "startup" || reason === "resume") &&
        job.savedDefinitionId
      ) {
        await service.transitionState(
          job.id,
          "paused",
          "Saved cron requires explicit restart after session restoration",
        );
      } else if (reason === "fork" && job.originSessionId !== sessionId) {
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

  private startHeartbeat(generation: number): void {
    this.clearHeartbeat();
    this.heartbeatHandle = this.setIntervalFn(() => {
      void this.serialize(() => this.handleHeartbeat(generation)).catch(
        (error) => this.notifyError(error),
      );
    }, 30_000);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatHandle === undefined) return;
    this.clearIntervalFn(this.heartbeatHandle);
    this.heartbeatHandle = undefined;
  }

  private async handleHeartbeat(generation: number): Promise<void> {
    if (generation !== this.generation || !this.lease || !this.scheduler) {
      return;
    }
    try {
      const result = await this.waitForGeneration(
        this.lease.heartbeat(),
        generation,
      );
      if (result === GENERATION_CANCELLED) return;
    } catch (error) {
      if (generation !== this.generation) return;
      await this.enterRecovery(generation, error, true);
    }
  }

  private async enterRecovery(
    generation: number,
    _error: unknown,
    previouslyOwned: boolean,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.clearHeartbeat();
    this.recoveryAttempt = 0;
    this.retryExistingLease = previouslyOwned;
    this.releaseLeaseBeforeAcquire = false;
    if (previouslyOwned && !this.lossNotified) {
      this.lossNotified = true;
      this.ctx?.ui.notify(
        "pi-cron: runtime lease lost; scheduling stopped; automatic recovery started",
        "error",
      );
    }
    this.beginRecoveryCleanup();
    const cleaned = await this.finishRecoveryCleanup(generation);
    if (generation !== this.generation) return;
    if (!cleaned) {
      this.scheduleRecovery(generation);
      this.refreshUi();
      return;
    }
    this.scheduleRecovery(generation);
    this.refreshUi();
  }

  private scheduleRecovery(generation: number): void {
    if (
      generation !== this.generation ||
      this.recoveryHandle !== undefined ||
      !this.ctx
    ) {
      return;
    }
    const delay =
      RECOVERY_DELAYS_MS[
        Math.min(this.recoveryAttempt, RECOVERY_DELAYS_MS.length - 1)
      ];
    const handle = this.clock.setTimeout(() => {
      if (this.recoveryHandle === handle) this.recoveryHandle = undefined;
      void this.serialize(() => this.attemptRecovery(generation)).catch(
        (error) => this.notifyError(error),
      );
    }, delay);
    this.recoveryHandle = handle;
  }

  private async attemptRecovery(generation: number): Promise<void> {
    if (generation !== this.generation || !this.ctx) return;
    const ctx = this.ctx;

    const cleaned = await this.finishRecoveryCleanup(generation);
    if (generation !== this.generation) return;
    if (!cleaned) {
      this.recoveryAttempt += 1;
      this.scheduleRecovery(generation);
      return;
    }

    if (this.releaseLeaseBeforeAcquire) {
      const released = await this.releasePendingLease(generation);
      if (!released || generation !== this.generation) return;
    }

    if (this.retryExistingLease && this.lease) {
      this.retryExistingLease = false;
      const existing = this.lease;
      let heartbeatSucceeded = false;
      try {
        const result = await this.waitForGeneration(
          existing.heartbeat(),
          generation,
        );
        if (result === GENERATION_CANCELLED) return;
        heartbeatSucceeded = true;
      } catch {
        if (generation !== this.generation) return;
      }
      if (generation !== this.generation) return;
      if (heartbeatSucceeded) {
        try {
          await this.rebuildOwnedRuntime(ctx, generation);
          return;
        } catch {
          await this.prepareOwnedLeaseRetry(existing, generation);
          return;
        }
      }
    }

    const candidate = this.leaseFactory();
    let acquired: LeaseResult | undefined;
    try {
      acquired = await this.acquireForGeneration(
        candidate,
        ctx.sessionManager.getSessionId(),
        generation,
      );
    } catch {
      if (generation !== this.generation) return;
      this.recoveryAttempt += 1;
      this.scheduleRecovery(generation);
      return;
    }
    if (!acquired || generation !== this.generation) return;
    if (!acquired.owned) {
      this.lease = candidate;
      this.readOnlyOwner = acquired.owner;
      this.recoveryAttempt += 1;
      this.scheduleRecovery(generation);
      this.refreshUi();
      return;
    }

    this.lease = candidate;
    try {
      await this.rebuildOwnedRuntime(ctx, generation);
    } catch {
      await this.prepareOwnedLeaseRetry(candidate, generation);
    }
  }

  private async waitForGeneration<T>(
    operation: Promise<T>,
    generation: number,
  ): Promise<T | typeof GENERATION_CANCELLED> {
    if (generation !== this.generation) return GENERATION_CANCELLED;
    const signal = this.generationAbortController.signal;
    if (signal.aborted) return GENERATION_CANCELLED;
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<typeof GENERATION_CANCELLED>((resolve) => {
      cancel = () => resolve(GENERATION_CANCELLED);
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      if (cancel) signal.removeEventListener("abort", cancel);
    }
  }

  private async acquireForGeneration(
    lease: LeasePort,
    sessionId: string,
    generation: number,
  ): Promise<LeaseResult | undefined> {
    const acquisition = lease.acquire(sessionId);
    const result = await this.waitForGeneration(acquisition, generation);
    if (result === GENERATION_CANCELLED) {
      this.releaseLateAcquisition(acquisition, lease);
      return undefined;
    }
    if (generation !== this.generation) {
      if (result.owned) this.releaseLateOwnedLease(lease);
      return undefined;
    }
    return result;
  }

  private releaseLateAcquisition(
    acquisition: Promise<LeaseResult>,
    lease: LeasePort,
  ): void {
    void acquisition
      .then(async (result) => {
        if (result.owned) await lease.release();
      })
      .catch(() => undefined);
  }

  private releaseLateOwnedLease(lease: LeasePort): void {
    void lease.release().catch(() => undefined);
  }

  private async prepareOwnedLeaseRetry(
    lease: LeasePort,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.lease = lease;
    this.releaseLeaseBeforeAcquire = true;
    const released = await this.releasePendingLease(generation);
    if (!released || generation !== this.generation) return;
    this.recoveryAttempt += 1;
    this.scheduleRecovery(generation);
  }

  private beginRecoveryCleanup(): void {
    if (this.recoveryCleanup) return;
    const scheduler = this.scheduler;
    const mainExecutor = this.mainExecutor;
    const isolatedExecutor = this.isolatedExecutor;
    this.scheduler = undefined;
    this.mainExecutor = undefined;
    this.isolatedExecutor = undefined;
    this.promptResolver = undefined;
    this.recoveryCleanup = { scheduler, isolatedExecutor };
    try {
      scheduler?.stop();
      mainExecutor?.abortPending("runtime lease ownership lost");
    } catch (error) {
      if (!this.cleanupErrorNotified) {
        this.cleanupErrorNotified = true;
        try {
          this.notifyError(error);
        } catch {
          // UI reporting cannot make recovery cleanup unsafe.
        }
      }
    }
  }

  private async finishRecoveryCleanup(generation: number): Promise<boolean> {
    const cleanup = this.recoveryCleanup;
    if (!cleanup) return true;
    try {
      await cleanup.isolatedExecutor?.abortAll();
      await cleanup.scheduler?.waitForIdle();
    } catch (error) {
      if (generation !== this.generation) return false;
      if (!this.cleanupErrorNotified) {
        this.cleanupErrorNotified = true;
        this.notifyError(error);
      }
      return false;
    }
    if (generation !== this.generation) return false;
    if (this.recoveryCleanup === cleanup) this.recoveryCleanup = undefined;
    this.cleanupErrorNotified = false;
    return true;
  }

  private async releasePendingLease(generation: number): Promise<boolean> {
    const pending = this.lease;
    if (!pending) {
      this.releaseLeaseBeforeAcquire = false;
      return true;
    }
    try {
      await pending.release();
    } catch {
      if (generation !== this.generation) return false;
      this.recoveryAttempt += 1;
      this.scheduleRecovery(generation);
      return false;
    }
    if (generation !== this.generation) return false;
    if (this.lease === pending) this.lease = undefined;
    this.releaseLeaseBeforeAcquire = false;
    return true;
  }

  private rebuildServices(ctx: ExtensionContext): void {
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
    this.savedService = new SavedCronService({
      store: this.savedStoreFactory(ctx),
      approvals: new UiSavedApprovalPort(ctx, () => this.clock.now()),
      clock: this.clock,
      idFactory: () => makeJobId(),
    });
  }

  private async rebuildOwnedRuntime(
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    try {
      this.rebuildServices(ctx);
      if (generation !== this.generation) return;
      await this.classifyResume("reload");
      if (generation !== this.generation) return;
      this.buildExecutors(ctx);
      this.scheduler?.start();
      this.startHeartbeat(generation);
    } catch (error) {
      this.clearHeartbeat();
      this.beginRecoveryCleanup();
      await this.finishRecoveryCleanup(generation);
      throw error;
    }
    this.readOnlyOwner = undefined;
    this.recoveryAttempt = 0;
    this.retryExistingLease = false;
    this.releaseLeaseBeforeAcquire = false;
    this.recoveryCleanup = undefined;
    this.cleanupErrorNotified = false;
    this.lossNotified = false;
    try {
      ctx.ui.notify(
        "pi-cron: runtime lease recovered; scheduling resumed",
        "info",
      );
    } catch {
      // UI reporting is outside the lease-ownership transaction.
    }
    try {
      this.refreshUi();
    } catch (error) {
      try {
        this.notifyError(error);
      } catch {
        // UI reporting cannot revoke proven lease ownership.
      }
    }
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
