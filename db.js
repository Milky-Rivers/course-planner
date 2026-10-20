import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  DEFAULT_PERIODS,
  POSTGRES_SCHEMA,
  SQLITE_SCHEMA,
} from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionString = process.env.DATABASE_URL?.trim();
const isPostgres = Boolean(connectionString);

let sqlite;
let pool;
let sqliteTail = Promise.resolve();

function toPostgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function sqliteExecutor() {
  return {
    async all(sql, params = []) {
      return sqlite.prepare(sql).all(...params);
    },
    async get(sql, params = []) {
      return sqlite.prepare(sql).get(...params);
    },
    async run(sql, params = []) {
      const result = sqlite.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
  };
}

function postgresExecutor(query) {
  return {
    async all(sql, params = []) {
      const result = await query(toPostgresSql(sql), params);
      return result.rows;
    },
    async get(sql, params = []) {
      const result = await query(toPostgresSql(sql), params);
      return result.rows[0];
    },
    async run(sql, params = []) {
      const result = await query(toPostgresSql(sql), params);
      return { changes: result.rowCount };
    },
  };
}

function withSQLiteLock(work) {
  const result = sqliteTail.then(work, work);
  sqliteTail = result.catch(() => {});
  return result;
}

const postgres = postgresExecutor((sql, params) => pool.query(sql, params));

export const db = {
  dialect: isPostgres ? "postgres" : "sqlite",

  async all(sql, params = []) {
    if (isPostgres) return postgres.all(sql, params);
    return withSQLiteLock(() => sqlite.prepare(sql).all(...params));
  },

  async get(sql, params = []) {
    if (isPostgres) return postgres.get(sql, params);
    return withSQLiteLock(() => sqlite.prepare(sql).get(...params));
  },

  async run(sql, params = []) {
    if (isPostgres) return postgres.run(sql, params);
    return withSQLiteLock(() => {
      const result = sqlite.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    });
  },

  async transaction(work) {
    if (isPostgres) {
      const client = await pool.connect();
      const tx = postgresExecutor((sql, params) => client.query(sql, params));
      try {
        await client.query("BEGIN");
        const result = await work(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    return withSQLiteLock(async () => {
      const tx = sqliteExecutor();
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = await work(tx);
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    });
  },
};

async function initializeDatabase() {
  if (isPostgres) {
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX) || 3,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
    pool.on("error", (error) => {
      console.error("PostgreSQL pool error:", error);
    });
    await pool.query(POSTGRES_SCHEMA);
  } else {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    // 按需加载：用 PostgreSQL 部署时（Node 22 需要实验开关）不会碰这个模块
    const { DatabaseSync } = await import("node:sqlite");
    sqlite = new DatabaseSync(path.join(dataDir, "app.db"));
    sqlite.exec(SQLITE_SCHEMA);

    // 老数据库没有 week_parity 列时补上，已有数据默认按每周处理。
    const courseColumns = sqlite.prepare("PRAGMA table_info(courses)").all();
    if (!courseColumns.some((column) => column.name === "week_parity")) {
      sqlite.exec("ALTER TABLE courses ADD COLUMN week_parity TEXT NOT NULL DEFAULT 'all'");
    }
  }

  await db.transaction(async (tx) => {
    for (const [index, [start, end]] of DEFAULT_PERIODS.entries()) {
      await tx.run(
        "INSERT INTO periods (slot, start_time, end_time) VALUES (?, ?, ?) " +
        "ON CONFLICT(slot) DO NOTHING",
        [index + 1, start, end]
      );
    }
    await tx.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
      ["termStart", "2026-09-07"]
    );
  });
}

export async function getSetting(key, fallback = null) {
  const row = await db.get("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, String(value)]
  );
}

await initializeDatabase();
