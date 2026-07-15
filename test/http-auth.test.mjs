import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
