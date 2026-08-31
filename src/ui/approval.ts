import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeSchedule, nextOccurrence } from "../domain/schedule.js";
import {
  type ApprovalMode,
  type ApprovalPort,
  type CronJob,
  DEFAULT_LIMITS,
  type ProposedJob,
} from "../domain/types.js";

export class UiApprovalPort implements ApprovalPort {
  constructor(
    private readonly ctx: Pick<ExtensionContext, "hasUI" | "ui">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async approve(
    job: ProposedJob,
    reason: "create" | "privilege_increase",
    mode: ApprovalMode = "interactive",
  ): Promise<CronJob["approval"] | undefined> {
    if (mode === "automatic") return this.recordApproval(job);
    if (!this.ctx.hasUI) {
      throw new Error("Cron mutation requires interactive approval");
    }
    const accepted = await this.ctx.ui.confirm(
      reason === "create"
        ? "Create cron job?"
        : "Approve increased cron privileges?",
      formatApproval(job, this.now()),
    );
    if (!accepted) return undefined;
    return this.recordApproval(job);
  }

  private recordApproval(job: ProposedJob): CronJob["approval"] {
    return {
      approvedAt: this.now().toISOString(),
      fingerprint: fingerprintJob(job),
    };
  }
}

export function fingerprintJob(job: ProposedJob): string {
  const input = {
    version: job.version,
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    schedule: job.schedule,
    execution: job.execution,
    overlap: job.overlap ?? "queue",
    expiresAt: job.expiresAt,
    maxRuns: job.maxRuns ?? null,
    tokenBudget: job.tokenBudget ?? null,
    originSessionId: job.originSessionId,
    savedDefinitionId: job.savedDefinitionId ?? null,
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function formatApproval(job: ProposedJob, now = new Date()): string {
  const next = nextOccurrence(job.schedule, now);
  const prompt = formatPrompt(job.prompt);
  const execution =
    job.execution.kind === "main"
      ? [
          "Mode: main session",
          "Model/effort: inherited at fire time",
          "Resources: inherits current main-session tools, skills, and extensions",
          "Notify: n/a (main execution always follows up in this session)",
        ]
      : [
          "Mode: isolated",
          `Model: ${job.execution.model}`,
          `Effort: ${job.execution.effort}`,
          `Tools: ${job.execution.tools.join(", ") || "none"}`,
          `Skills: ${job.execution.skills.join(", ") || "none"}`,
          `Extensions: ${job.execution.extensions.join(", ") || "none"}`,
          `Notify parent: ${job.execution.notify ? "yes" : "no"}`,
          `Timeout: ${job.execution.timeoutMs}ms`,
        ];
  const timezone =
    job.schedule.kind === "cron"
      ? job.schedule.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [
    `Name: ${job.name}`,
    `Prompt: ${prompt}`,
    `Schedule: ${describeSchedule(job.schedule)}`,
    `Next run: ${next?.toISOString() ?? "none"}`,
    `Timezone: ${timezone}`,
    `Overlap: ${job.overlap ?? "queue"}`,
    ...execution,
    `Expires: ${job.expiresAt}`,
    `Maximum runs: ${job.maxRuns ?? "unbounded"}`,
    `Token budget: ${job.tokenBudget ?? "unbounded"}`,
    `Failure limit: ${DEFAULT_LIMITS.maxConsecutiveFailures} consecutive technical failures`,
    "Credentials warning: scheduled runs use credentials available to Pi at execution time.",
    `Configuration fingerprint: ${fingerprintJob(job)}`,
  ].join("\n");
}

function formatPrompt(prompt: CronJob["prompt"]): string {
  switch (prompt.kind) {
    case "text":
      return prompt.text;
    case "command":
      return `/${prompt.name}${prompt.args ? ` ${prompt.args}` : ""} (${prompt.source})`;
    case "maintenance":
      return "maintenance file (.pi/cron.md, then ~/.pi/agent/cron.md, then built-in fallback)";
  }
}
