import { test } from "node:test";
import assert from "node:assert/strict";
import { Denylist, rejectIfDenylisted } from "../dist/denylist.js";
import { SchemaReferenceError } from "../dist/errors.js";

test("Denylist matches schema.table, bare table, and column entries", () => {
  const d = new Denylist(["public.secrets", "users.email", "tokens"]);
  assert.equal(d.isTableDenied("public", "secrets"), true);
  assert.equal(d.isTableDenied(undefined, "tokens"), true);
  assert.equal(d.isTableDenied("public", "users"), false);
  assert.equal(d.isColumnDenied("public", "users", "email"), true);
  assert.equal(d.isColumnDenied("public", "users", "id"), false);
});

test("rejectIfDenylisted throws for denylisted entities", () => {
  const entity = {
    id: "table:public.secrets",
    kind: "table",
    name: "secrets",
    qualifiedName: "public.secrets",
    databaseId: 1,
    databaseName: "db",
    denylisted: true,
  };
  assert.throws(
    () => rejectIfDenylisted(entity),
    (err) => err instanceof SchemaReferenceError && /Denylisted table "public.secrets"/.test(err.message),
  );
});

test("rejectIfDenylisted is a no-op for normal entities", () => {
  rejectIfDenylisted({
    id: "table:public.claims",
    kind: "table",
    name: "claims",
    qualifiedName: "public.claims",
    databaseId: 1,
    databaseName: "db",
  });
});
