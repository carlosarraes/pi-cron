import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import {
  assertSavedCatalog,
  type SavedCronCatalog,
  type SavedCronDefinition,
  type SavedDefinitionStore,
} from "../domain/saved.js";

const DEFAULT_LOCK_MAX_ATTEMPTS = 100;
const DEFAULT_LOCK_RETRY_MS = 5;
const DEFAULT_LOCK_STALE_AFTER_MS = 30_000;

interface LockRecord {
  pid: number;
  processStartedAt: string;
  acquiredAt: string;
  token: string;
}

interface FileSnapshot {
  dev: number;
  ino: number;
}

interface LockSnapshot extends FileSnapshot {
  record: LockRecord;
}

export interface ProjectCronStoreOptions {
  cwd: string;
  agentDir: string;
  isProjectTrusted: () => boolean;
  clock?: { now(): Date };
  pid?: number;
  processStartedAt?: string;
  isPidAlive?: (pid: number) => boolean;
  lockMaxAttempts?: number;
  lockRetryMs?: number;
  lockStaleAfterMs?: number;
  tokenFactory?: () => string;
  hooks?: {
    afterLockAcquired?: () => void | Promise<void>;
    beforeRename?: () => void | Promise<void>;
    beforeStaleRecovery?: () => void | Promise<void>;
    afterLockValidated?: () => void | Promise<void>;
  };
}

export class ProjectCronStore implements SavedDefinitionStore {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly isProjectTrusted: () => boolean;
  private readonly clock: { now(): Date };
  private readonly pid: number;
  private readonly processStartedAt: string;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly lockMaxAttempts: number;
  private readonly lockRetryMs: number;
  private readonly lockStaleAfterMs: number;
  private readonly tokenFactory: () => string;
  private readonly hooks: NonNullable<ProjectCronStoreOptions["hooks"]>;
  private pathsPromise?: Promise<StorePaths>;

  constructor(options: ProjectCronStoreOptions) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir;
    this.isProjectTrusted = options.isProjectTrusted;
    this.clock = options.clock ?? { now: () => new Date() };
    this.pid = options.pid ?? process.pid;
    this.processStartedAt =
      options.processStartedAt ??
      new Date(Date.now() - process.uptime() * 1_000).toISOString();
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.lockMaxAttempts = options.lockMaxAttempts ?? DEFAULT_LOCK_MAX_ATTEMPTS;
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.lockStaleAfterMs =
      options.lockStaleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.hooks = options.hooks ?? {};
  }

  async list(): Promise<SavedCronDefinition[]> {
    this.requireTrustedProject();
    const { catalogPath } = await this.paths();
    return structuredClone((await readCatalog(catalogPath)).definitions);
  }

  async create(definition: SavedCronDefinition): Promise<void> {
    await this.mutate((catalog) => ({
      version: 1,
      definitions: [...catalog.definitions, structuredClone(definition)],
    }));
  }

  async replace(definition: SavedCronDefinition): Promise<void> {
    await this.mutate((catalog) => {
      const index = catalog.definitions.findIndex(
        (candidate) => candidate.id === definition.id,
      );
      if (index === -1) {
        throw new Error(`Saved cron definition not found: ${definition.id}`);
      }
      const definitions = structuredClone(catalog.definitions);
      definitions[index] = structuredClone(definition);
      return { version: 1, definitions };
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate((catalog) => {
      const definitions = catalog.definitions.filter(
        (definition) => definition.id !== id,
      );
      if (definitions.length === catalog.definitions.length) {
        throw new Error(`Saved cron definition not found: ${id}`);
      }
      return { version: 1, definitions };
    });
  }

  private async mutate(
    mutation: (catalog: SavedCronCatalog) => SavedCronCatalog,
  ): Promise<void> {
    this.requireTrustedProject();
    const paths = await this.paths();
    await this.withLock(paths, async (lock) => {
      const current = await readCatalog(paths.catalogPath);
      const next = assertSavedCatalog(mutation(current));
      await this.writeCatalog(paths, next, lock);
    });
  }

  private async paths(): Promise<StorePaths> {
    this.pathsPromise ??= this.resolvePaths();
    return this.pathsPromise;
  }

  private async resolvePaths(): Promise<StorePaths> {
    const canonicalCwd = await realpath(this.cwd);
    const projectDir = join(canonicalCwd, ".pi");
    const lockDir = join(this.agentDir, "pi-cron", "project-locks");
    const projectHash = createHash("sha256").update(canonicalCwd).digest("hex");
    return {
      projectDir,
      catalogPath: join(projectDir, "crons.json"),
      lockDir,
      lockPath: join(lockDir, projectHash),
      publicationLockPath: join(lockDir, `${projectHash}.publish`),
    };
  }

  private requireTrustedProject(): void {
    if (!this.isProjectTrusted()) {
      throw new Error("Saved cron definitions require a trusted project");
    }
  }

  private async withLock(
    paths: StorePaths,
    operation: (lock: LockSnapshot) => Promise<void>,
  ): Promise<void> {
    await mkdir(paths.lockDir, { recursive: true, mode: 0o700 });
    await chmod(paths.lockDir, 0o700);
    const lock = await this.acquireLock(
      paths.lockPath,
      paths.publicationLockPath,
    );
    let operationError: unknown;
    try {
      await this.hooks.afterLockAcquired?.();
      await operation(lock);
    } catch (error) {
      operationError = error;
    }

    let releaseError: unknown;
    try {
      await this.releaseLock(paths.lockPath, lock);
    } catch (error) {
      releaseError = error;
    }
    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) throw releaseError;
  }

  private async acquireLock(
    lockPath: string,
    recoveryGuardPath?: string,
  ): Promise<LockSnapshot> {
    let lastOwner: LockRecord | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < this.lockMaxAttempts; attempt += 1) {
      const record: LockRecord = {
        pid: this.pid,
        processStartedAt: this.processStartedAt,
        acquiredAt: this.clock.now().toISOString(),
        token: this.tokenFactory(),
      };
      const temporaryPath = `${lockPath}.tmp-${this.pid}-${record.token}`;
      try {
        await writeSyncedFile(temporaryPath, JSON.stringify(record), 0o600);
        try {
          await link(temporaryPath, lockPath);
        } finally {
          await rm(temporaryPath, { force: true });
        }
        const owned = await readLockSnapshot(lockPath);
        if (!sameLockRecord(record, owned.record)) {
          throw new Error(
            "Project cron catalog lock ownership could not be verified",
          );
        }
        return owned;
      } catch (error) {
        await rm(temporaryPath, { force: true });
        if (!isNodeError(error, "EEXIST")) throw error;
      }

      let existing: LockSnapshot;
      try {
        existing = await readLockSnapshot(lockPath);
        lastOwner = existing.record;
      } catch (error) {
        lastError = error;
        await delay(this.lockRetryMs);
        continue;
      }

      const recoverOverAge = recoveryGuardPath !== undefined;
      if (!this.isStale(existing.record, recoverOverAge)) {
        lastError = new Error(
          "Project cron catalog lock is held by a live owner",
        );
        await delay(this.lockRetryMs);
        continue;
      }

      await this.hooks.beforeStaleRecovery?.();
      const recoveryGuard = recoveryGuardPath
        ? await this.acquireLock(recoveryGuardPath)
        : undefined;
      try {
        let guardedExisting: LockSnapshot;
        try {
          guardedExisting = await readLockSnapshot(lockPath);
        } catch (error) {
          if (isNodeError(error, "ENOENT")) continue;
          throw error;
        }
        if (
          !sameFile(existing, guardedExisting) ||
          !sameLockRecord(existing.record, guardedExisting.record) ||
          !this.isStale(guardedExisting.record, recoverOverAge)
        ) {
          lastError = new Error(
            "Project cron catalog lock changed during recovery",
          );
          await delay(this.lockRetryMs);
          continue;
        }

        const stalePath = `${lockPath}.dead-${this.pid}-${this.tokenFactory()}`;
        try {
          await rename(lockPath, stalePath);
        } catch (error) {
          if (isNodeError(error, "ENOENT")) continue;
          throw error;
        }
        try {
          const moved = await readLockSnapshot(stalePath);
          if (
            !sameFile(guardedExisting, moved) ||
            !sameLockRecord(guardedExisting.record, moved.record)
          ) {
            await restoreMovedFile(stalePath, lockPath);
            lastError = new Error(
              "Project cron catalog lock changed during recovery",
            );
            await delay(this.lockRetryMs);
            continue;
          }
          await rm(stalePath, { force: true });
        } catch (error) {
          await restoreMovedFile(stalePath, lockPath);
          throw error;
        }
      } finally {
        if (recoveryGuard && recoveryGuardPath) {
          await this.releaseLock(recoveryGuardPath, recoveryGuard);
        }
      }
    }

    const owner = lastOwner ? `; owner=${JSON.stringify(lastOwner)}` : "";
    throw new Error(`Project cron catalog lock unavailable${owner}`, {
      cause: lastError,
    });
  }

  private isStale(record: LockRecord, recoverOverAge: boolean): boolean {
    if (!this.isPidAlive(record.pid)) return true;
    if (!recoverOverAge) return false;
    const age = this.clock.now().getTime() - Date.parse(record.acquiredAt);
    return age > this.lockStaleAfterMs;
  }

  private async assertLockOwned(
    lockPath: string,
    owned: LockSnapshot,
  ): Promise<void> {
    let current: LockSnapshot;
    try {
      current = await readLockSnapshot(lockPath);
    } catch (error) {
      throw new Error("Project cron catalog lock ownership was lost", {
        cause: error,
      });
    }
    if (
      !sameFile(owned, current) ||
      !sameLockRecord(owned.record, current.record)
    ) {
      throw new Error("Project cron catalog lock ownership was lost");
    }
  }

  private async releaseLock(
    lockPath: string,
    owned: LockSnapshot,
  ): Promise<void> {
    const releasePath = `${lockPath}.release-${this.pid}-${this.tokenFactory()}`;
    try {
      await rename(lockPath, releasePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    const moved = await readLockSnapshot(releasePath);
    if (
      !sameFile(owned, moved) ||
      !sameLockRecord(owned.record, moved.record)
    ) {
      await restoreMovedFile(releasePath, lockPath);
      return;
    }
    await rm(releasePath, { force: true });
  }

  private async writeCatalog(
    paths: StorePaths,
    catalog: SavedCronCatalog,
    lock: LockSnapshot,
  ): Promise<void> {
    await mkdir(paths.projectDir, { recursive: true });
    const temporaryPath = join(
      paths.projectDir,
      `.crons.json.tmp-${this.pid}-${this.tokenFactory()}`,
    );
    try {
      const content = `${JSON.stringify(catalog, null, 2)}\n`;
      await writeSyncedFile(temporaryPath, content, 0o600);
      await this.hooks.beforeRename?.();
      const publicationLock = await this.acquireLock(paths.publicationLockPath);
      try {
        await this.assertLockOwned(paths.lockPath, lock);
        await this.hooks.afterLockValidated?.();
        await rename(temporaryPath, paths.catalogPath);
      } finally {
        await this.releaseLock(paths.publicationLockPath, publicationLock);
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

interface StorePaths {
  projectDir: string;
  catalogPath: string;
  lockDir: string;
  lockPath: string;
  publicationLockPath: string;
}

async function readCatalog(path: string): Promise<SavedCronCatalog> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { version: 1, definitions: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error("Malformed saved cron catalog", { cause: error });
  }
  return assertSavedCatalog(parsed);
}

async function readLockSnapshot(path: string): Promise<LockSnapshot> {
  const handle = await open(path, "r");
  try {
    const record = parseLockRecord(await handle.readFile("utf8"));
    const { dev, ino } = await handle.stat();
    return { record, dev, ino };
  } finally {
    await handle.close();
  }
}

async function writeSyncedFile(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", mode);
    await handle.chmod(mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) await rm(path, { force: true });
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseLockRecord(content: string): LockRecord {
  const parsed: unknown = JSON.parse(content);
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ["pid", "processStartedAt", "acquiredAt", "token"]) ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    !isIsoTimestamp(parsed.processStartedAt) ||
    !isIsoTimestamp(parsed.acquiredAt) ||
    typeof parsed.token !== "string" ||
    parsed.token.length === 0
  ) {
    throw new Error("Invalid project cron catalog lock record");
  }
  return parsed as unknown as LockRecord;
}

async function restoreMovedFile(
  movedPath: string,
  canonicalPath: string,
): Promise<void> {
  try {
    await link(movedPath, canonicalPath);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await rm(movedPath, { force: true });
}

function sameFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLockRecord(left: LockRecord, right: LockRecord): boolean {
  return (
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.acquiredAt === right.acquiredAt &&
    left.token === right.token
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && keys.has(key),
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
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
