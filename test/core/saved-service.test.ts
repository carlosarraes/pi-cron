import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  type SavedApprovalPort,
  SavedCronService,
} from "../../src/core/saved-service.js";
import {
  type ProposedSavedCronDefinition,
  type SavedCronDefinition,
  SavedDefinitionConflictError,
  type SavedDefinitionDraft,
  type SavedDefinitionStore,
} from "../../src/domain/saved.js";
import type { CronJob } from "../../src/domain/types.js";
import { FakeClock } from "../helpers/fakes.js";

const NOW = "2026-07-14T12:00:00.000Z";
const APPROVAL = { approvedAt: NOW, fingerprint: "approved" };

class MemorySavedStore implements SavedDefinitionStore {
  definitions: SavedCronDefinition[] = [];
  failure?: string;

  async list(): Promise<SavedCronDefinition[]> {
    return structuredClone(this.definitions);
  }
  async create(definition: SavedCronDefinition): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    this.definitions.push(structuredClone(definition));
  }
  async replace(
    definition: SavedCronDefinition,
    expected: SavedCronDefinition,
  ): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    const index = this.definitions.findIndex(
      (item) => item.id === definition.id,
    );
    if (index < 0) throw new Error("missing");
    if (!isDeepStrictEqual(this.definitions[index], expected)) {
      throw new SavedDefinitionConflictError(definition.id);
    }
    this.definitions[index] = structuredClone(definition);
  }
  async delete(id: string): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    const index = this.definitions.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("missing");
    this.definitions.splice(index, 1);
  }
}

function draft(
  overrides: Partial<SavedDefinitionDraft> = {},
): SavedDefinitionDraft {
  return {
    name: "Daily report",
    prompt: { kind: "text", text: "Summarize progress" },
    schedule: { kind: "interval", intervalMs: 3_600_000 },
    execution: { kind: "main" },
    overlap: "queue",
    unsafeSeconds: false,
    expiresAfterMs: 604_800_000,
    ...overrides,
  };
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: "job00001",
    name: "Current report",
    prompt: { kind: "text", text: "Report" },
    schedule: { kind: "interval", intervalMs: 60_000, anchorAt: NOW },
    state: "active",
    execution: { kind: "main" },
    overlap: "skip",
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-07-21T12:00:00.000Z",
    maxRuns: 12,
    tokenBudget: 5000,
    runCount: 0,
    attributedTokens: 0,
    consecutiveFailures: 0,
    approval: APPROVAL,
    originSessionId: "session-1",
    ...overrides,
  };
}

function setup(
  options: {
    store?: MemorySavedStore;
    approval?: SavedCronDefinition["approval"] | undefined;
    ids?: string[];
  } = {},
) {
  const store = options.store ?? new MemorySavedStore();
  const approve = vi.fn(
    async (
      _definition: ProposedSavedCronDefinition,
      _reason: "create" | "privilege_increase",
      _mode: "interactive" | "automatic",
    ) => (options.approval === undefined ? APPROVAL : options.approval),
  );
  const approvals: SavedApprovalPort = { approve };
  const ids = [...(options.ids ?? ["abcd1234"])];
  const service = new SavedCronService({
    store,
    approvals,
    clock: new FakeClock(new Date(NOW)),
    idFactory: () => ids.shift() ?? "deadbeef",
  });
  return { service, store, approve };
}

describe("SavedCronService", () => {
  it("creates approved definitions with normalized names and automatic approval", async () => {
    const { service, store, approve } = setup();
    const created = await service.create(draft({ name: "  Daily report  " }), {
      approvalMode: "automatic",
    });

    expect(created).toMatchObject({
      version: 1,
      id: "abcd1234",
      name: "Daily report",
      createdAt: NOW,
      updatedAt: NOW,
      approval: APPROVAL,
    });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Daily report" }),
      "create",
      "automatic",
    );
    expect(store.definitions).toEqual([created]);
  });

  it("uses a saved-ID default name and retries colliding generated IDs", async () => {
    const store = new MemorySavedStore();
    const existing = await setup({ store }).service.create(draft());
    expect(existing.id).toBe("abcd1234");
    const { service } = setup({ store, ids: ["abcd1234", "dcba4321"] });

    await expect(
      service.create(draft({ name: undefined })),
    ).resolves.toMatchObject({
      id: "dcba4321",
      name: "saved-dcba4321",
    });
  });

  it("rejects cancellation and leaves the store unchanged", async () => {
    const { store } = setup({ approval: undefined });
    const approvals: SavedApprovalPort = {
      approve: vi.fn(async () => undefined),
    };
    const cancelled = new SavedCronService({
      store,
      approvals,
      clock: new FakeClock(new Date(NOW)),
      idFactory: () => "abcd1234",
    });
    await expect(cancelled.create(draft())).rejects.toThrow(
      "Saved cron definition creation cancelled",
    );
    expect(store.definitions).toEqual([]);
  });

  it("copies reusable configuration without runtime metrics", async () => {
    const { service, store } = setup();
    const copied = await service.copy(
      job({ runCount: 9, attributedTokens: 500, consecutiveFailures: 2 }),
      "Reusable report",
    );
    expect(copied).toMatchObject({
      name: "Reusable report",
      schedule: { kind: "interval", intervalMs: 60_000 },
      expiresAfterMs: 604_800_000,
      maxRuns: 12,
      tokenBudget: 5000,
    });
    expect(store.definitions[0]).not.toHaveProperty("runCount");
    expect(store.definitions[0]).not.toHaveProperty("attributedTokens");
  });

  it("allows copying and editing a past absolute one-shot definition", async () => {
    const { service } = setup();
    const copied = await service.copy(
      job({
        state: "missed",
        schedule: {
          kind: "once",
          at: "2026-07-14T11:00:00.000Z",
          original: "2026-07-14T11:00:00.000Z",
        },
      }),
    );

    await expect(
      service.replace(copied.id, { name: "Past one-shot template" }),
    ).resolves.toMatchObject({ name: "Past one-shot template" });
  });

  it("reuses approval for safe reductions and reapproves privilege increases", async () => {
    const { service, approve } = setup();
    const created = await service.create(draft());
    approve.mockClear();

    const reduced = await service.replace(created.id, {
      expiresAfterMs: 86_400_000,
    });
    expect(reduced.approval).toEqual(APPROVAL);
    expect(approve).not.toHaveBeenCalled();

    const increased = await service.replace(created.id, { overlap: "skip" });
    approve.mockClear();
    await service.replace(
      increased.id,
      { overlap: "queue" },
      { approvalMode: "automatic" },
    );
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ overlap: "queue" }),
      "privilege_increase",
      "automatic",
    );
  });

  it("reapplies a patch to the latest definition after a concurrent edit", async () => {
    const { service, store } = setup();
    const created = await service.create(draft());
    const originalReplace = store.replace.bind(store);
    let conflicted = false;
    store.replace = async (definition, expected) => {
      if (!conflicted) {
        conflicted = true;
        store.definitions[0] = {
          ...store.definitions[0],
          name: "Concurrent name",
        };
        throw new SavedDefinitionConflictError(definition.id);
      }
      return originalReplace(definition, expected);
    };

    const updated = await service.replace(created.id, { overlap: "skip" });

    expect(updated).toMatchObject({ name: "Concurrent name", overlap: "skip" });
    expect(store.definitions[0]).toEqual(updated);
  });

  it("preserves optional values on omission and clears explicit undefined limits", async () => {
    const { service } = setup();
    const created = await service.create(
      draft({ maxRuns: 5, tokenBudget: 100 }),
    );
    const kept = await service.replace(created.id, { overlap: "skip" });
    expect(kept).toMatchObject({ maxRuns: 5, tokenBudget: 100 });
    const cleared = await service.replace(created.id, { maxRuns: undefined });
    expect(cleared).not.toHaveProperty("maxRuns");
    expect(cleared.tokenBudget).toBe(100);
  });

  it("does not mutate stored or returned definitions through aliases", async () => {
    const { service, store } = setup();
    const created = await service.create(draft());
    created.name = "mutated";
    const listed = await service.list();
    listed[0].name = "also mutated";
    expect(store.definitions[0].name).toBe("Daily report");
    expect((await service.select("abcd")).name).toBe("Daily report");
  });

  it("surfaces durable failures without changing the prior definition", async () => {
    const { service, store } = setup();
    const created = await service.create(draft());
    store.failure = "disk full";
    await expect(
      service.replace(created.id, { name: "Changed" }),
    ).rejects.toThrow("disk full");
    expect(store.definitions[0]).toEqual(created);
  });

  it("deletes selected definitions and reports selector errors", async () => {
    const { service, store } = setup();
    await service.create(draft());
    await expect(service.select("missing")).rejects.toThrow(
      "Saved cron definition not found: missing",
    );
    await service.delete("Daily report");
    expect(store.definitions).toEqual([]);
  });
});
