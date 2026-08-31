import {
  type ProposedSavedCronDefinition,
  requiresSavedReapproval,
  type SavedCronDefinition,
  SavedDefinitionConflictError,
  type SavedDefinitionDraft,
  type SavedDefinitionPatch,
  type SavedDefinitionStore,
  selectSavedDefinition,
  validateSavedCandidate,
} from "../domain/saved.js";
import type { ApprovalMode, Clock, CronJob } from "../domain/types.js";
import { savedDraftFromJob } from "./saved-conversion.js";
import type { MutationOptions } from "./service.js";

const MAX_ID_ATTEMPTS = 16;
const MAX_REPLACE_ATTEMPTS = 4;

export interface SavedApprovalPort {
  approve(
    definition: ProposedSavedCronDefinition,
    reason: "create" | "privilege_increase",
    mode: ApprovalMode,
  ): Promise<SavedCronDefinition["approval"] | undefined>;
}

export interface SavedCronServiceOptions {
  store: SavedDefinitionStore;
  approvals: SavedApprovalPort;
  clock: Pick<Clock, "now">;
  idFactory: () => string;
}

export class SavedCronService {
  private readonly store: SavedDefinitionStore;
  private readonly approvals: SavedApprovalPort;
  private readonly clock: Pick<Clock, "now">;
  private readonly idFactory: () => string;

  constructor(options: SavedCronServiceOptions) {
    this.store = options.store;
    this.approvals = options.approvals;
    this.clock = options.clock;
    this.idFactory = options.idFactory;
  }

  async list(): Promise<SavedCronDefinition[]> {
    return structuredClone(await this.store.list());
  }

  async select(selector: string): Promise<SavedCronDefinition> {
    return selectSavedDefinition(await this.store.list(), selector);
  }

  async create(
    draft: SavedDefinitionDraft,
    options: MutationOptions = {},
  ): Promise<SavedCronDefinition> {
    const definitions = await this.store.list();
    const id = this.generateUniqueId(definitions);
    const now = this.clock.now().toISOString();
    const proposed = buildProposedDefinition(draft, id, now);
    validateSavedCandidate(proposed, definitions);

    const approval = await this.approvals.approve(
      structuredClone(proposed),
      "create",
      options.approvalMode ?? "interactive",
    );
    if (!approval) throw new Error("Saved cron definition creation cancelled");

    validateSavedCandidate(proposed, await this.store.list());
    const approved: SavedCronDefinition = {
      ...proposed,
      approval: structuredClone(approval),
    };
    await this.store.create(approved);
    return structuredClone(approved);
  }

  copy(
    job: CronJob,
    name?: string,
    options: MutationOptions = {},
  ): Promise<SavedCronDefinition> {
    const draft = savedDraftFromJob(job);
    if (name !== undefined) draft.name = name;
    return this.create(draft, options);
  }

  async replace(
    selector: string,
    patch: SavedDefinitionPatch,
    options: MutationOptions = {},
  ): Promise<SavedCronDefinition> {
    let stableId: string | undefined;
    for (let attempt = 0; attempt < MAX_REPLACE_ATTEMPTS; attempt += 1) {
      const definitions = await this.store.list();
      const before = selectSavedDefinition(definitions, stableId ?? selector);
      stableId = before.id;
      const after = applyPatch(before, patch, this.clock.now().toISOString());
      const proposed = withoutApproval(after);
      validateSavedCandidate(proposed, definitions);

      if (requiresSavedReapproval(before, after)) {
        const approval = await this.approvals.approve(
          structuredClone(proposed),
          "privilege_increase",
          options.approvalMode ?? "interactive",
        );
        if (!approval) {
          throw new Error("Saved cron definition replacement cancelled");
        }
        after.approval = structuredClone(approval);
      }

      try {
        await this.store.replace(after, before);
        return structuredClone(after);
      } catch (error) {
        if (!(error instanceof SavedDefinitionConflictError)) throw error;
      }
    }
    throw new Error(
      `Saved cron definition changed too frequently to update: ${stableId ?? selector}`,
    );
  }

  async delete(selector: string): Promise<void> {
    const definition = selectSavedDefinition(await this.store.list(), selector);
    await this.store.delete(definition.id);
  }

  private generateUniqueId(definitions: SavedCronDefinition[]): string {
    const existing = new Set(definitions.map((item) => item.id.toLowerCase()));
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = this.idFactory().trim().toLowerCase();
      if (id && !existing.has(id)) return id;
    }
    throw new Error(
      `Unable to generate a unique saved cron definition ID after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }
}

function buildProposedDefinition(
  draft: SavedDefinitionDraft,
  id: string,
  now: string,
): ProposedSavedCronDefinition {
  const proposed: ProposedSavedCronDefinition = {
    version: 1,
    id,
    name: (draft.name ?? `saved-${id}`).trim(),
    prompt: structuredClone(draft.prompt),
    schedule: structuredClone(draft.schedule),
    execution: structuredClone(draft.execution),
    overlap: draft.overlap ?? "queue",
    unsafeSeconds: draft.unsafeSeconds,
    expiresAfterMs: draft.expiresAfterMs,
    createdAt: now,
    updatedAt: now,
  };
  copyOptionalLimit(proposed, draft, "maxRuns");
  copyOptionalLimit(proposed, draft, "tokenBudget");
  return proposed;
}

function applyPatch(
  before: SavedCronDefinition,
  patch: SavedDefinitionPatch,
  now: string,
): SavedCronDefinition {
  const after = structuredClone(before);
  if (Object.hasOwn(patch, "name")) {
    after.name = (patch.name ?? "").trim();
  }
  copyRequiredPatch(after, patch, "prompt");
  copyRequiredPatch(after, patch, "schedule");
  copyRequiredPatch(after, patch, "execution");
  copyRequiredPatch(after, patch, "overlap");
  copyRequiredPatch(after, patch, "unsafeSeconds");
  copyRequiredPatch(after, patch, "expiresAfterMs");
  applyOptionalLimit(after, patch, "maxRuns");
  applyOptionalLimit(after, patch, "tokenBudget");
  after.updatedAt = now;
  return after;
}

function copyRequiredPatch<
  K extends
    | "prompt"
    | "schedule"
    | "execution"
    | "overlap"
    | "unsafeSeconds"
    | "expiresAfterMs",
>(target: SavedCronDefinition, patch: SavedDefinitionPatch, key: K): void {
  if (!Object.hasOwn(patch, key)) return;
  const value = patch[key];
  if (value === undefined) {
    throw new Error(`Saved cron definition ${key} cannot be undefined`);
  }
  target[key] = structuredClone(value) as SavedCronDefinition[K];
}

function applyOptionalLimit(
  target: SavedCronDefinition,
  patch: SavedDefinitionPatch,
  key: "maxRuns" | "tokenBudget",
): void {
  if (!Object.hasOwn(patch, key)) return;
  const value = patch[key];
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function copyOptionalLimit(
  target: ProposedSavedCronDefinition,
  source: SavedDefinitionDraft,
  key: "maxRuns" | "tokenBudget",
): void {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value !== undefined) target[key] = value;
}

function withoutApproval(
  definition: SavedCronDefinition,
): ProposedSavedCronDefinition {
  const { approval: _approval, ...proposed } = definition;
  return proposed;
}
