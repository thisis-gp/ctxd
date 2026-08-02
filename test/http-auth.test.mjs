import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TokenStore, defaultTokenStorePath, generateRawToken } from "../dist/auth/tokens.js";
import { authorizeAdmin, extractBearer } from "../dist/mcp/http.js";

test("authorizeAdmin accepts Bearer admin token", () => {
  const token = "ctxd_admin_abcdefghijklmnopqrstuvwxyz12";
  assert.equal(authorizeAdmin(`Bearer ${token}`, token), true);
  assert.equal(authorizeAdmin("Bearer wrong", token), false);
});

test("extractBearer strips prefix", () => {
  assert.equal(extractBearer("Bearer abc"), "abc");
  assert.equal(extractBearer(undefined), undefined);
});

test("TokenStore create/list/verify/revoke", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ctxd-tokens-"));
  try {
    const store = new TokenStore(defaultTokenStorePath(dir));
    const issued = await store.create("alice");
    assert.match(issued.token, /^ctxd_/);
    assert.equal((await store.list()).length, 1);

    const ok = await store.verify(issued.token);
    assert.ok(ok);
    assert.equal(ok.name, "alice");
    assert.ok(ok.lastUsedAt);

    assert.equal(await store.verify(generateRawToken()), undefined);

    assert.equal(await store.revoke(issued.id), true);
    assert.equal(await store.verify(issued.token), undefined);
    const listed = await store.list();
    assert.ok(listed[0]?.revokedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TokenStore serializes concurrent token creation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ctxd-tokens-concurrent-"));
  try {
    const store = new TokenStore(defaultTokenStorePath(dir));
    await Promise.all(
      Array.from({ length: 8 }, (_value, index) => store.create(`user-${index}`)),
    );
    const listed = await store.list();
    assert.equal(listed.length, 8);
    assert.deepEqual(
      listed.map((item) => item.name).sort(),
      Array.from({ length: 8 }, (_value, index) => `user-${index}`),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TokenStore.verify is not serialized behind the write lock", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ctxd-tokens-verify-"));
  try {
    const storePath = defaultTokenStorePath(dir);
    const store = new TokenStore(storePath);
    const issued = await store.create("bob");

    // Hold the write lock for longer than a request should ever wait. Verify must
    // still succeed, because auth reads do not take the lock.
    await mkdir(`${storePath}.lock`);
    try {
      const results = await Promise.all(
        Array.from({ length: 25 }, () => store.verify(issued.token)),
      );
      assert.equal(results.length, 25);
      for (const row of results) {
        assert.ok(row, "verify returned undefined while the write lock was held");
        assert.equal(row.name, "bob");
        assert.ok(row.lastUsedAt);
      }
    } finally {
      await rm(`${storePath}.lock`, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TokenStore reclaims a lock abandoned by a crashed process", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ctxd-tokens-stale-"));
  try {
    const storePath = defaultTokenStorePath(dir);
    const store = new TokenStore(storePath);
    await store.create("carol");

    // Simulate a crash: lock directory left behind, backdated past the stale window.
    const lockPath = `${storePath}.lock`;
    await mkdir(lockPath);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    // Without stale-lock reclamation this rejects after the 5s timeout.
    const issued = await store.create("dave");
    assert.equal(issued.name, "dave");
    assert.deepEqual((await store.list()).map((t) => t.name).sort(), ["carol", "dave"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
