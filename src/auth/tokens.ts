/**
 * Per-user connector tokens for hosted MCP.
 *
 * Admins create named tokens via the /admin dashboard or `ctxd token create`.
 * Tokens are stored hashed (sha256); the raw secret is shown only at creation time.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";

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

  /** Verify a raw bearer token; updates lastUsedAt on success. */
  async verify(rawToken: string): Promise<TokenRecord | undefined> {
    if (!rawToken) return undefined;
    return this.withLock(async () => {
      const want = hashToken(rawToken);
      const data = await this.load();
      const row = data.tokens.find((t) => !t.revokedAt && safeEqualHex(t.tokenHash, want));
      if (!row) return undefined;
      row.lastUsedAt = new Date().toISOString();
      await this.save(data);
      return row;
    });
  }
}

export function defaultTokenStorePath(dataDir = "./data"): string {
  return path.join(dataDir, "tokens.json");
}
