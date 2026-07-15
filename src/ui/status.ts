import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Scheduler } from "../core/scheduler.js";
import type { CronService } from "../core/service.js";
import { formatDuration } from "./format.js";

export function updateCronStatus(
  ctx: Pick<ExtensionContext, "ui">,
  service: Pick<CronService, "list">,
  scheduler?: Pick<Scheduler, "nextDue">,
  now = new Date(),
): void {
  const active = service.list().filter((job) => job.state === "active");
  if (active.length === 0) {
    ctx.ui.setStatus("pi-cron", undefined);
    return;
  }
  const next = scheduler?.nextDue();
  const text = `cron ${active.length}${
    next
      ? ` · next ${next.name} in ${formatDuration(next.at.getTime() - now.getTime())}`
      : ""
  }`;
  ctx.ui.setStatus("pi-cron", text);
}

export function registerCronRenderers(pi: ExtensionAPI): void {
  pi.registerEntryRenderer("pi-cron/run", (entry, options, theme) => {
    const data = asRecord(entry.data);
    const job = stringValue(data.jobId, "unknown");
    const scheduled = stringValue(data.scheduledAt, "unknown");
    const dispatched = stringValue(data.dispatchedAt, "unknown");
    const compact = theme.fg("accent", `cron ▶ ${job} · ${scheduled}`);
    const text = options.expanded
      ? [
          compact,
          theme.fg("muted", `Scheduled: ${scheduled}`),
          theme.fg("muted", `Dispatched: ${dispatched}`),
        ].join("\n")
      : truncateToWidth(compact, 100);
    return new Text(text, 0, 0);
  });

  pi.registerEntryRenderer("pi-cron/result", (entry, options, theme) => {
    const data = asRecord(entry.data);
    const job = stringValue(data.jobId, "unknown");
    const outcome = stringValue(data.outcome, "finished");
    const tokens = typeof data.tokens === "number" ? data.tokens : 0;
    const summary = stringValue(data.summary, stringValue(data.error, ""));
    const compact = theme.fg(
      outcome === "settled" ? "success" : "warning",
      `cron ${outcome === "settled" ? "✓" : "!"} ${job} · ${tokens} tokens${summary ? ` · ${summary}` : ""}`,
    );
    const text = options.expanded
      ? [
          compact,
          theme.fg("muted", `Outcome: ${outcome}`),
          theme.fg(
            "muted",
            `Model: ${stringValue(data.model, "main inherited")}`,
          ),
          theme.fg("muted", `Usage: ${tokens} tokens`),
          ...(summary ? [theme.fg("muted", `Result: ${summary}`)] : []),
        ].join("\n")
      : truncateToWidth(compact, 100);
    return new Text(text, 0, 0);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
