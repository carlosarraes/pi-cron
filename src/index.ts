import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerCronCommand } from "./commands/register.js";
import { AFTER_RUN_COMMAND } from "./core/session-handoff.js";
import { CronRuntime } from "./runtime.js";
import { registerCronTools } from "./tools/register.js";
import { registerCronRenderers } from "./ui/status.js";

export default function piCron(pi: ExtensionAPI): void {
  const runtime = new CronRuntime(pi);
  registerCronTools(pi, runtime);
  registerCronCommand(pi, runtime);
  registerCronRenderers(pi);
  pi.registerCommand(AFTER_RUN_COMMAND, {
    description: "Internal cron post-run session action",
    handler: (token, ctx) => runtime.completeAfterRun(token, ctx),
  });

  pi.on("session_start", async (event, ctx) => {
    await safely(ctx, () => runtime.start(ctx, event.reason));
  });
  pi.on("session_tree", async (_event, ctx) => {
    await safely(ctx, () => runtime.start(ctx, "reload"));
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await safely(ctx, () => runtime.onAgentSettled(ctx));
  });
  pi.on("session_shutdown", async (event, ctx) => {
    await safely(ctx, () => runtime.stop(ctx, event.reason));
  });
}

async function safely(
  ctx: ExtensionContext,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`pi-cron: ${message}`, "error");
  }
}
