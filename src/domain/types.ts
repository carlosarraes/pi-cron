export const JOB_VERSION = 1 as const;
export const EVENT_VERSION = 1 as const;
export const DEFAULT_LIMITS = {
  expiresAfterMs: 7 * 24 * 60 * 60 * 1000,
  maxConsecutiveFailures: 3,
  isolatedTimeoutMs: 30 * 60 * 1000,
  minRecurringMs: 60 * 1000,
  maxJobs: 50,
} as const;

export type Schedule =
  | { kind: "interval"; intervalMs: number; anchorAt: string }
  | { kind: "cron"; expression: string; timezone: string }
  | { kind: "once"; at: string; original: string }
  | { kind: "adaptive"; nextWakeAt: string; fallbackUsed: boolean }
  | {
      kind: "maintenance";
      cadence: "adaptive" | { intervalMs: number; anchorAt: string };
    };

export type JobState = "active" | "paused" | "missed" | "completed" | "expired";
export type TechnicalOutcome =
  | "dispatched"
  | "settled"
  | "failed"
  | "timed_out"
  | "aborted";

export type ExecutionMode =
  | { kind: "main" }
  | {
      kind: "isolated";
      model: string;
      effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
      tools: string[];
      skills: string[];
      extensions: string[];
      notify: boolean;
      timeoutMs: number;
    };

export interface CronJob {
  version: typeof JOB_VERSION;
  id: string;
  name: string;
  prompt:
    | { kind: "text"; text: string }
    | { kind: "maintenance" }
    | {
        kind: "command";
        name: string;
        args: string;
        source: "skill" | "prompt";
      };
  schedule: Schedule;
  state: JobState;
  execution: ExecutionMode;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  maxRuns?: number;
  tokenBudget?: number;
  runCount: number;
  attributedTokens: number;
  consecutiveFailures: number;
  lastOccurrenceAt?: string;
  lastDispatchAt?: string;
  lastSettledAt?: string;
  lastTechnicalOutcome?: TechnicalOutcome;
  pauseReason?: string;
  approval: { approvedAt: string; fingerprint: string };
  originSessionId: string;
}

export type CronEvent =
  | { version: 1; type: "job_created"; at: string; job: CronJob }
  | { version: 1; type: "job_replaced"; at: string; job: CronJob }
  | { version: 1; type: "job_deleted"; at: string; jobId: string }
  | {
      version: 1;
      type: "metrics_checkpoint";
      at: string;
      jobs: Array<
        Pick<
          CronJob,
          | "id"
          | "runCount"
          | "attributedTokens"
          | "consecutiveFailures"
          | "lastOccurrenceAt"
          | "lastDispatchAt"
          | "lastSettledAt"
          | "lastTechnicalOutcome"
        >
      >;
    };

export type ProposedJob = Omit<CronJob, "approval">;

export interface RuntimeStatus {
  state: "idle" | "pending" | "running";
  pendingSince?: string;
  startedAt?: string;
}

export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EventStore {
  load(): CronEvent[];
  append(event: CronEvent): void;
}

export interface ApprovalPort {
  approve(
    job: ProposedJob,
    reason: "create" | "privilege_increase",
  ): Promise<CronJob["approval"] | undefined>;
}

export interface DispatchResult {
  outcome: TechnicalOutcome;
  tokens: number;
  error?: string;
}

export interface Dispatcher {
  isIdle(): boolean;
  execute(job: CronJob, scheduledAt: Date): Promise<DispatchResult>;
}

export function makeJobId(
  random: () => string = () => crypto.randomUUID().replaceAll("-", ""),
): string {
  return random().slice(0, 8).toLowerCase();
}
