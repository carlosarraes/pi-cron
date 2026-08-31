import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectCronStore } from "../../src/core/project-cron-store.js";
import type { SavedCronDefinition } from "../../src/domain/saved.js";

const NOW = "2026-08-28T12:00:00.000Z";
const roots: string[] = [];

function definition(
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
    expiresAfterMs: 604_800_000,
    createdAt: NOW,
    updatedAt: NOW,
    approval: { approvedAt: NOW, fingerprint: "approved" },
    ...overrides,
  };
}

async function workspace(): Promise<{ cwd: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-cron-store-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  return { cwd, agentDir };
}

function makeStore(
  cwd: string,
  agentDir: string,
  overrides: Partial<ConstructorParameters<typeof ProjectCronStore>[0]> = {},
): ProjectCronStore {
  let token = 0;
  return new ProjectCronStore({
    cwd,
    agentDir,
    isProjectTrusted: () => true,
    clock: { now: () => new Date(NOW) },
    pid: 100,
    processStartedAt: "2026-08-28T10:00:00.000Z",
    isPidAlive: () => true,
    lockMaxAttempts: 10,
    lockRetryMs: 1,
    tokenFactory: () => `token-${++token}`,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ProjectCronStore", () => {
  it("treats a missing catalog as empty and returns defensive clones", async () => {
    const { cwd, agentDir } = await workspace();
    const store = makeStore(cwd, agentDir);

    expect(await store.list()).toEqual([]);
    await store.create(definition());
    const listed = await store.list();
    const first = listed[0];
    if (!first) throw new Error("Expected one saved definition");
    first.name = "mutated";
    expect((await store.list())[0]?.name).toBe("Daily report");
  });

  it("writes a versioned, formatted catalog and supports replace and delete", async () => {
    const { cwd, agentDir } = await workspace();
    const store = makeStore(cwd, agentDir);
    await store.create(definition());

    const path = join(cwd, ".pi", "crons.json");
    const bytes = await readFile(path, "utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    expect(JSON.parse(bytes)).toEqual({
      version: 1,
      definitions: [definition()],
    });

    await store.replace(definition({ name: "Updated" }), definition());
    expect((await store.list())[0]?.name).toBe("Updated");
    await store.delete("abcd1234");
    expect(await store.list()).toEqual([]);
  });

  it("rejects a stale replacement instead of overwriting a concurrent update", async () => {
    const { cwd, agentDir } = await workspace();
    const first = makeStore(cwd, agentDir, { pid: 101 });
    const second = makeStore(cwd, agentDir, { pid: 102 });
    const original = definition();
    await first.create(original);
    const firstSnapshot = (await first.list())[0];
    const secondSnapshot = (await second.list())[0];
    await first.replace(
      { ...firstSnapshot, name: "First update" },
      firstSnapshot,
    );

    await expect(
      second.replace({ ...secondSnapshot, overlap: "skip" }, secondSnapshot),
    ).rejects.toThrow("changed concurrently");
    expect((await first.list())[0]).toMatchObject({
      name: "First update",
      overlap: "queue",
    });
  });

  it("rejects every operation for an untrusted project without reading the file", async () => {
    const { cwd, agentDir } = await workspace();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "crons.json"), "not json", "utf8");
    const store = makeStore(cwd, agentDir, { isProjectTrusted: () => false });

    await expect(store.list()).rejects.toThrow("trusted project");
    await expect(store.create(definition())).rejects.toThrow("trusted project");
    await expect(store.replace(definition(), definition())).rejects.toThrow(
      "trusted project",
    );
    await expect(store.delete("abcd1234")).rejects.toThrow("trusted project");
  });

  it("fails closed and preserves malformed or unsupported catalogs", async () => {
    const { cwd, agentDir } = await workspace();
    const catalogPath = join(cwd, ".pi", "crons.json");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const store = makeStore(cwd, agentDir);

    for (const bytes of ["{broken", '{"version":2,"definitions":[]}\n']) {
      await writeFile(catalogPath, bytes, "utf8");
      await expect(store.create(definition())).rejects.toThrow();
      expect(await readFile(catalogPath, "utf8")).toBe(bytes);
    }
  });

  it("rejects duplicate names without replacing valid bytes", async () => {
    const { cwd, agentDir } = await workspace();
    const store = makeStore(cwd, agentDir);
    await store.create(definition());
    const catalogPath = join(cwd, ".pi", "crons.json");
    const before = await readFile(catalogPath, "utf8");

    await expect(
      store.create(definition({ id: "deadbeef", name: "daily REPORT" })),
    ).rejects.toThrow("Duplicate saved cron definition name");
    expect(await readFile(catalogPath, "utf8")).toBe(before);
  });

  it("preserves the previous catalog when publication fails", async () => {
    const { cwd, agentDir } = await workspace();
    const initial = makeStore(cwd, agentDir);
    await initial.create(definition());
    const catalogPath = join(cwd, ".pi", "crons.json");
    const before = await readFile(catalogPath, "utf8");
    const failing = makeStore(cwd, agentDir, {
      hooks: {
        beforeRename: () => {
          throw new Error("publish failed");
        },
      },
    });

    await expect(
      failing.replace(definition({ name: "Lost" }), definition()),
    ).rejects.toThrow("publish failed");
    expect(await readFile(catalogPath, "utf8")).toBe(before);
    expect(
      (await readdir(join(cwd, ".pi"))).filter((name) =>
        name.includes(".tmp-"),
      ),
    ).toEqual([]);
  });

  it("serializes concurrent mutations from separate store instances", async () => {
    const { cwd, agentDir } = await workspace();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const first = makeStore(cwd, agentDir, {
      pid: 101,
      hooks: {
        afterLockAcquired: () => {
          acquired();
          return blocked;
        },
      },
    });
    const second = makeStore(cwd, agentDir, {
      pid: 102,
      lockMaxAttempts: 100,
      lockRetryMs: 2,
    });

    const firstWrite = first.create(definition());
    await acquiredPromise;
    const secondWrite = second.create(
      definition({ id: "deadbeef", name: "Second" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([firstWrite, secondWrite]);

    expect((await first.list()).map((item) => item.id).sort()).toEqual([
      "abcd1234",
      "deadbeef",
    ]);
  });

  it("recovers dead-owner and over-age locks", async () => {
    const { cwd, agentDir } = await workspace();
    const lockPath = await projectLockPath(cwd, agentDir);
    await mkdir(join(agentDir, "pi-cron", "project-locks"), {
      recursive: true,
    });
    const stale = {
      pid: 999,
      processStartedAt: "2026-08-28T01:00:00.000Z",
      acquiredAt: "2026-08-28T11:59:59.000Z",
      token: "stale",
    };

    await writeFile(lockPath, JSON.stringify(stale), "utf8");
    await makeStore(cwd, agentDir, { isPidAlive: () => false }).create(
      definition(),
    );
    expect(await makeStore(cwd, agentDir).list()).toHaveLength(1);

    await writeFile(lockPath, JSON.stringify(stale), "utf8");
    await makeStore(cwd, agentDir, {
      isPidAlive: () => true,
      lockStaleAfterMs: 500,
    }).replace(definition({ name: "Recovered" }), definition());
    expect((await makeStore(cwd, agentDir).list())[0]?.name).toBe("Recovered");
  });

  it("bounds contention on a fresh live lock and includes owner information", async () => {
    const { cwd, agentDir } = await workspace();
    const lockPath = await projectLockPath(cwd, agentDir);
    await mkdir(join(agentDir, "pi-cron", "project-locks"), {
      recursive: true,
    });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 777,
        processStartedAt: "2026-08-28T11:00:00.000Z",
        acquiredAt: NOW,
        token: "owner-token",
      }),
      "utf8",
    );
    const store = makeStore(cwd, agentDir, {
      lockMaxAttempts: 2,
      lockRetryMs: 0,
      isPidAlive: () => true,
    });

    await expect(store.create(definition())).rejects.toThrow(
      /777.*owner-token/,
    );
  });

  it("fences over-age recovery from a validated catalog publication", async () => {
    const { cwd, agentDir } = await workspace();
    let now = new Date(NOW);
    let releaseValidation!: () => void;
    const validationBlocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let validated!: () => void;
    const validatedPromise = new Promise<void>((resolve) => {
      validated = resolve;
    });
    const first = makeStore(cwd, agentDir, {
      pid: 201,
      clock: { now: () => now },
      hooks: {
        afterLockValidated: () => {
          validated();
          return validationBlocked;
        },
      },
    });
    const firstWrite = first.create(definition());
    await validatedPromise;

    now = new Date(Date.parse(NOW) + 31_000);
    let secondSettled = false;
    let recoveryAttempted!: () => void;
    const recoveryAttemptedPromise = new Promise<void>((resolve) => {
      recoveryAttempted = resolve;
    });
    const second = makeStore(cwd, agentDir, {
      pid: 202,
      clock: { now: () => now },
      lockMaxAttempts: 100,
      lockRetryMs: 2,
      lockStaleAfterMs: 30_000,
      hooks: { beforeStaleRecovery: recoveryAttempted },
    });
    const secondWrite = second
      .create(definition({ id: "deadbeef", name: "Winner" }))
      .finally(() => {
        secondSettled = true;
      });
    await recoveryAttemptedPromise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondSettled).toBe(false);

    releaseValidation();
    await Promise.all([firstWrite, secondWrite]);
    expect((await second.list()).map((item) => item.name).sort()).toEqual([
      "Daily report",
      "Winner",
    ]);
  });

  it("does not leak transaction lock artifacts", async () => {
    const { cwd, agentDir } = await workspace();
    const store = makeStore(cwd, agentDir);
    await store.create(definition());
    const lockEntries = await readdir(
      join(agentDir, "pi-cron", "project-locks"),
    );
    expect(
      lockEntries.filter((name) => /\.tmp-|\.dead-|\.release-/.test(name)),
    ).toEqual([]);
    expect(lockEntries).toEqual([]);
  });
});

async function projectLockPath(cwd: string, agentDir: string): Promise<string> {
  const canonical = await realpath(cwd);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return join(agentDir, "pi-cron", "project-locks", hash);
}
