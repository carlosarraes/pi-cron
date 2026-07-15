import { createHash, randomUUID } from "node:crypto";
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STALE_AFTER_MS = 90_000;

export interface LeaseRecord {
  pid: number;
  processStartedAt: string;
  heartbeatAt: string;
  sessionId: string;
}

export type LeaseResult =
  | { owned: true }
  | { owned: false; owner: LeaseRecord };

export interface RuntimeLeaseOptions {
  agentDir?: string;
  clock?: { now(): Date };
  pid?: number;
  processStartedAt?: string;
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Signals that an instance which previously owned a lease observed that its
 * ownership record was removed or replaced. Callers must stop owner-only work.
 */
export class RuntimeLeaseOwnershipLostError extends Error {
  constructor() {
    super("Runtime lease ownership was lost");
    this.name = "RuntimeLeaseOwnershipLostError";
  }
}

/**
 * Owns at most one session lease. heartbeat() and release() are harmless no-ops
 * for contenders which never owned. Once an owner observes a replacement,
 * heartbeat() fails closed with RuntimeLeaseOwnershipLostError; release() will
 * not remove the replacement.
 */
export class RuntimeLease {
  private readonly leaseDir: string;
  private readonly clock: { now(): Date };
  private readonly pid: number;
  private readonly processStartedAt: string;
  private readonly isPidAlive: (pid: number) => boolean;
  private leasePath?: string;
  private record?: LeaseRecord;
  private owned = false;
  private previouslyOwned = false;

  constructor(options: RuntimeLeaseOptions = {}) {
    this.leaseDir = join(
      options.agentDir ?? getAgentDir(),
      "pi-cron",
      "leases",
    );
    this.clock = options.clock ?? { now: () => new Date() };
    this.pid = options.pid ?? process.pid;
    this.processStartedAt =
      options.processStartedAt ??
      new Date(Date.now() - process.uptime() * 1_000).toISOString();
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  }

  async acquire(sessionId: string): Promise<LeaseResult> {
    await mkdir(this.leaseDir, { recursive: true, mode: 0o700 });
    this.leasePath = join(this.leaseDir, hashSessionId(sessionId));
    this.record = this.makeRecord(sessionId);

    try {
      await this.writeExclusive(this.record);
      this.markOwned();
      return { owned: true };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }

    const ownerSnapshot = await this.readOwnerSnapshot();
    if (this.isLive(ownerSnapshot.record)) {
      this.owned = false;
      return { owned: false, owner: ownerSnapshot.record };
    }

    const stalePath = `${this.leasePath}.stale-${this.pid}-${randomUUID()}`;
    try {
      await rename(this.leasePath, stalePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return this.acquire(sessionId);
      throw error;
    }

    const moved = await stat(stalePath);
    if (!isSameFile(ownerSnapshot, moved)) {
      await restoreMovedFile(stalePath, this.leasePath);
      return this.acquire(sessionId);
    }

    try {
      try {
        await this.writeExclusive(this.record);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const winner = await this.readOwner();
        this.owned = false;
        return { owned: false, owner: winner };
      }
      this.markOwned();
      return { owned: true };
    } finally {
      await rm(stalePath, { force: true });
    }
  }

  async heartbeat(): Promise<void> {
    if (!this.owned) {
      if (this.previouslyOwned) throw new RuntimeLeaseOwnershipLostError();
      return;
    }

    const handle = await this.openOwnedFile();
    if (!handle) this.loseOwnership();

    try {
      const current = await readRecordFromHandle(handle);
      if (!this.isOurRecord(current)) this.loseOwnership();

      const next = { ...current, heartbeatAt: this.clock.now().toISOString() };
      await handle.truncate(0);
      await handle.write(JSON.stringify(next), 0, "utf8");
      await handle.sync();
      await this.assertCanonicalFile(handle);
      this.record = next;
    } finally {
      await handle.close();
    }
  }

  async release(): Promise<void> {
    if (!this.owned || !this.leasePath) return;

    let snapshot: LeaseSnapshot;
    try {
      snapshot = await this.readOwnerSnapshot();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.owned = false;
        return;
      }
      throw error;
    }

    if (!this.isOurRecord(snapshot.record)) {
      this.owned = false;
      return;
    }

    const releasePath = `${this.leasePath}.release-${this.pid}-${randomUUID()}`;
    try {
      await rename(this.leasePath, releasePath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      this.owned = false;
      return;
    }

    const moved = await stat(releasePath);
    if (isSameFile(snapshot, moved)) {
      await rm(releasePath, { force: true });
    } else {
      await restoreMovedFile(releasePath, this.leasePath);
    }
    this.owned = false;
  }

  private makeRecord(sessionId: string): LeaseRecord {
    return {
      pid: this.pid,
      processStartedAt: this.processStartedAt,
      heartbeatAt: this.clock.now().toISOString(),
      sessionId,
    };
  }

  private async writeExclusive(record: LeaseRecord): Promise<void> {
    if (!this.leasePath) throw new Error("Lease path is not initialized");

    let handle: FileHandle | undefined;
    try {
      handle = await open(this.leasePath, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } catch (error) {
      if (handle) await rm(this.leasePath, { force: true });
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async readOwner(): Promise<LeaseRecord> {
    if (!this.leasePath) throw new Error("Lease path is not initialized");
    return parseLeaseRecord(await readFile(this.leasePath, "utf8"));
  }

  private async readOwnerSnapshot(): Promise<LeaseSnapshot> {
    if (!this.leasePath) throw new Error("Lease path is not initialized");
    const handle = await open(this.leasePath, "r");
    try {
      const record = await readRecordFromHandle(handle);
      const { dev, ino } = await handle.stat();
      return { record, dev, ino };
    } finally {
      await handle.close();
    }
  }

  private isLive(owner: LeaseRecord): boolean {
    const heartbeatAge =
      this.clock.now().getTime() - new Date(owner.heartbeatAt).getTime();
    return this.isPidAlive(owner.pid) && heartbeatAge <= STALE_AFTER_MS;
  }

  private isOurRecord(record: LeaseRecord): boolean {
    return (
      record.pid === this.record?.pid &&
      record.processStartedAt === this.record.processStartedAt &&
      record.sessionId === this.record.sessionId
    );
  }

  private async openOwnedFile(): Promise<FileHandle | undefined> {
    if (!this.leasePath) return undefined;
    try {
      return await open(this.leasePath, "r+");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async assertCanonicalFile(handle: FileHandle): Promise<void> {
    if (!this.leasePath) this.loseOwnership();
    const opened = await handle.stat();
    let canonical: { dev: number; ino: number };
    try {
      canonical = await stat(this.leasePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) this.loseOwnership();
      throw error;
    }
    if (!isSameFile(opened, canonical)) this.loseOwnership();
  }

  private markOwned(): void {
    this.owned = true;
    this.previouslyOwned = true;
  }

  private loseOwnership(): never {
    this.owned = false;
    throw new RuntimeLeaseOwnershipLostError();
  }
}

interface LeaseSnapshot {
  record: LeaseRecord;
  dev: number;
  ino: number;
}

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function isSameFile(
  expected: Pick<LeaseSnapshot, "dev" | "ino">,
  actual: Pick<LeaseSnapshot, "dev" | "ino">,
): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

async function restoreMovedFile(
  movedPath: string,
  leasePath: string,
): Promise<void> {
  try {
    await link(movedPath, leasePath);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return;
    throw error;
  }
  await rm(movedPath, { force: true });
}

async function readRecordFromHandle(handle: FileHandle): Promise<LeaseRecord> {
  return parseLeaseRecord(await handle.readFile("utf8"));
}

function parseLeaseRecord(value: string): LeaseRecord {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pid" in parsed) ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    !("processStartedAt" in parsed) ||
    !isTimestamp(parsed.processStartedAt) ||
    !("heartbeatAt" in parsed) ||
    !isTimestamp(parsed.heartbeatAt) ||
    !("sessionId" in parsed) ||
    typeof parsed.sessionId !== "string"
  ) {
    throw new Error("Invalid runtime lease record");
  }
  return parsed as LeaseRecord;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    if (isNodeError(error, "EPERM")) return true;
    throw error;
  }
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
