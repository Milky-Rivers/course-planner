import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "app.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    teacher TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    weekday INTEGER NOT NULL,
    start_slot INTEGER NOT NULL,
    end_slot INTEGER NOT NULL,
    week_start INTEGER NOT NULL DEFAULT 1,
    week_end INTEGER NOT NULL DEFAULT 16,
    week_parity TEXT NOT NULL DEFAULT 'all',
    color TEXT NOT NULL DEFAULT '#0e7357',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY,
    course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS periods (
    slot INTEGER PRIMARY KEY,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL
  );
`);

// 老数据库没有 week_parity 列时补上，已有数据默认按每周处理
const courseColumns = db.prepare("PRAGMA table_info(courses)").all();
if (!courseColumns.some((column) => column.name === "week_parity")) {
  db.exec("ALTER TABLE courses ADD COLUMN week_parity TEXT NOT NULL DEFAULT 'all'");
}

// 默认作息时间，用户可以在设置里改
const DEFAULT_PERIODS = [
  ["08:30", "09:15"], ["09:20", "10:05"], ["10:20", "11:05"], ["11:10", "11:55"],
  ["13:30", "14:15"], ["14:20", "15:05"], ["15:20", "16:05"], ["16:10", "16:55"],
  ["18:00", "18:45"], ["18:45", "19:30"], ["19:40", "20:25"], ["20:25", "21:10"],
];
if (db.prepare("SELECT COUNT(*) AS n FROM periods").get().n === 0) {
  const insertPeriod = db.prepare(
    "INSERT INTO periods (slot, start_time, end_time) VALUES (?, ?, ?)"
  );
  DEFAULT_PERIODS.forEach(([start, end], index) => insertPeriod.run(index + 1, start, end));
}

// 第一周的周一：2026-09-07
if (!db.prepare("SELECT 1 AS ok FROM settings WHERE key = 'termStart'").get()) {
  setSetting("termStart", "2026-09-07");
}

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}
