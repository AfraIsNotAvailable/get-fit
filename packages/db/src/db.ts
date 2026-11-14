/** Opening, migrating and transacting. The only file that knows it is SQLite. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

export interface OpenOptions {
  readOnly?: boolean;
}

const SCHEMA = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");

export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const db = new DatabaseSync(path, {
    readOnly: options.readOnly ?? false,
    enableForeignKeyConstraints: true,
  });
  // the Python app used the default rollback journal; WAL would leave -wal/-shm
  // siblings behind for deploy.sh's `mv getfit.db` dance, so leave it alone
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function columns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Create what is missing, add the columns `CREATE TABLE IF NOT EXISTS` cannot. */
export function migrate(db: Db): { added: string[] } {
  db.exec(SCHEMA);
  const added: string[] = [];

  if (!columns(db, "exercises").has("form_url")) {
    db.exec("ALTER TABLE exercises ADD COLUMN form_url TEXT");
    added.push("exercises.form_url");
  }
  if (!columns(db, "checkins").has("local_date")) {
    db.exec("ALTER TABLE checkins ADD COLUMN local_date TEXT");
    added.push("checkins.local_date");
  }
  // always after the possible ALTER: an index on a column that a
  // CREATE TABLE IF NOT EXISTS cannot retrofit kills the whole script, and the
  // scheduler then stops silently (the local_date lesson)
  db.exec("CREATE INDEX IF NOT EXISTS idx_checkins_day ON checkins(local_date)");

  const row = db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number | null };
  const version = row?.v ?? 0;
  if (version < 1) {
    db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)")
      .run(1, new Date().toISOString(), "baseline");
  }
  return { added };
}

/** `BEGIN IMMEDIATE`: the tick and an HTTP confirm can never interleave. */
export function withImmediate<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction may already be gone */
    }
    throw error;
  }
}

export function schemaVersion(db: Db): number {
  try {
    const row = db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number | null };
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}
