import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { nextOccurrence } from "../domain/schedule.js";
import type { CronJob, RuntimeStatus } from "../domain/types.js";
import { projectRow, renderRow, stateLabel, visibleColumns } from "./format.js";

export interface CronManagerActions {
  jobs(): CronJob[];
  runtimeStatus(jobId: string): RuntimeStatus;
  add(): Promise<void>;
  togglePause(jobId: string): Promise<void>;
  runNow(jobId: string): Promise<void>;
  edit(jobId: string): Promise<void>;
  remove(jobId: string): Promise<void>;
  command(value: string): Promise<void>;
  close(): void;
  onError(error: unknown): void;
}

export interface CronManagerOptions {
  tui: Pick<TUI, "requestRender">;
  theme: Theme;
  actions: CronManagerActions;
  readOnlyOwner?: { pid: number };
  now?: () => Date;
}

export class CronManagerComponent implements Component {
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly theme: Theme;
  private readonly actions: CronManagerActions;
  private readonly readOnlyOwner: { pid: number } | undefined;
  private readonly now: () => Date;
  private selected = 0;
  private mode: "normal" | "search" | "command" = "normal";
  private input = "";
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(options: CronManagerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.actions = options.actions;
    this.readOnlyOwner = options.readOnlyOwner;
    this.now = options.now ?? (() => new Date());
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const jobs = this.filteredJobs();
    if (this.selected >= jobs.length)
      this.selected = Math.max(0, jobs.length - 1);
    const columns = visibleColumns(width);
    const lines = [
      truncateToWidth(
        this.theme.fg("accent", " pi-cron jobs ") +
          this.theme.fg(
            "dim",
            "a add · p pause · r run · e edit · x delete · / search · : command · q close",
          ),
        width,
      ),
    ];
    if (this.readOnlyOwner) {
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "warning",
            ` READ-ONLY — scheduler owned by PID ${this.readOnlyOwner.pid} `,
          ),
          width,
        ),
      );
    }
    lines.push(renderHeader(columns, width));

    if (jobs.length === 0) {
      lines.push(
        this.theme.fg(
          "dim",
          this.input
            ? "No jobs match the search."
            : "No cron jobs. Press a to add one.",
        ),
      );
    } else {
      const now = this.now();
      jobs.forEach((job, index) => {
        const runtime = this.actions.runtimeStatus(job.id);
        const next = nextOccurrence(job.schedule, now) ?? undefined;
        const prefix =
          index === this.selected ? this.theme.fg("accent", "> ") : "  ";
        const row = renderRow(
          projectRow(job, runtime, now, next),
          columns,
          Math.max(1, width - 2),
        );
        lines.push(truncateToWidth(prefix + row, width));
      });
      const selected = jobs[this.selected];
      if (selected) lines.push(...this.renderDetails(selected, width));
    }

    if (this.mode !== "normal") {
      lines.push(
        truncateToWidth(
          this.theme.fg("accent", this.mode === "search" ? "/" : ":") +
            this.input,
          width,
        ),
      );
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this.mode !== "normal") {
      this.handleEditorInput(data);
      return;
    }
    if (matchesKey(data, "up")) this.select(-1);
    else if (matchesKey(data, "down")) this.select(1);
    else if (data === "/") this.enterMode("search");
    else if (data === ":") this.enterMode("command");
    else if (data === "a") this.mutate(() => this.actions.add());
    else if (data === "p")
      this.withSelected((id) => this.actions.togglePause(id));
    else if (data === "r") this.withSelected((id) => this.actions.runNow(id));
    else if (data === "e") this.withSelected((id) => this.actions.edit(id));
    else if (data === "x") this.withSelected((id) => this.actions.remove(id));
    else if (matchesKey(data, "escape") || data === "q") this.actions.close();
    this.invalidateAndRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  selectedJobId(): string | undefined {
    return this.filteredJobs()[this.selected]?.id;
  }

  private renderDetails(job: CronJob, width: number): string[] {
    const runtime = this.actions.runtimeStatus(job.id);
    const prompt =
      job.prompt.kind === "text"
        ? job.prompt.text
        : job.prompt.kind === "maintenance"
          ? "maintenance"
          : `/${job.prompt.name} ${job.prompt.args}`.trim();
    return [
      this.theme.fg("borderMuted", "─".repeat(Math.max(1, width))),
      truncateToWidth(
        `${this.theme.fg("accent", job.name)} · ${stateLabel(job, runtime)} · ${job.id}`,
        width,
      ),
      ...prompt
        .split("\n")
        .map((line) => truncateToWidth(`Prompt: ${line}`, width)),
      truncateToWidth(
        `Expires: ${job.expiresAt} · Tokens: ${job.attributedTokens}`,
        width,
      ),
      ...(job.pauseReason
        ? [truncateToWidth(`Reason: ${job.pauseReason}`, width)]
        : []),
    ];
  }

  private handleEditorInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.mode = "normal";
      this.input = "";
    } else if (matchesKey(data, "backspace")) {
      this.input = [...this.input].slice(0, -1).join("");
    } else if (matchesKey(data, "enter")) {
      if (this.mode === "command" && this.input.trim()) {
        const command = this.input.trim();
        this.mutate(() => this.actions.command(command));
      }
      this.mode = "normal";
      this.input = "";
    } else if (matchesKey(data, "tab") && this.mode === "command") {
      this.input = this.completeCommand(this.input);
    } else if (isPrintable(data)) {
      this.input += data;
      if (this.mode === "search") this.selected = 0;
    }
    this.invalidateAndRender();
  }

  private completeCommand(value: string): string {
    const candidates = [
      "add",
      "pause ",
      "resume ",
      "run ",
      "edit ",
      "delete ",
      ...this.actions.jobs().flatMap((job) => [job.id, job.name]),
    ];
    return candidates.find((candidate) => candidate.startsWith(value)) ?? value;
  }

  private filteredJobs(): CronJob[] {
    const jobs = this.actions.jobs();
    if (this.mode !== "search" || !this.input.trim()) return jobs;
    const query = this.input.trim().toLowerCase();
    return jobs.filter(
      (job) =>
        job.id.toLowerCase().includes(query) ||
        job.name.toLowerCase().includes(query),
    );
  }

  private select(delta: number): void {
    const count = this.filteredJobs().length;
    if (count === 0) return;
    this.selected = (this.selected + delta + count) % count;
  }

  private enterMode(mode: "search" | "command"): void {
    this.mode = mode;
    this.input = "";
  }

  private withSelected(operation: (id: string) => Promise<void>): void {
    if (this.readOnlyOwner) return;
    const id = this.selectedJobId();
    if (id) this.mutate(() => operation(id));
  }

  private mutate(operation: () => Promise<void>): void {
    if (this.readOnlyOwner) return;
    void operation()
      .catch(this.actions.onError)
      .finally(() => this.invalidateAndRender());
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}

export async function runCronManager(
  ctx: ExtensionCommandContext,
  options: Omit<CronManagerOptions, "tui" | "theme" | "actions"> & {
    actions: Omit<CronManagerActions, "close">;
  },
): Promise<void> {
  if (ctx.mode !== "tui") {
    throw new Error(
      "Cron manager requires TUI mode; use /cron list in this mode",
    );
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new CronManagerComponent({
        ...options,
        tui,
        theme,
        actions: { ...options.actions, close: () => done() },
      }),
  );
}

function renderHeader(
  columns: ReturnType<typeof visibleColumns>,
  width: number,
): string {
  const values = Object.fromEntries(
    columns.map((column) => [column, column.toUpperCase()]),
  ) as Record<(typeof columns)[number], string>;
  return renderRow({ id: "header", values }, columns, width);
}

function isPrintable(data: string): boolean {
  return [...data].length === 1 && data >= " ";
}
