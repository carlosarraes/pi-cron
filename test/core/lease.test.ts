import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type LeaseOperation,
  type LeaseRecord,
  RuntimeLease,
  RuntimeLeaseOwnershipLostError,
} from "../../src/core/lease.js";
import { FakeClock } from "../helpers/fakes.js";

const SESSION_ID = "session/with private details";
const STARTED_AT = "2026-07-15T09:59:00.000Z";
const NOW = "2026-07-15T10:00:00.000Z";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeAgentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-cron-lease-"));
  temporaryDirectories.push(directory);
  return directory;
}

function leasePath(agentDir: string, sessionId = SESSION_ID): string {
  const filename = createHash("sha256").update(sessionId).digest("hex");
  return join(agentDir, "pi-cron", "leases", filename);
}

function makeLease({
  agentDir,
  clock = new FakeClock(new Date(NOW)),
  pid = 101,
  processStartedAt = STARTED_AT,
  isPidAlive = () => true,
  afterOperationLockAcquired,
  beforeCanonicalPublish,
  token = `token-${pid}`,
  operationLockMaxAttempts = 100,
}: {
  agentDir: string;
  clock?: FakeClock;
  pid?: number;
  processStartedAt?: string;
  isPidAlive?: (pid: number) => boolean;
  afterOperationLockAcquired?: (operation: LeaseOperation) => Promise<void>;
  beforeCanonicalPublish?: (operation: "claim" | "heartbeat") => Promise<void>;
  token?: string;
  operationLockMaxAttempts?: number;
}): RuntimeLease {
  return new RuntimeLease({
    agentDir,
    clock,
    pid,
    processStartedAt,
    isPidAlive,
    operationLockRetryMs: 1,
    operationLockMaxAttempts,
    tokenFactory: () => token,
    hooks: { afterOperationLockAcquired, beforeCanonicalPublish },
  });
}

async function readRecord(agentDir: string): Promise<LeaseRecord> {
  return JSON.parse(await readFile(leasePath(agentDir), "utf8"));
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RuntimeLease", () => {
  it("acquires the first lease using a hashed filename", async () => {
    const agentDir = await makeAgentDir();
    const lease = makeLease({ agentDir });

    await expect(lease.acquire(SESSION_ID)).resolves.toEqual({ owned: true });
    await expect(readRecord(agentDir)).resolves.toEqual({
      pid: 101,
      processStartedAt: STARTED_AT,
      heartbeatAt: NOW,
      sessionId: SESSION_ID,
    });
    expect(leasePath(agentDir)).not.toContain(SESSION_ID);
  });

  it("returns the live owner to a second read-only contender", async () => {
    const agentDir = await makeAgentDir();
    const first = makeLease({ agentDir, pid: 101 });
    const second = makeLease({ agentDir, pid: 202 });
    await first.acquire(SESSION_ID);

    await expect(second.acquire(SESSION_ID)).resolves.toEqual({
      owned: false,
      owner: {
        pid: 101,
        processStartedAt: STARTED_AT,
        heartbeatAt: NOW,
        sessionId: SESSION_ID,
      },
    });
    expect((await readRecord(agentDir)).pid).toBe(101);
  });

  it("makes heartbeat and release no-ops for a contender that never owned", async () => {
    const agentDir = await makeAgentDir();
    const first = makeLease({ agentDir, pid: 101 });
    const contender = makeLease({ agentDir, pid: 202 });
    await first.acquire(SESSION_ID);
    await contender.acquire(SESSION_ID);

    await expect(contender.heartbeat()).resolves.toBeUndefined();
    await expect(contender.release()).resolves.toBeUndefined();
    expect((await readRecord(agentDir)).pid).toBe(101);
  });

  it("fails closed when a previous owner observes a replacement", async () => {
    const agentDir = await makeAgentDir();
    const previousOwner = makeLease({ agentDir, pid: 101 });
    await previousOwner.acquire(SESSION_ID);
    await rm(leasePath(agentDir));
    const replacement = makeLease({
      agentDir,
      pid: 202,
      processStartedAt: "2026-07-15T10:01:00.000Z",
    });
    await replacement.acquire(SESSION_ID);

    await expect(previousOwner.heartbeat()).rejects.toBeInstanceOf(
      RuntimeLeaseOwnershipLostError,
    );
    await previousOwner.release();

    expect((await readRecord(agentDir)).pid).toBe(202);
  });

  it("updates the heartbeat while owned", async () => {
    const agentDir = await makeAgentDir();
    const clock = new FakeClock(new Date(NOW));
    const lease = makeLease({ agentDir, clock });
    await lease.acquire(SESSION_ID);

    clock.advanceBy(30_000);
    await lease.heartbeat();

    expect((await readRecord(agentDir)).heartbeatAt).toBe(
      "2026-07-15T10:00:30.000Z",
    );
  });

  it("does not reclaim after a heartbeat completes ahead of stale inspection", async () => {
    const agentDir = await makeAgentDir();
    const clock = new FakeClock(new Date(NOW));
    const heartbeatLocked = deferred();
    const finishHeartbeat = deferred();
    const owner = makeLease({
      agentDir,
      clock,
      pid: 101,
      afterOperationLockAcquired: async (operation) => {
        if (operation === "heartbeat") {
          heartbeatLocked.resolve();
          await finishHeartbeat.promise;
        }
      },
    });
    await owner.acquire(SESSION_ID);
    clock.advanceBy(90_001);
    const contender = makeLease({ agentDir, clock, pid: 202 });

    const heartbeat = owner.heartbeat();
    await heartbeatLocked.promise;
    const acquisition = contender.acquire(SESSION_ID);
    finishHeartbeat.resolve();

    await heartbeat;
    await expect(acquisition).resolves.toMatchObject({
      owned: false,
      owner: { pid: 101, heartbeatAt: "2026-07-15T10:01:30.001Z" },
    });
  });

  it("serializes two simultaneous stale reclaimers", async () => {
    const agentDir = await makeAgentDir();
    const clock = new FakeClock(new Date(NOW));
    const owner = makeLease({ agentDir, clock, pid: 101 });
    await owner.acquire(SESSION_ID);
    clock.advanceBy(90_001);
    const firstLocked = deferred();
    const finishFirst = deferred();
    const first = makeLease({
      agentDir,
      clock,
      pid: 202,
      afterOperationLockAcquired: async (operation) => {
        if (operation === "acquire") {
          firstLocked.resolve();
          await finishFirst.promise;
        }
      },
    });
    const second = makeLease({ agentDir, clock, pid: 303 });

    const firstAcquisition = first.acquire(SESSION_ID);
    await firstLocked.promise;
    const secondAcquisition = second.acquire(SESSION_ID);
    finishFirst.resolve();

    await expect(firstAcquisition).resolves.toEqual({ owned: true });
    await expect(secondAcquisition).resolves.toMatchObject({
      owned: false,
      owner: { pid: 202 },
    });
  });

  it("makes an old heartbeat fail when it races a completed reclaim", async () => {
    const agentDir = await makeAgentDir();
    const clock = new FakeClock(new Date(NOW));
    const owner = makeLease({ agentDir, clock, pid: 101 });
    await owner.acquire(SESSION_ID);
    clock.advanceBy(90_001);
    const reclaimLocked = deferred();
    const finishReclaim = deferred();
    const contender = makeLease({
      agentDir,
      clock,
      pid: 202,
      afterOperationLockAcquired: async (operation) => {
        if (operation === "acquire") {
          reclaimLocked.resolve();
          await finishReclaim.promise;
        }
      },
    });

    const acquisition = contender.acquire(SESSION_ID);
    await reclaimLocked.promise;
    const heartbeat = owner.heartbeat();
    finishReclaim.resolve();

    await expect(acquisition).resolves.toEqual({ owned: true });
    await expect(heartbeat).rejects.toBeInstanceOf(
      RuntimeLeaseOwnershipLostError,
    );
    expect((await readRecord(agentDir)).pid).toBe(202);
  });

  it("serializes release ahead of a racing replacement", async () => {
    const agentDir = await makeAgentDir();
    const releaseLocked = deferred();
    const finishRelease = deferred();
    const owner = makeLease({
      agentDir,
      pid: 101,
      afterOperationLockAcquired: async (operation) => {
        if (operation === "release") {
          releaseLocked.resolve();
          await finishRelease.promise;
        }
      },
    });
    await owner.acquire(SESSION_ID);
    const replacement = makeLease({ agentDir, pid: 202 });

    const release = owner.release();
    await releaseLocked.promise;
    const acquisition = replacement.acquire(SESSION_ID);
    finishRelease.resolve();

    await release;
    await expect(acquisition).resolves.toEqual({ owned: true });
    expect((await readRecord(agentDir)).pid).toBe(202);
  });

  it("keeps the previous complete record visible until heartbeat publication", async () => {
    const agentDir = await makeAgentDir();
    const clock = new FakeClock(new Date(NOW));
    const beforePublish = deferred();
    const finishPublish = deferred();
    const owner = makeLease({
      agentDir,
      clock,
      pid: 101,
      beforeCanonicalPublish: async (operation) => {
        if (operation === "heartbeat") {
          beforePublish.resolve();
          await finishPublish.promise;
        }
      },
    });
    await owner.acquire(SESSION_ID);
    clock.advanceBy(30_000);
    const contender = makeLease({ agentDir, clock, pid: 202 });

    const heartbeat = owner.heartbeat();
    await beforePublish.promise;
    await expect(readRecord(agentDir)).resolves.toMatchObject({
      pid: 101,
      heartbeatAt: NOW,
    });
    const entries = await readdir(join(agentDir, "pi-cron", "leases"));
    const temporaryRecord = entries.find((entry) =>
      entry.startsWith(
        `${createHash("sha256").update(SESSION_ID).digest("hex")}.tmp-`,
      ),
    );
    expect(temporaryRecord).toBeDefined();
    expect(
      JSON.parse(
        await readFile(
          join(agentDir, "pi-cron", "leases", temporaryRecord as string),
          "utf8",
        ),
      ),
    ).toMatchObject({
      pid: 101,
      heartbeatAt: "2026-07-15T10:00:30.000Z",
    });
    const acquisition = contender.acquire(SESSION_ID);
    finishPublish.resolve();

    await heartbeat;
    await expect(acquisition).resolves.toMatchObject({
      owned: false,
      owner: { pid: 101, heartbeatAt: "2026-07-15T10:00:30.000Z" },
    });
  });

  it("publishes only complete canonical records", async () => {
    const agentDir = await makeAgentDir();
    const beforePublish = deferred();
    const finishPublish = deferred();
    const owner = makeLease({
      agentDir,
      pid: 101,
      beforeCanonicalPublish: async (operation) => {
        if (operation === "claim") {
          beforePublish.resolve();
          await finishPublish.promise;
        }
      },
    });
    const contender = makeLease({ agentDir, pid: 202 });

    const firstAcquisition = owner.acquire(SESSION_ID);
    await beforePublish.promise;
    const entries = await readdir(join(agentDir, "pi-cron", "leases"));
    expect(entries).not.toContain(
      createHash("sha256").update(SESSION_ID).digest("hex"),
    );
    const temporaryRecord = entries.find((entry) => entry.includes(".tmp-"));
    expect(temporaryRecord).toBeDefined();
    expect(
      JSON.parse(
        await readFile(
          join(agentDir, "pi-cron", "leases", temporaryRecord as string),
          "utf8",
        ),
      ),
    ).toMatchObject({ pid: 101, sessionId: SESSION_ID });
    const secondAcquisition = contender.acquire(SESSION_ID);
    finishPublish.resolve();

    await expect(firstAcquisition).resolves.toEqual({ owned: true });
    await expect(secondAcquisition).resolves.toMatchObject({
      owned: false,
      owner: { pid: 101 },
    });
  });

  it("removes its lease on release", async () => {
    const agentDir = await makeAgentDir();
    const lease = makeLease({ agentDir });
    await lease.acquire(SESSION_ID);

    await lease.release();

    await expect(stat(leasePath(agentDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reclaims a lease whose heartbeat is older than 90 seconds", async () => {
    const agentDir = await makeAgentDir();
    const firstClock = new FakeClock(new Date(NOW));
    const first = makeLease({ agentDir, clock: firstClock, pid: 101 });
    await first.acquire(SESSION_ID);
    firstClock.advanceBy(90_001);
    const contender = makeLease({
      agentDir,
      clock: firstClock,
      pid: 202,
      processStartedAt: "2026-07-15T10:01:00.000Z",
    });

    await expect(contender.acquire(SESSION_ID)).resolves.toEqual({
      owned: true,
    });
    expect((await readRecord(agentDir)).pid).toBe(202);
  });

  it("reclaims a lease when the owner PID is dead", async () => {
    const agentDir = await makeAgentDir();
    const first = makeLease({ agentDir, pid: 101 });
    await first.acquire(SESSION_ID);
    const checkedPids: number[] = [];
    const contender = makeLease({
      agentDir,
      pid: 202,
      isPidAlive: (pid) => {
        checkedPids.push(pid);
        return false;
      },
    });

    await expect(contender.acquire(SESSION_ID)).resolves.toEqual({
      owned: true,
    });
    expect(checkedPids).toEqual([101]);
    expect((await readRecord(agentDir)).pid).toBe(202);
  });

  it("creates the lease with owner-only permissions", async () => {
    const agentDir = await makeAgentDir();
    const lease = makeLease({ agentDir });

    await lease.acquire(SESSION_ID);

    expect((await stat(leasePath(agentDir))).mode & 0o777).toBe(0o600);
  });

  it("reclaims an operation lock only when its PID is provably dead", async () => {
    const agentDir = await makeAgentDir();
    const path = leasePath(agentDir);
    await mkdir(join(agentDir, "pi-cron", "leases"), { recursive: true });
    await writeFile(
      `${path}.lock`,
      JSON.stringify({
        pid: 909,
        processStartedAt: STARTED_AT,
        token: "abandoned-operation",
      }),
      { mode: 0o600 },
    );
    const checkedPids: number[] = [];
    const lease = makeLease({
      agentDir,
      pid: 202,
      isPidAlive: (pid) => {
        checkedPids.push(pid);
        return false;
      },
    });

    await expect(lease.acquire(SESSION_ID)).resolves.toEqual({ owned: true });
    expect(checkedPids).toContain(909);
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed while an operation lock owner may still be alive", async () => {
    const agentDir = await makeAgentDir();
    const path = leasePath(agentDir);
    await mkdir(join(agentDir, "pi-cron", "leases"), { recursive: true });
    const lockContents = JSON.stringify({
      pid: 909,
      processStartedAt: STARTED_AT,
      token: "live-operation",
    });
    await writeFile(`${path}.lock`, lockContents, { mode: 0o600 });
    const lease = makeLease({
      agentDir,
      pid: 202,
      isPidAlive: () => true,
      operationLockMaxAttempts: 3,
    });

    await expect(lease.acquire(SESSION_ID)).rejects.toThrow(
      "operation lock unavailable",
    );
    await expect(readFile(`${path}.lock`, "utf8")).resolves.toBe(lockContents);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never reclaims an unreadable operation lock", async () => {
    const agentDir = await makeAgentDir();
    const path = leasePath(agentDir);
    await mkdir(join(agentDir, "pi-cron", "leases"), { recursive: true });
    await writeFile(`${path}.lock`, "{", { mode: 0o600 });
    const lease = makeLease({
      agentDir,
      pid: 202,
      isPidAlive: () => false,
      operationLockMaxAttempts: 3,
    });

    await expect(lease.acquire(SESSION_ID)).rejects.toThrow(
      "operation lock unavailable",
    );
    await expect(readFile(`${path}.lock`, "utf8")).resolves.toBe("{");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hardens an existing lease directory to owner-only permissions", async () => {
    const agentDir = await makeAgentDir();
    const leaseDirectory = join(agentDir, "pi-cron", "leases");
    await mkdir(leaseDirectory, { recursive: true });
    await chmod(leaseDirectory, 0o777);

    await makeLease({ agentDir }).acquire(SESSION_ID);

    expect((await stat(leaseDirectory)).mode & 0o777).toBe(0o700);
  });

  it("rejects acquire while the instance already owns a lease", async () => {
    const agentDir = await makeAgentDir();
    const lease = makeLease({ agentDir });
    await lease.acquire(SESSION_ID);

    await expect(lease.acquire("another-session")).rejects.toThrow(
      "already owns",
    );

    expect((await readRecord(agentDir)).sessionId).toBe(SESSION_ID);
  });

  it("clears previous ownership and preserves malformed JSON as the cause", async () => {
    const agentDir = await makeAgentDir();
    const owner = makeLease({ agentDir });
    await owner.acquire(SESSION_ID);
    await writeFile(leasePath(agentDir), "{");

    const error = await owner.heartbeat().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeLeaseOwnershipLostError);
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    await expect(owner.heartbeat()).rejects.toBeInstanceOf(
      RuntimeLeaseOwnershipLostError,
    );
    await expect(readFile(leasePath(agentDir), "utf8")).resolves.toBe("{");
  });

  it.each([
    [
      "invalid shape",
      {
        pid: "101",
        processStartedAt: STARTED_AT,
        heartbeatAt: NOW,
        sessionId: SESSION_ID,
      },
    ],
    [
      "non-ISO timestamp",
      {
        pid: 101,
        processStartedAt: "July 15, 2026",
        heartbeatAt: NOW,
        sessionId: SESSION_ID,
      },
    ],
    [
      "non-canonical ISO timestamp",
      {
        pid: 101,
        processStartedAt: STARTED_AT,
        heartbeatAt: "2026-07-15T10:00:00Z",
        sessionId: SESSION_ID,
      },
    ],
  ])("fails closed for contender encountering %s", async (_name, record) => {
    const agentDir = await makeAgentDir();
    const path = leasePath(agentDir);
    await mkdir(join(agentDir, "pi-cron", "leases"), { recursive: true });
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    const contender = makeLease({ agentDir, pid: 202 });

    await expect(contender.acquire(SESSION_ID)).rejects.toThrow(
      "Invalid runtime lease record",
    );
    await expect(readFile(path, "utf8")).resolves.toBe(JSON.stringify(record));
  });

  it("can release repeatedly without failing or deleting a later owner", async () => {
    const agentDir = await makeAgentDir();
    const first = makeLease({ agentDir, pid: 101 });
    await first.acquire(SESSION_ID);
    await first.release();
    const second = makeLease({ agentDir, pid: 202 });
    await second.acquire(SESSION_ID);

    await expect(first.release()).resolves.toBeUndefined();
    expect((await readRecord(agentDir)).pid).toBe(202);
  });
});
