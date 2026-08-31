import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SavedApprovalPort } from "../core/saved-service.js";
import type {
  ProposedSavedCronDefinition,
  SavedCronDefinition,
  SavedSchedule,
} from "../domain/saved.js";
import type { ApprovalMode, CronJob } from "../domain/types.js";

export class UiSavedApprovalPort implements SavedApprovalPort {
  constructor(
    private readonly ctx: Pick<ExtensionContext, "hasUI" | "ui">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async approve(
    definition: ProposedSavedCronDefinition,
    reason: "create" | "privilege_increase",
    mode: ApprovalMode = "interactive",
  ): Promise<SavedCronDefinition["approval"] | undefined> {
    if (mode === "automatic") return this.recordApproval(definition);
    if (!this.ctx.hasUI) {
      throw new Error("Saved cron mutation requires interactive approval");
    }
    const accepted = await this.ctx.ui.confirm(
      reason === "create"
        ? "Save cron definition?"
        : "Approve increased saved cron privileges?",
      formatSavedApproval(definition),
    );
    return accepted ? this.recordApproval(definition) : undefined;
  }

  private recordApproval(
    definition: ProposedSavedCronDefinition,
  ): SavedCronDefinition["approval"] {
    return {
      approvedAt: this.now().toISOString(),
      fingerprint: fingerprintSavedDefinition(definition),
    };
  }
}

export function fingerprintSavedDefinition(
  definition: ProposedSavedCronDefinition,
): string {
  const fingerprintInput = {
    version: definition.version,
    id: definition.id,
    name: definition.name,
    prompt: definition.prompt,
    schedule: definition.schedule,
    execution: definition.execution,
    overlap: definition.overlap ?? "queue",
    unsafeSeconds: definition.unsafeSeconds,
    expiresAfterMs: definition.expiresAfterMs,
    maxRuns: definition.maxRuns ?? null,
    tokenBudget: definition.tokenBudget ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(fingerprintInput))
    .digest("hex");
}

export function formatSavedApproval(
  definition: ProposedSavedCronDefinition,
): string {
  const execution =
    definition.execution.kind === "main"
      ? [
          "Mode: main session",
          "Model/effort: inherited at fire time",
          "Resources: inherits current main-session tools, skills, and extensions",
          "Notify: n/a (main execution always follows up in this session)",
        ]
      : [
          "Mode: isolated",
          `Model: ${definition.execution.model}`,
          `Effort: ${definition.execution.effort}`,
          `Tools: ${definition.execution.tools.join(", ") || "none"}`,
          `Skills: ${definition.execution.skills.join(", ") || "none"}`,
          `Extensions: ${definition.execution.extensions.join(", ") || "none"}`,
          `Notify parent: ${definition.execution.notify ? "yes" : "no"}`,
          `Timeout: ${definition.execution.timeoutMs}ms`,
        ];
  return [
    `Name: ${definition.name}`,
    `Prompt: ${formatPrompt(definition.prompt)}`,
    `Schedule: ${formatSavedSchedule(definition.schedule)}`,
    `Overlap: ${definition.overlap ?? "queue"}`,
    `Unsafe sub-minute intervals: ${definition.unsafeSeconds ? "yes" : "no"}`,
    ...execution,
    `Expiry after: ${definition.expiresAfterMs}ms`,
    `Maximum runs: ${definition.maxRuns ?? "unbounded"}`,
    `Token budget: ${definition.tokenBudget ?? "unbounded"}`,
    "Plaintext warning: this prompt will be stored in .pi/crons.json and may be committed.",
    "Credentials warning: activations use credentials available to Pi at execution time.",
    `Configuration fingerprint: ${fingerprintSavedDefinition(definition)}`,
  ].join("\n");
}

function formatPrompt(prompt: CronJob["prompt"]): string {
  switch (prompt.kind) {
    case "text":
      return prompt.text;
    case "maintenance":
      return "maintenance";
    case "command":
      return `/${prompt.name}${prompt.args ? ` ${prompt.args}` : ""} (${prompt.source})`;
  }
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
