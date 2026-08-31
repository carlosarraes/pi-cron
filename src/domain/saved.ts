import { nextOccurrence } from "./schedule.js";
import {
  type CronJob,
  DEFAULT_LIMITS,
  type ExecutionMode,
  type OverlapPolicy,
} from "./types.js";

export const SAVED_DEFINITION_VERSION = 1 as const;
export const SAVED_CATALOG_VERSION = 1 as const;
export const MAX_SAVED_NAME_LENGTH = 100 as const;

export type SavedSchedule =
  | { kind: "interval"; intervalMs: number }
  | { kind: "cron"; expression: string; timezone: string }
  | { kind: "once"; timing: { kind: "relative"; delayMs: number } }
  | { kind: "once"; timing: { kind: "absolute"; at: string } }
  | { kind: "adaptive" }
  | {
      kind: "maintenance";
      cadence: "adaptive" | { intervalMs: number };
    };

export interface SavedCronDefinition {
  version: typeof SAVED_DEFINITION_VERSION;
  id: string;
  name: string;
  prompt: CronJob["prompt"];
  schedule: SavedSchedule;
  execution: ExecutionMode;
  overlap: OverlapPolicy;
  unsafeSeconds: boolean;
  expiresAfterMs: number;
  maxRuns?: number;
  tokenBudget?: number;
  createdAt: string;
  updatedAt: string;
  approval: CronJob["approval"];
}

export interface SavedCronCatalog {
  version: typeof SAVED_CATALOG_VERSION;
  definitions: SavedCronDefinition[];
}

export type ProposedSavedCronDefinition = Omit<SavedCronDefinition, "approval">;
export type SavedDefinitionDraft = Omit<
  ProposedSavedCronDefinition,
  "version" | "id" | "name" | "createdAt" | "updatedAt"
> & { name?: string };
export type SavedDefinitionPatch = Partial<SavedDefinitionDraft>;

export interface SavedDefinitionStore {
  list(): Promise<SavedCronDefinition[]>;
  create(definition: SavedCronDefinition): Promise<void>;
  replace(
    definition: SavedCronDefinition,
    expected: SavedCronDefinition,
  ): Promise<void>;
  delete(id: string): Promise<void>;
}

export class SavedDefinitionConflictError extends Error {
  constructor(id: string) {
    super(`Saved cron definition changed concurrently: ${id}`);
    this.name = "SavedDefinitionConflictError";
  }
}

type UnknownRecord = Record<string, unknown>;

const EFFORT_RANK: Record<
  Extract<ExecutionMode, { kind: "isolated" }>["effort"],
  number
> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

export function assertSavedCatalog(value: unknown): SavedCronCatalog {
  if (!isRecord(value)) throw malformedCatalog();
  if (value.version !== SAVED_CATALOG_VERSION) {
    throw new Error(
      `Unsupported saved cron catalog version: ${String(value.version)}`,
    );
  }
  if (
    !hasOnlyKeys(value, ["version", "definitions"]) ||
    !Array.isArray(value.definitions)
  ) {
    throw malformedCatalog();
  }
  if (value.definitions.length > DEFAULT_LIMITS.maxJobs) {
    throw new Error(
      `Saved cron definitions are limited to ${DEFAULT_LIMITS.maxJobs}`,
    );
  }
  if (!value.definitions.every(isSavedDefinition)) throw malformedCatalog();

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const definition of value.definitions) {
    const id = definition.id.toLowerCase();
    if (ids.has(id)) throw new Error("Duplicate saved cron definition ID");
    ids.add(id);
    const name = definition.name.trim().toLowerCase();
    if (names.has(name))
      throw new Error("Duplicate saved cron definition name");
    names.add(name);
    validateSavedSchedule(definition);
  }
  return {
    version: SAVED_CATALOG_VERSION,
    definitions: structuredClone(value.definitions),
  };
}

export function validateSavedCandidate(
  candidate: ProposedSavedCronDefinition | SavedCronDefinition,
  definitions: Iterable<SavedCronDefinition>,
): void {
  if (!isSavedDefinitionShape(candidate, "approval" in candidate)) {
    throw new Error("Malformed saved cron definition");
  }
  const others = [...definitions].filter((item) => item.id !== candidate.id);
  if (others.length >= DEFAULT_LIMITS.maxJobs) {
    throw new Error(
      `Saved cron definitions are limited to ${DEFAULT_LIMITS.maxJobs}`,
    );
  }
  const normalizedName = candidate.name.trim().toLowerCase();
  if (
    others.some((item) => item.name.trim().toLowerCase() === normalizedName)
  ) {
    throw new Error(
      `A saved cron definition named '${candidate.name}' already exists`,
    );
  }
  validateSavedSchedule(candidate);
}

export function selectSavedDefinition(
  definitions: Iterable<SavedCronDefinition>,
  selector: string,
): SavedCronDefinition {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Saved cron definition selector cannot be empty");
  }
  const candidates = [...definitions];
  const exactId = candidates.find(
    (item) => item.id.toLowerCase() === normalized,
  );
  if (exactId) return structuredClone(exactId);
  const exactNames = candidates.filter(
    (item) => item.name.trim().toLowerCase() === normalized,
  );
  if (exactNames.length === 1) return structuredClone(exactNames[0]);
  if (exactNames.length > 1) {
    throw new Error(`Ambiguous saved cron definition selector: ${selector}`);
  }
  const prefixes = candidates.filter(
    (item) =>
      item.id.toLowerCase().startsWith(normalized) ||
      item.name.trim().toLowerCase().startsWith(normalized),
  );
  if (prefixes.length === 1) return structuredClone(prefixes[0]);
  if (prefixes.length > 1) {
    throw new Error(`Ambiguous saved cron definition selector: ${selector}`);
  }
  throw new Error(`Saved cron definition not found: ${selector}`);
}

export function requiresSavedReapproval(
  before: SavedCronDefinition,
  after: SavedCronDefinition,
): boolean {
  return (
    JSON.stringify(before.prompt) !== JSON.stringify(after.prompt) ||
    savedScheduleRaisesPrivilege(before.schedule, after.schedule) ||
    after.expiresAfterMs > before.expiresAfterMs ||
    raisesLimit(before.maxRuns, after.maxRuns) ||
    raisesLimit(before.tokenBudget, after.tokenBudget) ||
    (!before.unsafeSeconds && after.unsafeSeconds) ||
    (before.overlap === "skip" && after.overlap === "queue") ||
    executionRaisesPrivilege(before.execution, after.execution)
  );
}

function isSavedDefinition(value: unknown): value is SavedCronDefinition {
  return isSavedDefinitionShape(value, true);
}

function isSavedDefinitionShape(
  value: unknown,
  withApproval: boolean,
): value is SavedCronDefinition | ProposedSavedCronDefinition {
  if (!isRecord(value)) return false;
  const keys = [
    "version",
    "id",
    "name",
    "prompt",
    "schedule",
    "execution",
    "overlap",
    "unsafeSeconds",
    "expiresAfterMs",
    "maxRuns",
    "tokenBudget",
    "createdAt",
    "updatedAt",
    ...(withApproval ? ["approval"] : []),
  ];
  return (
    hasOnlyKeys(value, keys) &&
    value.version === SAVED_DEFINITION_VERSION &&
    typeof value.id === "string" &&
    /^[a-z0-9]{8}$/.test(value.id) &&
    typeof value.name === "string" &&
    value.name === value.name.trim() &&
    value.name.length > 0 &&
    value.name.length <= MAX_SAVED_NAME_LENGTH &&
    isPrompt(value.prompt) &&
    isSavedSchedule(value.schedule) &&
    isExecution(value.execution) &&
    (value.overlap === "queue" || value.overlap === "skip") &&
    typeof value.unsafeSeconds === "boolean" &&
    isPositiveSafeInteger(value.expiresAfterMs) &&
    isOptionalPositiveInteger(value, "maxRuns") &&
    isOptionalPositiveInteger(value, "tokenBudget") &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    (!withApproval || isApproval(value.approval))
  );
}

function isSavedSchedule(value: unknown): value is SavedSchedule {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "interval":
      return (
        hasOnlyKeys(value, ["kind", "intervalMs"]) &&
        isPositiveSafeInteger(value.intervalMs)
      );
    case "cron":
      return (
        hasOnlyKeys(value, ["kind", "expression", "timezone"]) &&
        typeof value.expression === "string" &&
        value.expression.trim().length > 0 &&
        typeof value.timezone === "string" &&
        value.timezone.length > 0
      );
    case "once":
      return (
        hasOnlyKeys(value, ["kind", "timing"]) && isOnceTiming(value.timing)
      );
    case "adaptive":
      return hasOnlyKeys(value, ["kind"]);
    case "maintenance":
      return (
        hasOnlyKeys(value, ["kind", "cadence"]) &&
        (value.cadence === "adaptive" ||
          (isRecord(value.cadence) &&
            hasOnlyKeys(value.cadence, ["intervalMs"]) &&
            isPositiveSafeInteger(value.cadence.intervalMs)))
      );
    default:
      return false;
  }
}

function isOnceTiming(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "relative") {
    return (
      hasOnlyKeys(value, ["kind", "delayMs"]) &&
      isPositiveSafeInteger(value.delayMs)
    );
  }
  return (
    value.kind === "absolute" &&
    hasOnlyKeys(value, ["kind", "at"]) &&
    isIsoTimestamp(value.at)
  );
}

function isPrompt(value: unknown): value is CronJob["prompt"] {
  if (!isRecord(value)) return false;
  if (value.kind === "text") {
    return (
      hasOnlyKeys(value, ["kind", "text"]) &&
      typeof value.text === "string" &&
      value.text.length > 0
    );
  }
  if (value.kind === "maintenance") return hasOnlyKeys(value, ["kind"]);
  return (
    value.kind === "command" &&
    hasOnlyKeys(value, ["kind", "name", "args", "source"]) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.args === "string" &&
    (value.source === "skill" || value.source === "prompt")
  );
}

function isExecution(value: unknown): value is ExecutionMode {
  if (!isRecord(value)) return false;
  if (value.kind === "main") return hasOnlyKeys(value, ["kind"]);
  return (
    value.kind === "isolated" &&
    hasOnlyKeys(value, [
      "kind",
      "model",
      "effort",
      "tools",
      "skills",
      "extensions",
      "notify",
      "timeoutMs",
    ]) &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    typeof value.effort === "string" &&
    Object.hasOwn(EFFORT_RANK, value.effort) &&
    isStringArray(value.tools) &&
    isStringArray(value.skills) &&
    isStringArray(value.extensions) &&
    typeof value.notify === "boolean" &&
    isPositiveSafeInteger(value.timeoutMs)
  );
}

function isApproval(value: unknown): value is CronJob["approval"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["approvedAt", "fingerprint"]) &&
    isIsoTimestamp(value.approvedAt) &&
    typeof value.fingerprint === "string" &&
    value.fingerprint.length > 0
  );
}

function validateSavedSchedule(
  candidate: ProposedSavedCronDefinition | SavedCronDefinition,
): void {
  const { schedule } = candidate;
  if (schedule.kind === "cron") {
    nextOccurrence(
      {
        kind: "cron",
        expression: schedule.expression,
        timezone: schedule.timezone,
      },
      new Date(candidate.updatedAt),
    );
    return;
  }
  const intervalMs =
    schedule.kind === "interval"
      ? schedule.intervalMs
      : schedule.kind === "maintenance" && schedule.cadence !== "adaptive"
        ? schedule.cadence.intervalMs
        : undefined;
  if (intervalMs !== undefined && intervalMs < DEFAULT_LIMITS.minRecurringMs) {
    if (!candidate.unsafeSeconds) {
      throw new Error("Sub-minute intervals require unsafeSeconds");
    }
    if (candidate.maxRuns === undefined) {
      throw new Error("Sub-minute intervals require maxRuns");
    }
  }
}

function savedScheduleRaisesPrivilege(
  before: SavedSchedule,
  after: SavedSchedule,
): boolean {
  if (before.kind !== after.kind) return true;
  switch (before.kind) {
    case "interval":
      return after.kind === "interval" && after.intervalMs < before.intervalMs;
    case "cron":
      return (
        after.kind === "cron" &&
        (after.expression !== before.expression ||
          after.timezone !== before.timezone)
      );
    case "once":
      return (
        after.kind === "once" &&
        JSON.stringify(after) !== JSON.stringify(before)
      );
    case "adaptive":
      return false;
    case "maintenance":
      if (after.kind !== "maintenance") return true;
      if (before.cadence === "adaptive" || after.cadence === "adaptive") {
        return before.cadence !== after.cadence;
      }
      return after.cadence.intervalMs < before.cadence.intervalMs;
  }
}

function executionRaisesPrivilege(
  before: ExecutionMode,
  after: ExecutionMode,
): boolean {
  if (before.kind === "isolated" && after.kind === "main") return true;
  if (before.kind === "main" || after.kind === "main") return false;
  return (
    before.model !== after.model ||
    EFFORT_RANK[after.effort] > EFFORT_RANK[before.effort] ||
    (!before.notify && after.notify) ||
    after.timeoutMs > before.timeoutMs ||
    addsEntries(before.tools, after.tools) ||
    addsEntries(before.skills, after.skills) ||
    addsEntries(before.extensions, after.extensions)
  );
}

function raisesLimit(
  before: number | undefined,
  after: number | undefined,
): boolean {
  if (before === undefined) return false;
  return after === undefined || after > before;
}

function addsEntries(before: string[], after: string[]): boolean {
  const existing = new Set(before);
  return after.some((entry) => !existing.has(entry));
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: UnknownRecord,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && keys.has(key),
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOptionalPositiveInteger(value: UnknownRecord, key: string): boolean {
  return !Object.hasOwn(value, key) || isPositiveSafeInteger(value[key]);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function malformedCatalog(): Error {
  return new Error("Malformed saved cron catalog");
}
