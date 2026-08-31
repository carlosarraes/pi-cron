import { describe, expect, it } from "vitest";
import {
  materializeSavedDefinition,
  savedDraftFromJob,
  savedDraftFromJobDraft,
  savedPatchFromJobPatch,
} from "../../src/core/saved-conversion.js";
import type { JobDraft } from "../../src/core/service.js";
import type { SavedCronDefinition } from "../../src/domain/saved.js";
import { type CronJob, DEFAULT_LIMITS } from "../../src/domain/types.js";

const NOW = "2026-07-14T12:00:00.000Z";
const OLD = "2026-07-13T12:00:00.000Z";

function saved(
  overrides: Partial<SavedCronDefinition> = {},
): SavedCronDefinition {
  return {
    version: 1,
    id: "abcd1234",
    name: "Daily report",
    prompt: { kind: "text", text: "Summarize progress" },
    schedule: { kind: "interval", intervalMs: 3_600_000 },
    execution: { kind: "main" },
    overlap: "queue",
    unsafeSeconds: false,
    expiresAfterMs: DEFAULT_LIMITS.expiresAfterMs,
    createdAt: NOW,
    updatedAt: NOW,
    approval: { approvedAt: NOW, fingerprint: "approved" },
    ...overrides,
  };
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: "job12345",
    name: "Daily report",
    prompt: { kind: "text", text: "Summarize progress" },
    schedule: { kind: "interval", intervalMs: 60_000, anchorAt: OLD },
    state: "active",
    execution: { kind: "main" },
    overlap: "queue",
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-07-21T12:00:00.000Z",
    maxRuns: 10,
    tokenBudget: 1000,
    runCount: 8,
    attributedTokens: 1234,
    consecutiveFailures: 2,
    skippedRuns: 3,
    lastSettledAt: NOW,
    approval: { approvedAt: NOW, fingerprint: "approved" },
    originSessionId: "session-1",
    ...overrides,
  };
}

describe("saved draft conversion", () => {
  it("strips runtime state and derives copied lifetime", () => {
    const result = savedDraftFromJob(job());

    expect(result).toEqual({
      name: "Daily report",
      prompt: { kind: "text", text: "Summarize progress" },
      schedule: { kind: "interval", intervalMs: 60_000 },
      execution: { kind: "main" },
      overlap: "queue",
      unsafeSeconds: false,
      expiresAfterMs: DEFAULT_LIMITS.expiresAfterMs,
      maxRuns: 10,
      tokenBudget: 1000,
    });
    expect(result).not.toHaveProperty("runCount");
    expect(result).not.toHaveProperty("originSessionId");
  });

  it("uses default expiry and preserves an absolute direct expiry as duration", () => {
    const base: JobDraft = {
      prompt: { kind: "text", text: "Report" },
      schedule: { kind: "interval", intervalMs: 60_000, anchorAt: NOW },
    };
    expect(savedDraftFromJobDraft(base, new Date(NOW)).expiresAfterMs).toBe(
      DEFAULT_LIMITS.expiresAfterMs,
    );
    expect(
      savedDraftFromJobDraft(
        { ...base, expiresAt: "2026-07-15T12:00:00.000Z" },
        new Date(NOW),
      ).expiresAfterMs,
    ).toBe(86_400_000);
  });

  it("preserves relative versus absolute one-shot intent", () => {
    expect(
      savedDraftFromJob(
        job({
          schedule: {
            kind: "once",
            at: "2026-07-14T14:00:00.000Z",
            original: "2h",
          },
        }),
      ).schedule,
    ).toEqual({
      kind: "once",
      timing: { kind: "relative", delayMs: 7_200_000 },
    });
    expect(
      savedDraftFromJob(
        job({
          schedule: {
            kind: "once",
            at: "2026-07-14T14:00:00.000Z",
            original: "2026-07-14T14:00:00.000Z",
          },
        }),
      ).schedule,
    ).toEqual({
      kind: "once",
      timing: { kind: "absolute", at: "2026-07-14T14:00:00.000Z" },
    });
  });

  it("preserves cron expressions and timezones", () => {
    expect(
      savedDraftFromJob(
        job({
          schedule: {
            kind: "cron",
            expression: "0 9 * * 1-5",
            timezone: "America/New_York",
          },
        }),
      ).schedule,
    ).toEqual({
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "America/New_York",
    });
  });

  it("converts adaptive and maintenance schedules without runtime wakeups or anchors", () => {
    expect(
      savedDraftFromJob(
        job({
          schedule: {
            kind: "adaptive",
            nextWakeAt: "2026-07-14T13:00:00.000Z",
            fallbackUsed: true,
          },
        }),
      ).schedule,
    ).toEqual({ kind: "adaptive" });
    expect(
      savedDraftFromJob(
        job({
          schedule: {
            kind: "maintenance",
            cadence: { intervalMs: 3_600_000, anchorAt: OLD },
          },
        }),
      ).schedule,
    ).toEqual({ kind: "maintenance", cadence: { intervalMs: 3_600_000 } });
    expect(
      savedDraftFromJob(
        job({ schedule: { kind: "maintenance", cadence: "adaptive" } }),
      ).schedule,
    ).toEqual({ kind: "maintenance", cadence: "adaptive" });
  });

  it("derives unsafeSeconds and rejects invalid copied lifetimes", () => {
    expect(
      savedDraftFromJob(
        job({
          schedule: { kind: "interval", intervalMs: 30_000, anchorAt: OLD },
        }),
      ).unsafeSeconds,
    ).toBe(true);
    expect(() => savedDraftFromJob(job({ expiresAt: NOW }))).toThrow(
      "Saved cron expiry duration must be a positive safe integer",
    );
  });
});

describe("saved definition materialization", () => {
  it("creates fresh interval anchors and expiry", () => {
    const activated = materializeSavedDefinition(saved(), new Date(NOW));
    expect(activated.schedule).toEqual({
      kind: "interval",
      intervalMs: 3_600_000,
      anchorAt: NOW,
    });
    expect(activated.expiresAt).toBe("2026-07-21T12:00:00.000Z");
  });

  it("resolves relative one-shots from activation and rejects past absolutes", () => {
    expect(
      materializeSavedDefinition(
        saved({
          schedule: {
            kind: "once",
            timing: { kind: "relative", delayMs: 3_600_000 },
          },
        }),
        new Date(NOW),
      ).schedule,
    ).toEqual({
      kind: "once",
      at: "2026-07-14T13:00:00.000Z",
      original: "1h",
    });
    expect(() =>
      materializeSavedDefinition(
        saved({
          schedule: {
            kind: "once",
            timing: { kind: "absolute", at: OLD },
          },
        }),
        new Date(NOW),
      ),
    ).toThrow("Saved absolute one-shot must be in the future");
  });

  it("creates fresh adaptive wakeups and maintenance anchors", () => {
    expect(
      materializeSavedDefinition(
        saved({ schedule: { kind: "adaptive" } }),
        new Date(NOW),
      ).schedule,
    ).toEqual({
      kind: "adaptive",
      nextWakeAt: "2026-07-14T12:01:00.000Z",
      fallbackUsed: false,
    });
    expect(
      materializeSavedDefinition(
        saved({
          schedule: {
            kind: "maintenance",
            cadence: { intervalMs: 3_600_000 },
          },
        }),
        new Date(NOW),
      ).schedule,
    ).toEqual({
      kind: "maintenance",
      cadence: { intervalMs: 3_600_000, anchorAt: NOW },
    });
  });

  it("clones reusable configuration and limits", () => {
    const definition = saved({
      execution: {
        kind: "isolated",
        model: "provider/model",
        effort: "medium",
        tools: ["read"],
        skills: ["review"],
        extensions: ["extension-a"],
        notify: true,
        timeoutMs: 60_000,
      },
      overlap: "skip",
      unsafeSeconds: true,
      maxRuns: 2,
      tokenBudget: 100,
    });
    const draft = materializeSavedDefinition(definition, new Date(NOW));
    expect(draft).toMatchObject({
      name: definition.name,
      execution: definition.execution,
      overlap: "skip",
      unsafeSeconds: true,
      maxRuns: 2,
      tokenBudget: 100,
    });
    if (draft.execution?.kind === "isolated")
      draft.execution.tools.push("write");
    expect(definition.execution).toMatchObject({ tools: ["read"] });
  });
});

describe("saved patch conversion", () => {
  it("converts only present fields and preserves explicit optional limits", () => {
    const patch = savedPatchFromJobPatch(
      {
        name: "Changed",
        schedule: { kind: "interval", intervalMs: 120_000, anchorAt: OLD },
        expiresAt: "2026-07-15T12:00:00.000Z",
        maxRuns: 2,
        tokenBudget: undefined,
        unsafeSeconds: true,
      },
      new Date(NOW),
    );
    expect(patch).toEqual({
      name: "Changed",
      schedule: { kind: "interval", intervalMs: 120_000 },
      expiresAfterMs: 86_400_000,
      maxRuns: 2,
      tokenBudget: undefined,
      unsafeSeconds: true,
    });
    expect(savedPatchFromJobPatch({}, new Date(NOW))).toEqual({});
  });
});
