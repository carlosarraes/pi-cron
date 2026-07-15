import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
}: {
  agentDir: string;
  clock?: FakeClock;
  pid?: number;
  processStartedAt?: string;
  isPidAlive?: (pid: number) => boolean;
}): RuntimeLease {
  return new RuntimeLease({
    agentDir,
    clock,
    pid,
    processStartedAt,
    isPidAlive,
  });
}

async function readRecord(agentDir: string): Promise<LeaseRecord> {
  return JSON.parse(await readFile(leasePath(agentDir), "utf8"));
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
