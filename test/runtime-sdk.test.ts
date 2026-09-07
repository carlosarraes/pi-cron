import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { AFTER_RUN_COMMAND } from "../src/core/session-handoff.js";
import { CronRuntime } from "../src/runtime.js";
import { FakeClock } from "./helpers/fakes.js";

it.each([
  ["clear", "success"],
  ["compact", "success"],
  ["clear", "failed-with-followup"],
  ["compact", "failed-with-followup"],
  ["clear", "recovered-retry"],
  ["compact", "recovered-retry"],
  ["clear", "retry-with-followup"],
  ["compact", "retry-with-followup"],
  ["clear", "retry-exhausted-followup"],
  ["compact", "retry-exhausted-followup"],
] as const)("SDK: %s after %s preserves the run outcome", async (afterRun, scenario) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cron-sdk-"));
  const clock = new FakeClock(new Date("2026-07-15T10:00:00.000Z"));
  const faux = fauxProvider();
  const models = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: join(cwd, "models.json"),
  });
  models.registerNativeProvider(faux.provider);
  let pi: ExtensionAPI;
  const instances: CronRuntime[] = [];
  const errors: string[] = [];
  faux.setResponses([
    () => {
      if (scenario !== "recovered-retry")
        pi.sendUserMessage("queued follow-up", { deliverAs: "followUp" });
      return scenario === "success"
        ? fauxAssistantMessage("cron finished")
        : fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage:
              scenario !== "failed-with-followup"
                ? "503 Service unavailable"
                : "400 Invalid request",
          });
    },
    scenario === "retry-exhausted-followup"
      ? fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "503 Service unavailable",
        })
      : fauxAssistantMessage("follow-up finished"),
    ...(scenario === "retry-with-followup" ||
    scenario === "retry-exhausted-followup"
      ? [fauxAssistantMessage("queued work finished")]
      : []),
  ]);
  const factory: CreateAgentSessionRuntimeFactory = async ({
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: cwd,
      modelRuntime: models,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 0 },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (api) => {
            pi = api;
            const cron = new CronRuntime(api, {
              clock,
              leaseFactory: () => ({
                acquire: async () => ({ owned: true }),
                heartbeat: async () => {},
                release: async () => {},
              }),
              setInterval: () => 0,
              clearInterval: () => {},
            });
            instances.push(cron);
            api.registerCommand(AFTER_RUN_COMMAND, {
              handler: (token, ctx) => cron.completeAfterRun(token, ctx),
            });
            api.on("session_start", (event, ctx) =>
              cron.start(ctx, event.reason),
            );
            api.on("session_shutdown", (_event, ctx) => cron.stop(ctx));
            api.on("agent_settled", (_event, ctx) => cron.onAgentSettled(ctx));
            api.on("session_before_compact", (event) => ({
              compaction: {
                summary: "Completed cron and queued follow-up.",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            }));
          },
        ],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: faux.getModel(),
        tools: [],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const manager = SessionManager.inMemory(cwd);
  const originalId = manager.getSessionId();
  manager.appendCustomEntry("pi-cron/event", {
    version: 1,
    type: "job_created",
    at: clock.now().toISOString(),
    job: {
      version: 1,
      id: "report01",
      name: "Report",
      prompt: { kind: "text", text: "run report" },
      schedule: {
        kind: "interval",
        intervalMs: 60000,
        anchorAt: clock.now().toISOString(),
      },
      state: "active",
      execution: { kind: "main" },
      afterRun,
      createdAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
      expiresAt: "2026-07-22T10:00:00.000Z",
      maxRuns: 1,
      runCount: 0,
      attributedTokens: 0,
      consecutiveFailures: 0,
      approval: {
        approvedAt: clock.now().toISOString(),
        fingerprint: "approved",
      },
      originSessionId: originalId,
    },
  });
  const host = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir: cwd,
    sessionManager: manager,
  });
  const bind = async () => {
    const session = host.session;
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) => {
        errors.push(error.error);
      },
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (options) => host.newSession(options),
        fork: (id, options) => host.fork(id, options),
        navigateTree: (id, options) => session.navigateTree(id, options),
        switchSession: (path, options) => host.switchSession(path, options),
        reload: () => session.reload(),
      },
    });
  };
  host.setRebindSession(bind);
  try {
    await bind();
    await expect
      .poll(() => instances[0].requireService().get("report01")?.runCount)
      .toBe(1);
    expect(faux.state.callCount).toBe(
      scenario === "retry-with-followup" ||
        scenario === "retry-exhausted-followup"
        ? 3
        : 2,
    );
    const expectedOutcome =
      scenario === "failed-with-followup" ||
      scenario === "retry-exhausted-followup"
        ? "failed"
        : "settled";
    expect(
      instances[0].requireService().get("report01")?.lastTechnicalOutcome,
    ).toBe(expectedOutcome);
    clock.advanceBy(0);
    if (expectedOutcome === "failed") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(host.session.sessionId).toBe(originalId);
      expect(
        manager.getBranch().some((entry) => entry.type === "compaction"),
      ).toBe(false);
    } else if (afterRun === "clear") {
      await expect.poll(() => host.session.sessionId).not.toBe(originalId);
      await expect.poll(() => instances.length).toBe(2);
      await expect
        .poll(() => instances[1].requireService().get("report01")?.runCount)
        .toBe(1);
      expect(
        host.session.sessionManager.buildSessionContext().messages,
      ).toEqual([]);
    } else {
      await expect
        .poll(() =>
          manager.getBranch().some((entry) => entry.type === "compaction"),
        )
        .toBe(true);
      expect(host.session.sessionId).toBe(originalId);
    }
    expect(faux.state.callCount).toBe(
      scenario === "retry-with-followup" ||
        scenario === "retry-exhausted-followup"
        ? 3
        : 2,
    );
    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
