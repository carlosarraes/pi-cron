import type { ExecutionMode, OverlapPolicy } from "../domain/types.js";

const DURATION = /^[1-9]\d*(?:s|m|h|d)$/;
const SCHEDULE_FLAGS = [
  "--every",
  "--cron",
  "--in",
  "--at",
  "--adaptive",
] as const;
const VALUE_FLAGS = new Set([
  "--every",
  "--cron",
  "--in",
  "--at",
  "--prompt",
  "--name",
  "--overlap",
  "--effort",
  "--expires",
  "--max-runs",
  "--budget",
  "--timeout",
  "--tools",
  "--skills",
  "--extensions",
]);
const BOOLEAN_FLAGS = new Set([
  "--adaptive",
  "--main",
  "--notify",
  "--unsafe-seconds",
]);
const EFFORTS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type IsolatedExecution = Extract<ExecutionMode, { kind: "isolated" }>;

export type ScheduleInput =
  | { kind: "interval"; value: string }
  | { kind: "cron"; value: string }
  | { kind: "in"; value: string }
  | { kind: "at"; value: string }
  | { kind: "adaptive" };

export type ExecutionDraft =
  | { kind: "main" }
  | {
      kind: "isolated";
      model?: string;
      effort?: IsolatedExecution["effort"];
      notify?: boolean;
      timeout?: string;
      tools?: string[];
      skills?: string[];
      extensions?: string[];
    };

interface EditableFields {
  schedule?: ScheduleInput;
  prompt?: string;
  name?: string;
  overlap?: OverlapPolicy;
  execution?: ExecutionDraft;
  expires?: string;
  maxRuns?: number;
  tokenBudget?: number;
  unsafeSeconds?: true;
}

export interface CreateInput extends EditableFields {
  schedule: ScheduleInput;
  prompt: string;
}

export type EditableDraft = EditableFields;

export type CommandIntent =
  | { kind: "manager" }
  | { kind: "guided_add" }
  | { kind: "maintenance"; interval: string | undefined }
  | { kind: "create" | "saved_create"; input: CreateInput }
  | { kind: "list" | "saved_list" }
  | { kind: "saved_copy"; selector: string; name?: string }
  | {
      kind: "saved_show" | "saved_delete" | "saved_start";
      selector: string;
    }
  | { kind: "saved_edit"; selector: string; patch: EditableDraft }
  | {
      kind: "show" | "pause" | "resume" | "run" | "delete";
      selector: string;
    }
  | { kind: "stop_all" }
  | { kind: "edit"; selector: string; patch: EditableDraft };

export class CommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandParseError";
  }
}

export function parseCronCommand(raw: string): CommandIntent {
  if (raw.trim() === "") return { kind: "manager" };

  const firstMatch = raw.match(/^\s*(\S+)([\s\S]*)$/);
  if (!firstMatch) return { kind: "manager" };

  const first = firstMatch[1];
  const remainder = firstMatch[2].replace(/^\s+/, "");

  if (DURATION.test(first) && remainder.length > 0) {
    assertSafeRecurring(first);
    return {
      kind: "create",
      input: {
        schedule: { kind: "interval", value: first },
        prompt: remainder,
      },
    };
  }

  if (first === "loop") {
    if (remainder === "") {
      return { kind: "maintenance", interval: undefined };
    }
    if (!DURATION.test(remainder)) {
      throw new CommandParseError("Usage: /cron loop [15m]");
    }
    assertSafeRecurring(remainder);
    return { kind: "maintenance", interval: remainder };
  }

  if (first === "add") {
    return remainder === ""
      ? { kind: "guided_add" }
      : parseStrictAdd(tokenize(remainder));
  }
  if (first === "save") return parseSave(tokenize(remainder));
  if (first === "saved") return parseSaved(tokenize(remainder));
  if (first === "start") {
    const command = parseSelectorCommand("start", tokenize(remainder));
    return { kind: "saved_start", selector: command.selector };
  }

  if (first === "list") return parseList(tokenize(remainder));
  if (["show", "pause", "resume", "run", "delete"].includes(first)) {
    return parseSelectorCommand(
      first as "show" | "pause" | "resume" | "run" | "delete",
      tokenize(remainder),
    );
  }
  if (first === "stop") return parseStop(tokenize(remainder));
  if (first === "edit") return parseEdit(tokenize(remainder));

  return {
    kind: "create",
    input: { schedule: { kind: "adaptive" }, prompt: raw.trim() },
  };
}

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let started = false;

  for (const character of raw) {
    if (escaping) {
      token += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }

  if (quote) throw new CommandParseError("Unclosed quote");
  if (escaping) throw new CommandParseError("Trailing escape");
  if (started) tokens.push(token);
  return tokens;
}

type ParsedFlags = Map<string, string | true>;

function parseFlags(tokens: string[]): ParsedFlags {
  const flags: ParsedFlags = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    if (!flag.startsWith("--")) {
      throw new CommandParseError(`Unexpected argument: ${flag}`);
    }
    if (flags.has(flag)) {
      throw new CommandParseError(`Duplicate flag: ${flag}`);
    }

    if (flag === "--isolated") {
      const possibleModel = tokens[index + 1];
      if (possibleModel !== undefined && !possibleModel.startsWith("--")) {
        flags.set(flag, possibleModel);
        index += 1;
      } else {
        flags.set(flag, true);
      }
      continue;
    }

    if (BOOLEAN_FLAGS.has(flag)) {
      flags.set(flag, true);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new CommandParseError(`Unknown flag: ${flag}`);
    }

    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--") || value === "") {
      throw new CommandParseError(`${flag} requires a value`);
    }
    flags.set(flag, value);
    index += 1;
  }

  return flags;
}

function parseStrictAdd(
  tokens: string[],
  saved = false,
): Extract<CommandIntent, { kind: "create" | "saved_create" }> {
  const flags = parseFlags(tokens);
  const schedule = scheduleFrom(flags, true);
  const prompt = stringFlag(flags, "--prompt");
  if (prompt === undefined) {
    throw new CommandParseError("add requires --prompt");
  }
  return {
    kind: saved ? "saved_create" : "create",
    input: { schedule: schedule as ScheduleInput, prompt, ...draftFrom(flags) },
  };
}

function parseEdit(
  tokens: string[],
  saved = false,
): Extract<CommandIntent, { kind: "edit" | "saved_edit" }> {
  if (tokens.length === 0 || tokens[0] === "" || tokens[0].startsWith("--")) {
    throw new CommandParseError(
      `Usage: /cron ${saved ? "saved edit" : "edit"} <selector> [flags]`,
    );
  }
  const selector = tokens[0];
  const flags = parseFlags(tokens.slice(1));
  const schedule = scheduleFrom(flags, false);
  const patch: EditableDraft = {
    ...(schedule ? { schedule } : {}),
    ...draftFrom(flags),
  };
  if (Object.keys(patch).length === 0) {
    throw new CommandParseError("edit requires at least one field to change");
  }
  return { kind: saved ? "saved_edit" : "edit", selector, patch };
}

function parseSave(tokens: string[]): CommandIntent {
  if (tokens.length === 0 || tokens[0] === "") {
    throw new CommandParseError(
      "Usage: /cron save add [flags] | /cron save <selector> [--name <name>]",
    );
  }
  if (tokens[0] === "add") return parseStrictAdd(tokens.slice(1), true);
  if (tokens[0].startsWith("--")) {
    throw new CommandParseError("Usage: /cron save <selector> [--name <name>]");
  }
  const selector = tokens[0];
  const flags = parseFlags(tokens.slice(1));
  if ([...flags.keys()].some((flag) => flag !== "--name")) {
    throw new CommandParseError("save copy accepts only --name");
  }
  const name = stringFlag(flags, "--name");
  return name === undefined
    ? { kind: "saved_copy", selector }
    : { kind: "saved_copy", selector, name };
}

function parseSaved(tokens: string[]): CommandIntent {
  if (tokens.length === 0) return { kind: "saved_list" };
  const operation = tokens[0];
  if (operation === "edit") return parseEdit(tokens.slice(1), true);
  if (operation === "show" || operation === "delete") {
    const command = parseSelectorCommand(`saved ${operation}`, tokens.slice(1));
    return {
      kind: operation === "show" ? "saved_show" : "saved_delete",
      selector: command.selector,
    };
  }
  throw new CommandParseError(
    "Usage: /cron saved [show <selector> | edit <selector> [flags] | delete <selector>]",
  );
}

function scheduleFrom(
  flags: ParsedFlags,
  required: boolean,
): ScheduleInput | undefined {
  const selected = SCHEDULE_FLAGS.filter((flag) => flags.has(flag));
  if (selected.length !== 1) {
    if (!required && selected.length === 0) return undefined;
    throw new CommandParseError(
      `${required ? "add requires" : "edit accepts"} exactly one schedule flag: --every, --cron, --in, --at, or --adaptive`,
    );
  }

  const flag = selected[0];
  if (flag === "--adaptive") return { kind: "adaptive" };
  const value = stringFlag(flags, flag) as string;
  if (flag === "--every") {
    assertDuration(flag, value);
    if (!flags.has("--unsafe-seconds")) assertSafeRecurring(value);
    return { kind: "interval", value };
  }
  if (flag === "--in") {
    assertDuration(flag, value);
    return { kind: "in", value };
  }
  if (flag === "--cron") return { kind: "cron", value };
  return { kind: "at", value };
}

function draftFrom(flags: ParsedFlags): EditableDraft {
  validateRelationships(flags);

  const draft: EditableDraft = {};
  copyString(flags, "--prompt", draft, "prompt");
  copyString(flags, "--name", draft, "name");
  copyString(flags, "--expires", draft, "expires");

  const overlap = stringFlag(flags, "--overlap");
  if (overlap !== undefined) {
    if (overlap !== "queue" && overlap !== "skip") {
      throw new CommandParseError(`Invalid --overlap: ${overlap}`);
    }
    draft.overlap = overlap;
  }

  if (flags.has("--expires")) {
    assertDuration("--expires", draft.expires as string);
  }
  if (flags.has("--max-runs")) {
    draft.maxRuns = positiveInteger(
      "--max-runs",
      stringFlag(flags, "--max-runs"),
    );
  }
  if (flags.has("--budget")) {
    draft.tokenBudget = positiveInteger(
      "--budget",
      stringFlag(flags, "--budget"),
    );
  }
  if (flags.has("--unsafe-seconds")) draft.unsafeSeconds = true;

  if (flags.has("--main")) {
    draft.execution = { kind: "main" };
  } else if (flags.has("--isolated")) {
    const execution: Extract<ExecutionDraft, { kind: "isolated" }> = {
      kind: "isolated",
    };
    const model = flags.get("--isolated");
    if (typeof model === "string") execution.model = model;

    const effort = stringFlag(flags, "--effort");
    if (effort !== undefined) {
      if (!EFFORTS.has(effort)) {
        throw new CommandParseError(`Invalid --effort: ${effort}`);
      }
      execution.effort = effort as IsolatedExecution["effort"];
    }
    if (flags.has("--notify")) execution.notify = true;

    const timeout = stringFlag(flags, "--timeout");
    if (timeout !== undefined) {
      assertDuration("--timeout", timeout);
      execution.timeout = timeout;
    }
    copyCsv(flags, "--tools", execution, "tools");
    copyCsv(flags, "--skills", execution, "skills");
    copyCsv(flags, "--extensions", execution, "extensions");
    draft.execution = execution;
  }

  return draft;
}

function validateRelationships(flags: ParsedFlags): void {
  if (flags.has("--main") && flags.has("--isolated")) {
    throw new CommandParseError("Choose either --main or --isolated");
  }
  for (const flag of [
    "--effort",
    "--notify",
    "--timeout",
    "--tools",
    "--skills",
    "--extensions",
  ]) {
    if (flags.has(flag) && !flags.has("--isolated")) {
      throw new CommandParseError(`${flag} requires --isolated`);
    }
  }
  if (flags.has("--unsafe-seconds") && !flags.has("--max-runs")) {
    throw new CommandParseError("--unsafe-seconds requires --max-runs");
  }
}

function parseList(tokens: string[]): CommandIntent {
  if (tokens.length !== 0) throw new CommandParseError("Usage: /cron list");
  return { kind: "list" };
}

function parseSelectorCommand<
  K extends
    | "show"
    | "pause"
    | "resume"
    | "run"
    | "delete"
    | "start"
    | "saved show"
    | "saved delete",
>(kind: K, tokens: string[]): { kind: K; selector: string } {
  if (tokens.length !== 1 || tokens[0] === "") {
    throw new CommandParseError(`Usage: /cron ${kind} <selector>`);
  }
  return { kind, selector: tokens[0] };
}

function parseStop(tokens: string[]): CommandIntent {
  if (tokens.length !== 1 || tokens[0] !== "--all") {
    throw new CommandParseError("Usage: /cron stop --all");
  }
  return { kind: "stop_all" };
}

function assertDuration(flag: string, value: string): void {
  if (!DURATION.test(value)) {
    throw new CommandParseError(`${flag} requires a duration such as 15m`);
  }
}

function assertSafeRecurring(value: string): void {
  if (value.endsWith("s") && Number.parseInt(value, 10) < 60) {
    throw new CommandParseError(
      "Recurring intervals must be at least 1m; strict add supports bounded --unsafe-seconds",
    );
  }
}

function positiveInteger(flag: string, value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (
    value === undefined ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    throw new CommandParseError(`${flag} requires a positive integer`);
  }
  return parsed;
}

function stringFlag(flags: ParsedFlags, flag: string): string | undefined {
  const value = flags.get(flag);
  return typeof value === "string" ? value : undefined;
}

function copyString<K extends "prompt" | "name" | "expires">(
  flags: ParsedFlags,
  flag: string,
  target: EditableDraft,
  key: K,
): void {
  const value = stringFlag(flags, flag);
  if (value !== undefined) target[key] = value;
}

function copyCsv<
  K extends "tools" | "skills" | "extensions",
  T extends Partial<Record<K, string[]>>,
>(flags: ParsedFlags, flag: string, target: T, key: K): void {
  const value = stringFlag(flags, flag);
  if (value === undefined) return;
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry === "")) {
    throw new CommandParseError(`${flag} requires a non-empty CSV list`);
  }
  target[key] = entries as T[K];
}
