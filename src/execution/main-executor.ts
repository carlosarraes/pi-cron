import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActiveExecution } from "../core/service.js";
import { parseDuration } from "../domain/schedule.js";
import type { Clock, CronJob, DispatchResult } from "../domain/types.js";
import type { PromptResolver } from "./prompt-resolver.js";

const ADAPTIVE_FALLBACK_MS = 20 * 60_000;

export interface MainExecutionService {
  get(id: string): CronJob | undefined;
  beginExecution(jobId: string, adaptive: boolean): string;
  getActiveExecution(): ActiveExecution | undefined;
  endExecution(token: string): void;
  setAdaptiveWakeup(
    token: string,
    at: Date,
    reason: string,
    fallbackUsed?: boolean,
  ): Promise<void>;
  stopAdaptive(token: string, reason: string): Promise<void>;
}

export interface MainExecutorOptions {
  pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage">;
  service: MainExecutionService;
  resolver: Pick<PromptResolver, "resolve">;
  clock: Clock;
  readUsage: () => number;
}

interface PendingRun {
  jobId: string;
  token: string;
  usageBefore: number;
  resolve: (result: DispatchResult) => void;
}

export class MainExecutor {
  private readonly pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage">;
  private readonly service: MainExecutionService;
  private readonly resolver: Pick<PromptResolver, "resolve">;
  private readonly clock: Clock;
  private readonly readUsage: () => number;
  private pending: PendingRun | undefined;
  private starting = false;

  constructor(options: MainExecutorOptions) {
    this.pi = options.pi;
    this.service = options.service;
    this.resolver = options.resolver;
    this.clock = options.clock;
    this.readUsage = options.readUsage;
  }

  isIdle(): boolean {
    return !this.starting && this.pending === undefined;
  }

  async execute(job: CronJob, scheduledAt: Date): Promise<DispatchResult> {
    if (this.starting || this.pending) {
      throw new Error("A main-session cron run is already active");
    }
    this.starting = true;
    let prompt: string;
    try {
      prompt = await this.resolver.resolve(job);
    } catch (error) {
      this.starting = false;
      throw error;
    }
    let token: string;
    try {
      token = this.service.beginExecution(
        job.id,
        job.schedule.kind === "adaptive",
      );
    } catch (error) {
      this.starting = false;
      throw error;
    }
    const dispatchedAt = this.clock.now().toISOString();

    try {
      this.pi.appendEntry("pi-cron/run", {
        kind: "started",
        jobId: job.id,
        scheduledAt: scheduledAt.toISOString(),
        dispatchedAt,
      });
    } catch (error) {
      this.starting = false;
      this.service.endExecution(token);
      return {
        outcome: "failed",
        tokens: 0,
        error: toErrorMessage(error),
      };
    }

    return new Promise<DispatchResult>((resolve) => {
      this.pending = {
        jobId: job.id,
        token,
        usageBefore: this.readUsage(),
        resolve,
      };
      this.starting = false;
      try {
        this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      } catch (error) {
        this.finish({
          outcome: "failed",
          tokens: 0,
          error: toErrorMessage(error),
        });
      }
    });
  }

  async settle(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;

    try {
      await this.applyAdaptiveFallback(pending);
      this.finish({ outcome: "settled", tokens: this.usageDelta(pending) });
    } catch (error) {
      this.finish({
        outcome: "failed",
        tokens: this.usageDelta(pending),
        error: toErrorMessage(error),
      });
    }
  }

  abortPending(reason = "session shutdown"): void {
    const pending = this.pending;
    if (!pending) return;
    this.finish({
      outcome: "aborted",
      tokens: this.usageDelta(pending),
      error: reason,
    });
  }

  async applyWakeup(input: {
    delay?: string;
    stop?: boolean;
    reason: string;
  }): Promise<void> {
    const active = this.requireAdaptiveExecution();
    const hasDelay = input.delay !== undefined;
    const shouldStop = input.stop === true;
    if (hasDelay === shouldStop) {
      throw new Error("cron_wakeup requires exactly one of delay or stop=true");
    }
    if (!input.reason.trim()) throw new Error("cron_wakeup requires a reason");

    if (shouldStop) {
      await this.service.stopAdaptive(active.token, input.reason.trim());
      return;
    }

    const delayMs = parseDuration(input.delay as string);
    if (delayMs < 60_000 || delayMs > 3_600_000) {
      throw new Error("Adaptive delay must be between 1m and 1h");
    }
    await this.service.setAdaptiveWakeup(
      active.token,
      new Date(this.clock.now().getTime() + delayMs),
      input.reason.trim(),
    );
  }

  private async applyAdaptiveFallback(pending: PendingRun): Promise<void> {
    const active = this.service.getActiveExecution();
    if (!active || active.token !== pending.token || !active.adaptive) return;
    if (active.decisionMade) return;

    const job = this.service.get(active.jobId);
    if (job?.schedule.kind !== "adaptive") {
      throw new Error("Active adaptive cron job is unavailable");
    }
    if (job.schedule.fallbackUsed) {
      await this.service.stopAdaptive(
        active.token,
        "Paused after two adaptive runs omitted cron_wakeup",
      );
      return;
    }
    await this.service.setAdaptiveWakeup(
      active.token,
      new Date(this.clock.now().getTime() + ADAPTIVE_FALLBACK_MS),
      "Automatic 20m fallback because cron_wakeup was omitted",
      true,
    );
  }

  private requireAdaptiveExecution(): ActiveExecution {
    const active = this.service.getActiveExecution();
    if (!active)
      throw new Error("cron_wakeup is only available during a cron run");
    if (!active.adaptive) {
      throw new Error(
        "cron_wakeup is only available during an adaptive cron run",
      );
    }
    if (active.decisionMade) {
      throw new Error("cron_wakeup was already decided for this run");
    }
    return active;
  }

  private usageDelta(pending: PendingRun): number {
    return Math.max(0, this.readUsage() - pending.usageBefore);
  }

  private finish(result: DispatchResult): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    try {
      this.pi.appendEntry("pi-cron/result", {
        kind: "finished",
        jobId: pending.jobId,
        settledAt: this.clock.now().toISOString(),
        ...result,
      });
    } catch {
      // Result display persistence must not strand the execution bridge.
    }
    try {
      this.service.endExecution(pending.token);
    } finally {
      pending.resolve(result);
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
