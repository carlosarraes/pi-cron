import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ActiveExecution } from "../core/service.js";
import { parseDuration } from "../domain/schedule.js";
import type { CronJob, DispatchResult } from "../domain/types.js";
import type { PromptResolver } from "./prompt-resolver.js";

const DISPLAY_LIMIT = 500;
const ADAPTIVE_FALLBACK_MS = 20 * 60_000;

export interface IsolatedExecutionService {
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

export interface IsolatedPiPort {
  appendEntry(type: string, data?: unknown): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    },
    options?: { triggerTurn?: boolean; deliverAs?: "followUp" },
  ): void;
}

export interface IsolatedSession {
  messages: unknown[];
  prompt(prompt: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  bindExtensions(bindings: object): Promise<void>;
}

export interface IsolatedExecutorOptions {
  cwd: string;
  agentDir?: string;
  modelRegistry: Pick<ModelRegistry, "getAvailable">;
  pi: IsolatedPiPort;
  service: IsolatedExecutionService;
  resolver: Pick<PromptResolver, "resolve">;
  now?: () => Date;
  createSession?: (
    options: Record<string, unknown>,
  ) => Promise<{ session: IsolatedSession }>;
  resourceLoaderFactory?: (
    options: ConstructorParameters<typeof DefaultResourceLoader>[0],
  ) => DefaultResourceLoader;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type IsolatedMode = Extract<CronJob["execution"], { kind: "isolated" }>;

export function resolveModel(
  registry: Pick<ModelRegistry, "getAvailable">,
  requested: string,
): Model<Api> {
  const models = registry.getAvailable();
  const query = requested.trim().toLowerCase();
  const labels = (model: Model<Api>) => [
    `${model.provider}/${model.id}`.toLowerCase(),
    model.id.toLowerCase(),
    model.name.toLowerCase(),
  ];
  const exact = models.filter((model) => labels(model).includes(query));
  if (exact.length === 1) return exact[0] as Model<Api>;
  if (exact.length > 1) {
    throw new Error(`Ambiguous isolated model '${requested}'`);
  }
  const fuzzy = models.filter((model) =>
    labels(model).some((label) => label.includes(query)),
  );
  if (fuzzy.length === 1) return fuzzy[0] as Model<Api>;
  if (fuzzy.length > 1) {
    throw new Error(`Ambiguous isolated model '${requested}'`);
  }
  throw new Error(`Isolated model unavailable: ${requested}`);
}

export function buildResourceLoader(
  options: {
    cwd: string;
    agentDir: string;
    approved: Pick<IsolatedMode, "extensions" | "skills">;
  },
  factory: (
    value: ConstructorParameters<typeof DefaultResourceLoader>[0],
  ) => DefaultResourceLoader = (value) => new DefaultResourceLoader(value),
): DefaultResourceLoader {
  const { approved } = options;
  return factory({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: SettingsManager.create(options.cwd, options.agentDir),
    noExtensions: approved.extensions.length === 0,
    noSkills: approved.skills.length === 0,
    noPromptTemplates: true,
    noThemes: true,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((extension) =>
        approved.extensions.some((name) => extension.path.includes(name)),
      ),
    }),
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) =>
        approved.skills.includes(skill.name),
      ),
    }),
  });
}

interface ActiveRun {
  session: IsolatedSession;
  shutdown: boolean;
}

export class IsolatedExecutor {
  private readonly options: IsolatedExecutorOptions;
  private readonly activeRuns = new Set<ActiveRun>();
  private stopping = false;

  constructor(options: IsolatedExecutorOptions) {
    this.options = options;
  }

  isIdle(): boolean {
    return this.activeRuns.size === 0;
  }

  async execute(job: CronJob, _scheduledAt: Date): Promise<DispatchResult> {
    if (job.execution.kind !== "isolated") {
      throw new Error("IsolatedExecutor requires an isolated job");
    }
    if (this.stopping) {
      return { outcome: "aborted", tokens: 0, error: "session shutdown" };
    }
    const execution = job.execution;
    let token: string | undefined;
    let session: IsolatedSession | undefined;
    let timer: unknown;
    let timedOut = false;
    let run: ActiveRun | undefined;

    try {
      const prompt = await this.options.resolver.resolve(job);
      const model = resolveModel(this.options.modelRegistry, execution.model);
      const supported = getSupportedThinkingLevels(model);
      if (!supported.includes(execution.effort)) {
        throw new Error(
          `Thinking effort '${execution.effort}' is unavailable for ${model.provider}/${model.id}`,
        );
      }
      const agentDir = this.options.agentDir ?? getAgentDir();
      const resourceLoader = buildResourceLoader(
        { cwd: this.options.cwd, agentDir, approved: execution },
        this.options.resourceLoaderFactory,
      );
      await resourceLoader.reload();

      token = this.options.service.beginExecution(
        job.id,
        job.schedule.kind === "adaptive",
      );
      const adaptiveTool =
        job.schedule.kind === "adaptive"
          ? this.createAdaptiveTool(token)
          : undefined;
      const create = this.options.createSession ?? defaultCreateSession;
      const created = await create({
        cwd: this.options.cwd,
        agentDir,
        sessionManager: SessionManager.inMemory(this.options.cwd),
        settingsManager: SettingsManager.create(this.options.cwd, agentDir),
        modelRegistry: this.options.modelRegistry,
        model,
        thinkingLevel: execution.effort,
        tools: [...execution.tools],
        customTools: adaptiveTool ? [adaptiveTool] : [],
        resourceLoader,
      });
      session = created.session;
      if (this.stopping) {
        await session.abort();
        return this.complete(job, session, {
          outcome: "aborted",
          tokens: collectTokens(session.messages),
          error: "session shutdown",
        });
      }
      if (execution.extensions.length > 0) await session.bindExtensions({});
      run = { session, shutdown: false };
      this.activeRuns.add(run);

      const timeout = new Promise<"timeout">((resolve) => {
        const setTimer =
          this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        timer = setTimer(() => {
          timedOut = true;
          void session?.abort().then(
            () => resolve("timeout"),
            () => resolve("timeout"),
          );
        }, execution.timeoutMs);
      });
      const completion = session
        .prompt(prompt)
        .then(() => "completed" as const);
      const winner = await Promise.race([completion, timeout]);
      if (winner === "timeout" || timedOut) {
        return this.complete(job, session, {
          outcome: "timed_out",
          tokens: collectTokens(session.messages),
          error: `Timed out after ${execution.timeoutMs}ms`,
        });
      }
      if (run.shutdown) {
        return this.complete(job, session, {
          outcome: "aborted",
          tokens: collectTokens(session.messages),
          error: "session shutdown",
        });
      }
      await this.applyAdaptiveFallback(job, token);
      return this.complete(job, session, {
        outcome: "settled",
        tokens: collectTokens(session.messages),
      });
    } catch (error) {
      const outcome = timedOut
        ? "timed_out"
        : run?.shutdown
          ? "aborted"
          : "failed";
      return this.complete(job, session, {
        outcome,
        tokens: collectTokens(session?.messages ?? []),
        error: truncateUnicode(toErrorMessage(error)),
      });
    } finally {
      if (timer !== undefined) {
        const clearTimer =
          this.options.clearTimer ??
          ((handle) => clearTimeout(handle as NodeJS.Timeout));
        clearTimer(timer);
      }
      if (run) this.activeRuns.delete(run);
      session?.dispose();
      if (token) this.options.service.endExecution(token);
    }
  }

  async abortAll(): Promise<void> {
    this.stopping = true;
    const runs = [...this.activeRuns];
    for (const run of runs) run.shutdown = true;
    await Promise.allSettled(runs.map((run) => run.session.abort()));
  }

  private async applyAdaptiveFallback(
    job: CronJob,
    token: string,
  ): Promise<void> {
    if (job.schedule.kind !== "adaptive") return;
    const active = this.options.service.getActiveExecution();
    if (!active || active.token !== token || active.decisionMade) return;
    if (job.schedule.fallbackUsed) {
      await this.options.service.stopAdaptive(
        token,
        "Paused after two adaptive runs omitted cron_wakeup",
      );
      return;
    }
    await this.options.service.setAdaptiveWakeup(
      token,
      new Date(
        (this.options.now?.() ?? new Date()).getTime() + ADAPTIVE_FALLBACK_MS,
      ),
      "Automatic 20m fallback because cron_wakeup was omitted",
      true,
    );
  }

  private complete(
    job: CronJob,
    session: IsolatedSession | undefined,
    result: DispatchResult,
  ): DispatchResult {
    const summary = truncateUnicode(collectOutput(session?.messages ?? []));
    const bounded: DispatchResult = {
      ...result,
      ...(result.error ? { error: truncateUnicode(result.error) } : {}),
    };
    try {
      this.options.pi.appendEntry("pi-cron/result", {
        kind: "isolated",
        jobId: job.id,
        model:
          job.execution.kind === "isolated" ? job.execution.model : undefined,
        summary,
        ...bounded,
      });
    } catch {
      // Display persistence must not change the technical run outcome.
    }
    if (job.execution.kind === "isolated" && job.execution.notify) {
      try {
        this.options.pi.sendMessage(
          {
            customType: "pi-cron/isolated",
            content:
              summary || bounded.error || `Cron job ${job.name} completed`,
            display: true,
            details: { jobId: job.id, ...bounded },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch {
        // Parent notification is best effort and must not duplicate the run.
      }
    }
    return bounded;
  }

  private createAdaptiveTool(token: string) {
    return defineTool({
      name: "cron_wakeup",
      label: "Cron Wakeup",
      description: "Choose the next adaptive cron wakeup or stop the job.",
      parameters: Type.Object({
        delay: Type.Optional(Type.String()),
        stop: Type.Optional(Type.Boolean()),
        reason: Type.String({ minLength: 1 }),
      }),
      execute: async (_id, input) => {
        const hasDelay = input.delay !== undefined;
        const shouldStop = input.stop === true;
        if (hasDelay === shouldStop) {
          throw new Error(
            "cron_wakeup requires exactly one of delay or stop=true",
          );
        }
        if (shouldStop) {
          await this.options.service.stopAdaptive(token, input.reason);
        } else {
          const delayMs = parseDuration(input.delay as string);
          if (delayMs < 60_000 || delayMs > 3_600_000) {
            throw new Error("Adaptive delay must be between 1m and 1h");
          }
          await this.options.service.setAdaptiveWakeup(
            token,
            new Date((this.options.now?.() ?? new Date()).getTime() + delayMs),
            input.reason,
          );
        }
        return {
          content: [
            { type: "text" as const, text: "Adaptive wakeup recorded." },
          ],
          details: {},
        };
      },
    });
  }
}

async function defaultCreateSession(
  options: Record<string, unknown>,
): Promise<{ session: IsolatedSession }> {
  const { session } = await createAgentSession(options);
  return { session };
}

function collectTokens(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    const usage = message.usage;
    if (!isRecord(usage) || typeof usage.totalTokens !== "number") continue;
    if (Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) {
      total += usage.totalTokens;
    }
  }
  return Number.isFinite(total) ? total : 0;
}

function collectOutput(messages: unknown[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (
        isRecord(content) &&
        content.type === "text" &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n");
}

function truncateUnicode(value: string): string {
  const characters = [...value];
  return characters.length <= DISPLAY_LIMIT
    ? value
    : `${characters.slice(0, DISPLAY_LIMIT - 1).join("")}…`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
