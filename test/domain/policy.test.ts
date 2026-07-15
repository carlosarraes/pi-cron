import { describe, expect, it } from "vitest";
import {
  requiresReapproval,
  selectJob,
  validateJob,
} from "../../src/domain/policy.js";
import type { CronJob, ProposedJob } from "../../src/domain/types.js";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: "abcd1234",
    name: "Daily report",
    prompt: { kind: "text", text: "Summarize progress" },
    schedule: {
      kind: "interval",
      intervalMs: 3_600_000,
      anchorAt: "2026-07-14T12:00:00.000Z",
    },
    state: "active",
    execution: {
      kind: "isolated",
      model: "model-a",
      effort: "medium",
      tools: ["read"],
      skills: [],
      extensions: [],
      notify: false,
      timeoutMs: 60_000,
    },
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
    expiresAt: "2026-07-21T12:00:00.000Z",
    maxRuns: 10,
    tokenBudget: 1_000,
    runCount: 0,
    attributedTokens: 0,
    consecutiveFailures: 0,
    approval: {
      approvedAt: "2026-07-14T12:00:00.000Z",
      fingerprint: "approved",
    },
    originSessionId: "session-1",
    ...overrides,
  };
}

function proposed(overrides: Partial<CronJob> = {}): ProposedJob {
  const { approval: _approval, ...value } = job(overrides);
  return value;
}

describe("selectJob", () => {
  const jobs = [
    job(),
    job({ id: "abcd5678", name: "Daily cleanup" }),
    job({ id: "ffff0000", name: "Weekly report" }),
  ];

  it("selects trimmed exact IDs and names before unambiguous prefixes", () => {
    expect(selectJob(jobs, " ABCD1234 ").id).toBe("abcd1234");
    expect(selectJob(jobs, " daily REPORT ").id).toBe("abcd1234");
    expect(selectJob(jobs, " ffff ").id).toBe("ffff0000");
    expect(selectJob(jobs, " weekly ").id).toBe("ffff0000");
  });

  it("normalizes names already stored with surrounding whitespace", () => {
    expect(selectJob([job({ name: "  Padded  " })], " padded ").id).toBe(
      "abcd1234",
    );
  });

  it("prefers an exact ID over another job's matching name", () => {
    const idMatch = job({ id: "abcd1234", name: "Primary" });
    const nameMatch = job({ id: "ffff0000", name: "ABCD1234" });

    expect(selectJob([nameMatch, idMatch], "abcd1234").id).toBe(idMatch.id);
  });

  it("rejects ambiguous and missing prefixes", () => {
    expect(() => selectJob(jobs, "abcd")).toThrow("Ambiguous job selector");
    expect(() => selectJob(jobs, "missing")).toThrow("Cron job not found");
  });
});

describe("validateJob", () => {
  it("enforces the 50-job cap", () => {
    const existing = Array.from({ length: 50 }, (_, index) =>
      job({ id: `job-${index}`, name: `job ${index}` }),
    );

    expect(() =>
      validateJob(proposed({ id: "new", name: "new" }), existing),
    ).toThrow("50");
  });

  it("rejects duplicate names case-insensitively while allowing self replacement", () => {
    const existing = [job()];

    expect(() =>
      validateJob(proposed({ id: "other", name: "DAILY REPORT" }), existing),
    ).toThrow("already exists");
    expect(() =>
      validateJob(proposed({ name: "DAILY REPORT" }), existing),
    ).not.toThrow();
  });
});

describe("requiresReapproval", () => {
  it("does not let command prompt delimiters hide a prompt change", () => {
    const before = job({
      prompt: { kind: "command", name: "a", args: "b:c", source: "skill" },
    });
    const after = job({
      prompt: { kind: "command", name: "a:b", args: "c", source: "skill" },
    });

    expect(requiresReapproval(before, after)).toBe(true);
  });

  it.each([
    ["faster cron", { kind: "cron", expression: "0 9 * * *", timezone: "UTC" }],
    ["slower cron", { kind: "cron", expression: "0 9 * * 1", timezone: "UTC" }],
    [
      "timezone-only cron edit",
      { kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/London" },
    ],
    [
      "schedule-kind transition",
      {
        kind: "interval",
        intervalMs: 86_400_000,
        anchorAt: "2026-07-14T12:00:00.000Z",
      },
    ],
  ] as const)("fails closed for %s", (_label, schedule) => {
    const before = job({
      schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "UTC" },
    });
    expect(requiresReapproval(before, job({ schedule }))).toBe(true);
  });

  it("does not reapprove an identical cron definition", () => {
    const schedule = {
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "UTC",
    } as const;
    expect(
      requiresReapproval(job({ schedule }), job({ schedule: { ...schedule } })),
    ).toBe(false);
  });

  it.each([
    [
      "one-shot timing",
      { kind: "once", at: "2026-07-15T13:00:00.000Z", original: "tomorrow" },
      { kind: "once", at: "2026-07-15T14:00:00.000Z", original: "tomorrow" },
    ],
    [
      "adaptive timing",
      {
        kind: "adaptive",
        nextWakeAt: "2026-07-15T13:00:00.000Z",
        fallbackUsed: false,
      },
      {
        kind: "adaptive",
        nextWakeAt: "2026-07-15T14:00:00.000Z",
        fallbackUsed: false,
      },
    ],
  ] as const)("reapproves %s changes", (_label, before, after) => {
    expect(
      requiresReapproval(job({ schedule: before }), job({ schedule: after })),
    ).toBe(true);
  });

  it.each([
    ["prompt change", { prompt: { kind: "text", text: "Do more" } }],
    [
      "faster cadence",
      {
        schedule: {
          kind: "interval",
          intervalMs: 1_800_000,
          anchorAt: "2026-07-14T12:00:00.000Z",
        },
      },
    ],
    ["longer expiry", { expiresAt: "2026-07-22T12:00:00.000Z" }],
    ["larger max-runs cap", { maxRuns: 11 }],
    ["larger token cap", { tokenBudget: 1_001 }],
    ["removed max-runs cap", { maxRuns: undefined }],
    ["removed token cap", { tokenBudget: undefined }],
    ["main-mode escalation", { execution: { kind: "main" } }],
    ["notify enablement", { execution: { ...job().execution, notify: true } }],
    [
      "added tools",
      { execution: { ...job().execution, tools: ["read", "bash"] } },
    ],
    ["added skills", { execution: { ...job().execution, skills: ["review"] } }],
    [
      "added extensions",
      { execution: { ...job().execution, extensions: ["ext"] } },
    ],
    ["model change", { execution: { ...job().execution, model: "model-b" } }],
    ["effort increase", { execution: { ...job().execution, effort: "high" } }],
    [
      "timeout increase",
      { execution: { ...job().execution, timeoutMs: 120_000 } },
    ],
  ] as const)("requires approval for %s", (_label, change) => {
    const before = job();
    expect(requiresReapproval(before, job(change as Partial<CronJob>))).toBe(
      true,
    );
  });

  it.each([
    ["rename", { name: "Renamed" }],
    ["pause", { state: "paused" }],
    [
      "slower cadence",
      {
        schedule: {
          kind: "interval",
          intervalMs: 7_200_000,
          anchorAt: "2026-07-14T12:00:00.000Z",
        },
      },
    ],
    ["shorter expiry", { expiresAt: "2026-07-20T12:00:00.000Z" }],
    ["smaller max-runs cap", { maxRuns: 9 }],
    ["smaller token cap", { tokenBudget: 999 }],
    [
      "reduced resources and limits",
      {
        execution: {
          ...job().execution,
          effort: "low",
          tools: [],
          timeoutMs: 30_000,
        },
      },
    ],
  ] as const)("does not require approval for %s", (_label, change) => {
    const before = job();
    expect(requiresReapproval(before, job(change as Partial<CronJob>))).toBe(
      false,
    );
  });

  it("allows main-to-isolated and notify disablement without approval", () => {
    expect(
      requiresReapproval(job({ execution: { kind: "main" } }), job()),
    ).toBe(false);
    const isolated = job().execution as Extract<
      CronJob["execution"],
      { kind: "isolated" }
    >;
    const notifying = job({
      execution: { ...isolated, notify: true },
    });
    expect(requiresReapproval(notifying, job())).toBe(false);
  });
});
