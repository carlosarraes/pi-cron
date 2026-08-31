import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ProposedSavedCronDefinition } from "../../src/domain/saved.js";
import {
  fingerprintSavedDefinition,
  formatSavedApproval,
  UiSavedApprovalPort,
} from "../../src/ui/saved-approval.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");

function proposal(
  overrides: Partial<ProposedSavedCronDefinition> = {},
): ProposedSavedCronDefinition {
  return {
    version: 1,
    id: "abcd1234",
    name: "Daily report",
    prompt: {
      kind: "command",
      name: "review",
      args: "--quick",
      source: "skill",
    },
    schedule: { kind: "interval", intervalMs: 3_600_000 },
    execution: {
      kind: "isolated",
      model: "openai/model-a",
      effort: "medium",
      tools: ["read"],
      skills: ["review"],
      extensions: ["example"],
      notify: false,
      timeoutMs: 60_000,
    },
    overlap: "skip",
    unsafeSeconds: false,
    expiresAfterMs: 604_800_000,
    maxRuns: 10,
    tokenBudget: 5000,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("saved approval formatting", () => {
  it("shows reusable configuration, prompt source, resources, limits, and plaintext warning", () => {
    const definition = proposal();
    const text = formatSavedApproval(definition);
    expect(text).toContain("/review --quick (skill)");
    expect(text).toContain("every 3600000ms");
    expect(text).toContain("Mode: isolated");
    expect(text).toContain("Model: openai/model-a");
    expect(text).toContain("Tools: read");
    expect(text).toContain("Skills: review");
    expect(text).toContain("Extensions: example");
    expect(text).toContain("Overlap: skip");
    expect(text).toContain("Expiry after: 604800000ms");
    expect(text).toContain("Maximum runs: 10");
    expect(text).toContain("Token budget: 5000");
    expect(text).toContain(
      "Plaintext warning: this prompt will be stored in .pi/crons.json and may be committed.",
    );
    expect(text).toContain(fingerprintSavedDefinition(definition));
  });

  it("fingerprints every reusable privileged field and excludes timestamps", () => {
    const base = proposal();
    const fingerprint = fingerprintSavedDefinition(base);
    const variants: ProposedSavedCronDefinition[] = [
      { ...base, name: "Other" },
      { ...base, prompt: { kind: "text", text: "other" } },
      { ...base, schedule: { kind: "adaptive" } },
      { ...base, execution: { kind: "main" } },
      { ...base, overlap: "queue" },
      { ...base, unsafeSeconds: true },
      { ...base, expiresAfterMs: 1 },
      { ...base, maxRuns: 11 },
      { ...base, tokenBudget: 5001 },
    ];
    for (const variant of variants) {
      expect(fingerprintSavedDefinition(variant)).not.toBe(fingerprint);
    }
    expect(
      fingerprintSavedDefinition({
        ...base,
        createdAt: "2026-07-14T13:00:00.000Z",
        updatedAt: "2026-07-14T14:00:00.000Z",
      }),
    ).toBe(fingerprint);
  });
});

describe("UiSavedApprovalPort", () => {
  it("records automatic approval without using UI", async () => {
    const confirm = vi.fn();
    const port = new UiSavedApprovalPort(
      { hasUI: false, ui: { confirm } } as unknown as ExtensionContext,
      () => NOW,
    );
    await expect(
      port.approve(proposal(), "create", "automatic"),
    ).resolves.toEqual({
      approvedAt: NOW.toISOString(),
      fingerprint: fingerprintSavedDefinition(proposal()),
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("records accepted interactive approval and returns undefined on rejection", async () => {
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const port = new UiSavedApprovalPort(
      { hasUI: true, ui: { confirm } } as unknown as ExtensionContext,
      () => NOW,
    );
    await expect(
      port.approve(proposal(), "create", "interactive"),
    ).resolves.toEqual({
      approvedAt: NOW.toISOString(),
      fingerprint: fingerprintSavedDefinition(proposal()),
    });
    await expect(
      port.approve(proposal(), "privilege_increase", "interactive"),
    ).resolves.toBeUndefined();
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      "Save cron definition?",
      expect.stringContaining("Plaintext warning"),
    );
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      "Approve increased saved cron privileges?",
      expect.any(String),
    );
  });

  it("rejects interactive approval without UI", async () => {
    const port = new UiSavedApprovalPort(
      { hasUI: false, ui: {} } as unknown as ExtensionContext,
      () => NOW,
    );
    await expect(
      port.approve(proposal(), "create", "interactive"),
    ).rejects.toThrow("Saved cron mutation requires interactive approval");
  });
});
