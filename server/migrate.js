import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// Runs on every boot. Each file runs once, inside a transaction, in filename
// order. A failed migration rolls back and stops the process rather than leaving
// the schema half-applied.
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query("select filename from schema_migrations")).rows.map((row) => row.filename),
    );

    const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
    let count = 0;

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      process.stdout.write(`  applying ${file}... `);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (filename) values ($1)", [file]);
        await client.query("commit");
        count += 1;
        console.log("done");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        console.log("failed");
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
    }

    console.log(count ? `Applied ${count} migration(s).` : "Database is up to date.");
  } finally {
    client.release();
  }
}

// `npm run migrate` runs this file directly; the server imports migrate() instead.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
