import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "state_machine.sql"), "utf8");

// These tests write real rows. Point DATABASE_URL at a scratch database, never
// at production.
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test("the follow-up state machine behaves", { skip: connectionString ? false : "set DATABASE_URL to run" }, async () => {
  // Same rule as server/db.js: a unix socket or localhost needs no TLS, and
  // PGSSLMODE=disable turns it off anywhere. Without the socket cases, pointing
  // this at a local cluster over its socket fails with "the server does not
  // support SSL connections", which reads like a database fault rather than a
  // harness one.
  const isLocal = /localhost|127\.0\.0\.1|@\/|host=\//.test(connectionString);
  const sslDisabled = process.env.PGSSLMODE === "disable" || isLocal;
  const client = new pg.Client({
    connectionString,
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
  });

  const passed = [];
  const failed = [];
  client.on("notice", (notice) => {
    const message = notice.message ?? "";
    if (message.startsWith("ok  ")) passed.push(message.slice(4));
    if (message.startsWith("FAILED")) failed.push(message);
  });

  await client.connect();
  try {
    await client.query(sql);
  } catch (error) {
    // A raised check surfaces here rather than as a notice.
    assert.fail(`${error.message}\n\nLast check that passed: ${passed.at(-1) ?? "none"}`);
  } finally {
    await client.end();
  }

  assert.deepEqual(failed, [], "some checks failed");
  assert.ok(passed.length > 80, `expected the full suite to run, only ${passed.length} checks reported`);
  console.log(`    ${passed.length} database checks passed`);
});
