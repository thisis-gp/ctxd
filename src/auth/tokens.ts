/**
 * Per-user connector tokens for hosted MCP.
 *
 * Admins create named tokens via the /admin dashboard or `ctxd token create`.
 * Tokens are stored hashed (sha256); the raw secret is shown only at creation time.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** A lock older than this is assumed abandoned by a crashed process. */
const STALE_LOCK_MS = 15_000;
/** Don't rewrite lastUsedAt more often than this per token. */
const TOUCH_INTERVAL_MS = 60_000;

export interface TokenRecord {
  id: string;
  /** Display name (person, team, or bot). */
  name: string;
  /** sha256 hex of the raw token. */
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface TokenStoreFile {
  version: 1;
  tokens: TokenRecord[];
}

export interface IssuedToken {
  id: string;
  name: string;
  /** Raw secret — show once; never stored in plaintext. */
  token: string;
  createdAt: string;
}

export class TokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenStoreError";
  }
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function generateRawToken(): string {
  return `ctxd_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export class TokenStore {
  constructor(private readonly filePath: string) {}

  private get lockPath(): string {
    return `${this.filePath}.lock`;
  }

  private async load(): Promise<TokenStoreFile> {
    if (!existsSync(this.filePath)) return { version: 1, tokens: [] };
    const raw = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as TokenStoreFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) {
      throw new TokenStoreError(`Invalid token store at ${this.filePath}`);
    }
    return parsed;
  }

  private async save(data: TokenStoreFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2) + "\n", "utf8");
    try {
      await rename(temp, this.filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "EPERM") {
        await rm(this.filePath, { force: true });
        await rename(temp, this.filePath);
      } else {
        throw err;
      }
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const started = Date.now();
    while (true) {
      try {
        await mkdir(this.lockPath);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
        if (await this.lockIsStale()) {
          // A previous process died holding the lock. Without this, every later
          // create/revoke fails forever until someone deletes the directory by hand.
          await rm(this.lockPath, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        if (Date.now() - started > 5000) {
          throw new TokenStoreError(`Timed out waiting for token store lock at ${this.lockPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async list(): Promise<Omit<TokenRecord, "tokenHash">[]> {
    const data = await this.load();
    return data.tokens.map(({ tokenHash: _h, ...rest }) => rest);
  }

  async create(name: string): Promise<IssuedToken> {
    const trimmed = name.trim();
    if (!trimmed) throw new TokenStoreError("Token name is required.");
    return this.withLock(async () => {
      const data = await this.load();
      const raw = generateRawToken();
      const createdAt = new Date().toISOString();
      const record: TokenRecord = {
        id: randomUUID(),
        name: trimmed,
        tokenHash: hashToken(raw),
        createdAt,
      };
      data.tokens.push(record);
      await this.save(data);
      return { id: record.id, name: record.name, token: raw, createdAt };
    });
  }

  async revoke(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const data = await this.load();
      const row = data.tokens.find((t) => t.id === id);
      if (!row || row.revokedAt) return false;
      row.revokedAt = new Date().toISOString();
      await this.save(data);
      return true;
    });
  }

  private async lockIsStale(): Promise<boolean> {
    try {
      const info = await stat(this.lockPath);
      return Date.now() - info.mtimeMs > STALE_LOCK_MS;
    } catch {
      return false; // vanished underneath us; the next mkdir attempt decides
    }
  }

  /**
   * Verify a raw bearer token.
   *
   * Deliberately lock-free: this is the hot path for every authenticated MCP
   * request, and taking an exclusive filesystem lock here serialized all auth
   * behind one writer. Reads are safe because `save()` swaps the file in
   * atomically via rename, so a reader sees either the old or the new file.
   */
  async verify(rawToken: string): Promise<TokenRecord | undefined> {
    if (!rawToken) return undefined;
    const want = hashToken(rawToken);
    const data = await this.load();
    const row = data.tokens.find((t) => !t.revokedAt && safeEqualHex(t.tokenHash, want));
    if (!row) return undefined;
    const due = this.touchIsDue(row);
    // Callers see an accurate lastUsedAt immediately; persisting it is coalesced.
    row.lastUsedAt = new Date().toISOString();
    if (due) void this.touch(row.id);
    return row;
  }

  private touchIsDue(row: TokenRecord): boolean {
    if (!row.lastUsedAt) return true;
    const last = Date.parse(row.lastUsedAt);
    return Number.isNaN(last) || Date.now() - last > TOUCH_INTERVAL_MS;
  }

  /**
   * Stamp lastUsedAt. Telemetry only, so it is coalesced by TOUCH_INTERVAL_MS,
   * runs off the request path, and can never fail an otherwise valid auth.
   */
  private async touch(id: string): Promise<void> {
    if (this.pendingTouches.has(id)) return;
    this.pendingTouches.add(id);
    try {
      await this.withLock(async () => {
        const data = await this.load();
        const row = data.tokens.find((t) => t.id === id);
        if (!row || !this.touchIsDue(row)) return;
        row.lastUsedAt = new Date().toISOString();
        await this.save(data);
      });
    } catch {
      // Never surface a telemetry write failure to the caller.
    } finally {
      this.pendingTouches.delete(id);
    }
  }

  private readonly pendingTouches = new Set<string>();
}

export function defaultTokenStorePath(dataDir = "./data"): string {
  return path.join(dataDir, "tokens.json");
}
