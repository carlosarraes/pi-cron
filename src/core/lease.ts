import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  type FileHandle,
  link,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STALE_AFTER_MS = 90_000;
const DEFAULT_OPERATION_LOCK_MAX_ATTEMPTS = 100;
const DEFAULT_OPERATION_LOCK_RETRY_MS = 5;

export interface LeaseRecord {
  pid: number;
  processStartedAt: string;
  heartbeatAt: string;
  sessionId: string;
}

export type LeaseResult =
  | { owned: true }
  | { owned: false; owner: LeaseRecord };

export type LeaseOperation = "acquire" | "heartbeat" | "release";

export interface RuntimeLeaseOptions {
  agentDir?: string;
  clock?: { now(): Date };
  pid?: number;
  processStartedAt?: string;
  isPidAlive?: (pid: number) => boolean;
  operationLockMaxAttempts?: number;
  operationLockRetryMs?: number;
  tokenFactory?: () => string;
  hooks?: {
    afterOperationLockAcquired?: (
      operation: LeaseOperation,
    ) => void | Promise<void>;
    beforeCanonicalPublish?: (
      operation: "claim" | "heartbeat",
    ) => void | Promise<void>;
  };
}

/**
 * Signals that an instance which previously owned a lease can no longer prove
 * ownership. Callers must stop owner-only work.
 */
export class RuntimeLeaseOwnershipLostError extends Error {
  constructor(cause?: unknown) {
    super(
      "Runtime lease ownership was lost",
      cause === undefined ? undefined : { cause },
    );
    this.name = "RuntimeLeaseOwnershipLostError";
  }
}

/**
 * Owns at most one session lease. Contenders which never owned may call
 * heartbeat() and release() as no-ops. A previous owner fails closed from
 * heartbeat() when ownership cannot be proven; release() never removes a
 * replacement lease.
 */
export class RuntimeLease {
  private readonly leaseDir: string;
  private readonly clock: { now(): Date };
  private readonly pid: number;
  private readonly processStartedAt: string;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly operationLockMaxAttempts: number;
  private readonly operationLockRetryMs: number;
  private readonly tokenFactory: () => string;
  private readonly hooks: NonNullable<RuntimeLeaseOptions["hooks"]>;
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
    this.operationLockMaxAttempts =
      options.operationLockMaxAttempts ?? DEFAULT_OPERATION_LOCK_MAX_ATTEMPTS;
    this.operationLockRetryMs =
      options.operationLockRetryMs ?? DEFAULT_OPERATION_LOCK_RETRY_MS;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.hooks = options.hooks ?? {};
  }

  async acquire(sessionId: string): Promise<LeaseResult> {
    if (this.owned)
      throw new Error("RuntimeLease already owns a session lease");
    await this.prepareLeaseDirectory();
    const leasePath = join(this.leaseDir, hashSessionId(sessionId));
    const record = this.makeRecord(sessionId);
    this.leasePath = leasePath;
    this.record = record;

    return this.withOperationLock("acquire", async () => {
      try {
        await this.publishExclusive(leasePath, record);
        this.markOwned();
        return { owned: true };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }

      const ownerSnapshot = await readLeaseSnapshot(leasePath);
      if (this.isLive(ownerSnapshot.record)) {
        return { owned: false, owner: ownerSnapshot.record };
      }

      const stalePath = `${leasePath}.stale-${this.pid}-${this.tokenFactory()}`;
      await rename(leasePath, stalePath);
      const movedSnapshot = await readLeaseSnapshot(stalePath);
      if (
        !isSameFile(ownerSnapshot, movedSnapshot) ||
        !isSameLeaseRecord(ownerSnapshot.record, movedSnapshot.record)
      ) {
        await restoreMovedFile(stalePath, leasePath);
        const current = await readLeaseSnapshot(leasePath);
        return { owned: false, owner: current.record };
      }

      try {
        await this.publishExclusive(leasePath, record);
        this.markOwned();
        return { owned: true };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const winner = await readLeaseSnapshot(leasePath);
        return { owned: false, owner: winner.record };
      } finally {
        await rm(stalePath, { force: true });
      }
    });
  }

  async heartbeat(): Promise<void> {
    if (!this.owned) {
      if (this.previouslyOwned) this.loseOwnership();
      return;
    }

    const leasePath = this.leasePath;
    if (!leasePath) this.loseOwnership();

    await this.withOperationLock("heartbeat", async () => {
      let current: LeaseSnapshot;
      try {
        current = await readLeaseSnapshot(leasePath);
      } catch (error) {
        this.loseOwnership(error);
      }
      if (!this.isOurRecord(current.record)) {
        this.loseOwnership(
          new Error("Canonical lease belongs to another owner"),
        );
      }

      const next = {
        ...current.record,
        heartbeatAt: this.clock.now().toISOString(),
      };
      await this.publishReplacement(leasePath, next, "heartbeat");
      this.record = next;
    });
  }

  async release(): Promise<void> {
    if (!this.owned || !this.leasePath) return;

    const leasePath = this.leasePath;
    await this.withOperationLock("release", async () => {
      let current: LeaseSnapshot;
      try {
        current = await readLeaseSnapshot(leasePath);
      } catch (error) {
        this.loseOwnership(error);
      }
      if (!this.isOurRecord(current.record)) {
        this.owned = false;
        return;
      }

      const releasePath = `${leasePath}.release-${this.pid}-${this.tokenFactory()}`;
      await rename(leasePath, releasePath);
      const moved = await readLeaseSnapshot(releasePath);
      if (
        isSameFile(current, moved) &&
        isSameLeaseRecord(current.record, moved.record)
      ) {
        await rm(releasePath, { force: true });
      } else {
        await restoreMovedFile(releasePath, leasePath);
      }
      this.owned = false;
    });
  }

  private async prepareLeaseDirectory(): Promise<void> {
    await mkdir(this.leaseDir, { recursive: true, mode: 0o700 });
    await chmod(this.leaseDir, 0o700);
  }

  private makeRecord(sessionId: string): LeaseRecord {
    return {
      pid: this.pid,
      processStartedAt: this.processStartedAt,
      heartbeatAt: this.clock.now().toISOString(),
      sessionId,
    };
  }

  private async publishExclusive(
    path: string,
    record: LeaseRecord,
  ): Promise<void> {
    const temporaryPath = await this.writeCompleteTemporary(path, record);
    try {
      await this.hooks.beforeCanonicalPublish?.("claim");
      await link(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async publishReplacement(
    path: string,
    record: LeaseRecord,
    operation: "heartbeat",
  ): Promise<void> {
    const temporaryPath = await this.writeCompleteTemporary(path, record);
    try {
      await this.hooks.beforeCanonicalPublish?.(operation);
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async writeCompleteTemporary(
    targetPath: string,
    value: LeaseRecord | OperationLockRecord,
  ): Promise<string> {
    const temporaryPath = `${targetPath}.tmp-${this.pid}-${this.tokenFactory()}`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(value), "utf8");
      await handle.sync();
    } catch (error) {
      if (handle) await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      await handle?.close();
    }
    return temporaryPath;
  }

  private async withOperationLock<T>(
    operation: LeaseOperation,
    action: () => Promise<T>,
  ): Promise<T> {
    const operationLock = await this.acquireOperationLock();
    try {
      await this.hooks.afterOperationLockAcquired?.(operation);
      return await action();
    } finally {
      await this.releaseOperationLock(operationLock);
    }
  }

  private async acquireOperationLock(): Promise<OperationLockSnapshot> {
    const lockPath = `${this.leasePath}.lock`;
    let lastError: unknown;

    for (
      let attempt = 0;
      attempt < this.operationLockMaxAttempts;
      attempt += 1
    ) {
      const record: OperationLockRecord = {
        pid: this.pid,
        processStartedAt: this.processStartedAt,
        token: this.tokenFactory(),
      };
      try {
        const temporaryPath = await this.writeCompleteTemporary(
          lockPath,
          record,
        );
        try {
          await link(temporaryPath, lockPath);
        } finally {
          await rm(temporaryPath, { force: true });
        }
        const snapshot = await readOperationLockSnapshot(lockPath);
        if (!isSameOperationLock(record, snapshot.record)) {
          throw new Error("Operation lock ownership could not be verified");
        }
        return snapshot;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }

      let existing: OperationLockSnapshot;
      try {
        existing = await readOperationLockSnapshot(lockPath);
      } catch (error) {
        lastError = error;
        await delay(this.operationLockRetryMs);
        continue;
      }

      if (this.isPidAlive(existing.record.pid)) {
        lastError = new Error(
          "Runtime lease operation lock is held by a live process",
        );
        await delay(this.operationLockRetryMs);
        continue;
      }

      const stalePath = `${lockPath}.dead-${this.pid}-${this.tokenFactory()}`;
      try {
        await rename(lockPath, stalePath);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      const moved = await readOperationLockSnapshot(stalePath);
      if (
        !isSameFile(existing, moved) ||
        !isSameOperationLock(existing.record, moved.record)
      ) {
        await restoreMovedFile(stalePath, lockPath);
        lastError = new Error(
          "Operation lock changed during dead-owner recovery",
        );
        await delay(this.operationLockRetryMs);
        continue;
      }
      await rm(stalePath, { force: true });
    }

    throw new Error("Runtime lease operation lock unavailable", {
      cause: lastError,
    });
  }

  private async releaseOperationLock(
    ownedLock: OperationLockSnapshot,
  ): Promise<void> {
    const lockPath = `${this.leasePath}.lock`;
    const releasePath = `${lockPath}.release-${this.pid}-${this.tokenFactory()}`;
    await rename(lockPath, releasePath);
    const moved = await readOperationLockSnapshot(releasePath);
    if (
      !isSameFile(ownedLock, moved) ||
      !isSameOperationLock(ownedLock.record, moved.record)
    ) {
      await restoreMovedFile(releasePath, lockPath);
      throw new Error("Runtime lease operation lock ownership was lost");
    }
    await rm(releasePath, { force: true });
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

  private markOwned(): void {
    this.owned = true;
    this.previouslyOwned = true;
  }

  private loseOwnership(cause?: unknown): never {
    this.owned = false;
    throw new RuntimeLeaseOwnershipLostError(cause);
  }
}

interface OperationLockRecord {
  pid: number;
  processStartedAt: string;
  token: string;
}

interface FileSnapshot {
  dev: number;
  ino: number;
}

interface LeaseSnapshot extends FileSnapshot {
  record: LeaseRecord;
}

interface OperationLockSnapshot extends FileSnapshot {
  record: OperationLockRecord;
}

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

async function readLeaseSnapshot(path: string): Promise<LeaseSnapshot> {
  const handle = await open(path, "r");
  try {
    const record = parseLeaseRecord(await handle.readFile("utf8"));
    const { dev, ino } = await handle.stat();
    return { record, dev, ino };
  } finally {
    await handle.close();
  }
}

async function readOperationLockSnapshot(
  path: string,
): Promise<OperationLockSnapshot> {
  const handle = await open(path, "r");
  try {
    const record = parseOperationLockRecord(await handle.readFile("utf8"));
    const { dev, ino } = await handle.stat();
    return { record, dev, ino };
  } finally {
    await handle.close();
  }
}

function isSameFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSameLeaseRecord(left: LeaseRecord, right: LeaseRecord): boolean {
  return (
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.heartbeatAt === right.heartbeatAt &&
    left.sessionId === right.sessionId
  );
}

function isSameOperationLock(
  left: OperationLockRecord,
  right: OperationLockRecord,
): boolean {
  return (
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.token === right.token
  );
}

async function restoreMovedFile(
  movedPath: string,
  canonicalPath: string,
): Promise<void> {
  try {
    await link(movedPath, canonicalPath);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return;
    throw error;
  }
  await rm(movedPath, { force: true });
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
    !isIsoTimestamp(parsed.processStartedAt) ||
    !("heartbeatAt" in parsed) ||
    !isIsoTimestamp(parsed.heartbeatAt) ||
    !("sessionId" in parsed) ||
    typeof parsed.sessionId !== "string"
  ) {
    throw new Error("Invalid runtime lease record");
  }
  return parsed as LeaseRecord;
}

function parseOperationLockRecord(value: string): OperationLockRecord {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pid" in parsed) ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    !("processStartedAt" in parsed) ||
    !isIsoTimestamp(parsed.processStartedAt) ||
    !("token" in parsed) ||
    typeof parsed.token !== "string" ||
    parsed.token.length === 0
  ) {
    throw new Error("Invalid runtime lease operation lock record");
  }
  return parsed as OperationLockRecord;
}

function isIsoTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
