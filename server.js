import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, getSetting, setSetting } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const loginFailures = new Map();

/* ---------- 会话与密码 ---------- */

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function userFromRequest(req) {
  const sid = readCookies(req).sid;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(sid);
    return null;
  }
  return session;
}

function requireAuth(req, res, next) {
  const session = userFromRequest(req);
  if (!session) return res.status(401).json({ error: "请先登录" });
  req.session = session;
  next();
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { userId, createdAt: Date.now() });
  res.cookie("sid", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function accountCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

/* ---------- 校验 ---------- */

function bad(res, message) {
  return res.status(400).json({ error: message });
}

function cleanText(value, max = 60) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function validCourse(body) {
  const name = cleanText(body.name, 40);
  const weekday = cleanInt(body.weekday, 1, 7);
  const startSlot = cleanInt(body.startSlot, 1, 12);
  const endSlot = cleanInt(body.endSlot, 1, 12);
  const weekStart = cleanInt(body.weekStart ?? 1, 1, 30);
  const weekEnd = cleanInt(body.weekEnd ?? 16, 1, 30);
  const weekParity = ["all", "odd", "even"].includes(body.weekParity) ? body.weekParity : "all";

  if (!name) return { error: "课程名称不能为空" };
  if (!weekday || !startSlot || !endSlot) return { error: "星期和节次不正确" };
  if (startSlot > endSlot) return { error: "结束节次不能早于开始节次" };
  if (!weekStart || !weekEnd || weekStart > weekEnd) return { error: "周次范围不正确" };

  return {
    value: {
      name,
      weekday,
      startSlot,
      endSlot,
      weekStart,
      weekEnd,
      weekParity,
      teacher: cleanText(body.teacher, 30),
      location: cleanText(body.location, 40),
      color: /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : "#0e7357",
    },
  };
}

/* ---------- 冲突检测 ---------- */

function weekSet(row) {
  const weeks = [];
  for (let week = row.week_start; week <= row.week_end; week++) {
    if (row.week_parity === "odd" && week % 2 === 0) continue;
    if (row.week_parity === "even" && week % 2 === 1) continue;
    weeks.push(week);
  }
  return weeks;
}

function findConflicts(candidate, excludeId) {
  const rows = db.prepare("SELECT * FROM courses WHERE id != ?").all(excludeId ?? -1);
  const target = weekSet({
    week_start: candidate.weekStart,
    week_end: candidate.weekEnd,
    week_parity: candidate.weekParity,
  });

  return rows.filter((row) => {
    if (row.weekday !== candidate.weekday) return false;
    const overlapsSlot = candidate.startSlot <= row.end_slot && row.start_slot <= candidate.endSlot;
    if (!overlapsSlot) return false;
    return weekSet(row).some((week) => target.includes(week));
  });
}

function conflictResponse(res, conflicts) {
  return res.status(409).json({
    error: "时间冲突",
    conflicts: conflicts.map((row) => ({
      id: row.id,
      name: row.name,
      weekday: row.weekday,
      start_slot: row.start_slot,
      end_slot: row.end_slot,
    })),
  });
}

/* ---------- 账号 ---------- */

app.get("/api/me", (req, res) => {
  res.json({
    hasAccount: accountCount() > 0,
    loggedIn: Boolean(userFromRequest(req)),
  });
});

app.post("/api/setup", (req, res) => {
  if (accountCount() > 0) return res.status(409).json({ error: "账号已存在" });

  const password = String(req.body.password ?? "");
  if (password.length < 6) return bad(res, "密码至少 6 位");

  const info = db
    .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
    .run("me", hashPassword(password), new Date().toISOString());

  startSession(res, Number(info.lastInsertRowid));
  res.status(201).json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const ip = req.ip || "local";
  const record = loginFailures.get(ip);
  if (record && record.until > Date.now()) {
    return res.status(429).json({ error: "尝试次数过多，请稍后再试" });
  }

  const password = String(req.body.password ?? "");
  const user = db.prepare("SELECT * FROM users ORDER BY id LIMIT 1").get();
  if (!user || !verifyPassword(password, user.password_hash)) {
    const fails = (record?.count ?? 0) + 1;
    loginFailures.set(ip, {
      count: fails,
      until: fails >= 5 ? Date.now() + 60_000 : 0,
    });
    return res.status(401).json({ error: "密码不正确" });
  }

  loginFailures.delete(ip);
  startSession(res, user.id);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const sid = readCookies(req).sid;
  if (sid) sessions.delete(sid);
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

/* ---------- 课程 ---------- */

app.get("/api/courses", requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT * FROM courses ORDER BY weekday, start_slot, id")
    .all();
  res.json({ courses: rows });
});

app.post("/api/courses", requireAuth, (req, res) => {
  const parsed = validCourse(req.body);
  if (parsed.error) return bad(res, parsed.error);
  const c = parsed.value;

  if (!req.body.force) {
    const conflicts = findConflicts(c, null);
    if (conflicts.length) return conflictResponse(res, conflicts);
  }

  const info = db
    .prepare(
      `INSERT INTO courses
       (name, teacher, location, weekday, start_slot, end_slot, week_start, week_end, week_parity, color, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      c.name, c.teacher, c.location, c.weekday, c.startSlot, c.endSlot,
      c.weekStart, c.weekEnd, c.weekParity, c.color, new Date().toISOString()
    );

  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.put("/api/courses/:id", requireAuth, (req, res) => {
  const id = cleanInt(req.params.id, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return bad(res, "无效的编号");

  const parsed = validCourse(req.body);
  if (parsed.error) return bad(res, parsed.error);
  const c = parsed.value;

  if (!req.body.force) {
    const conflicts = findConflicts(c, id);
    if (conflicts.length) return conflictResponse(res, conflicts);
  }

  const info = db
    .prepare(
      `UPDATE courses SET name = ?, teacher = ?, location = ?, weekday = ?,
       start_slot = ?, end_slot = ?, week_start = ?, week_end = ?, week_parity = ?, color = ?
       WHERE id = ?`
    )
    .run(
      c.name, c.teacher, c.location, c.weekday, c.startSlot, c.endSlot,
      c.weekStart, c.weekEnd, c.weekParity, c.color, id
    );

  if (info.changes === 0) return res.status(404).json({ error: "课程不存在" });
  res.json({ ok: true });
});

app.delete("/api/courses/:id", requireAuth, (req, res) => {
  const id = cleanInt(req.params.id, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return bad(res, "无效的编号");
  db.prepare("DELETE FROM courses WHERE id = ?").run(id);
  res.json({ ok: true });
});

/* ---------- 作业 ---------- */

app.get("/api/assignments", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, c.name AS course_name, c.color AS course_color
       FROM assignments a
       LEFT JOIN courses c ON c.id = a.course_id
       ORDER BY a.done ASC, a.due_date ASC, a.id DESC`
    )
    .all();
  res.json({ assignments: rows });
});

app.post("/api/assignments", requireAuth, (req, res) => {
  const title = cleanText(req.body.title, 80);
  const dueDate = cleanText(req.body.dueDate, 20);
  if (!title) return bad(res, "作业标题不能为空");
  if (!/^\d{4}-\d{2}-\d{2}/.test(dueDate)) return bad(res, "截止日期格式不正确");

  const courseId = req.body.courseId ? cleanInt(req.body.courseId, 1, Number.MAX_SAFE_INTEGER) : null;
  if (courseId && !db.prepare("SELECT id FROM courses WHERE id = ?").get(courseId)) {
    return bad(res, "课程不存在");
  }

  const info = db
    .prepare(
      "INSERT INTO assignments (course_id, title, detail, due_date, done, created_at) VALUES (?, ?, ?, ?, 0, ?)"
    )
    .run(courseId, title, cleanText(req.body.detail, 300), dueDate, new Date().toISOString());

  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.patch("/api/assignments/:id", requireAuth, (req, res) => {
  const id = cleanInt(req.params.id, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return bad(res, "无效的编号");

  const row = db.prepare("SELECT * FROM assignments WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "作业不存在" });

  const done = req.body.done === undefined ? row.done : req.body.done ? 1 : 0;
  db.prepare("UPDATE assignments SET done = ? WHERE id = ?").run(done, id);
  res.json({ ok: true, done: Boolean(done) });
});

app.delete("/api/assignments/:id", requireAuth, (req, res) => {
  const id = cleanInt(req.params.id, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return bad(res, "无效的编号");
  db.prepare("DELETE FROM assignments WHERE id = ?").run(id);
  res.json({ ok: true });
});

/* ---------- 设置与示例数据 ---------- */

app.get("/api/settings", requireAuth, (req, res) => {
  res.json({ termStart: getSetting("termStart", "") });
});

app.put("/api/settings", requireAuth, (req, res) => {
  const termStart = cleanText(req.body.termStart, 10);
  if (termStart && !/^\d{4}-\d{2}-\d{2}$/.test(termStart)) return bad(res, "日期格式不正确");
  setSetting("termStart", termStart);
  res.json({ ok: true });
});

/* ---------- 节次时间 ---------- */

app.get("/api/periods", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT slot, start_time, end_time FROM periods ORDER BY slot").all();
  res.json({ periods: rows });
});

app.put("/api/periods", requireAuth, (req, res) => {
  const list = Array.isArray(req.body.periods) ? req.body.periods : [];
  if (list.length !== 12) return bad(res, "需要提供 12 个节次的时间");

  const rows = [];
  for (const item of list) {
    const slot = cleanInt(item.slot, 1, 12);
    const start = cleanText(item.start, 5);
    const end = cleanText(item.end, 5);
    if (!slot) return bad(res, "节次编号不正确");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
      return bad(res, `第 ${slot} 节的时间格式不正确`);
    }
    if (end <= start) return bad(res, `第 ${slot} 节的结束时间要晚于开始时间`);
    rows.push([slot, start, end]);
  }

  const update = db.prepare(
    "INSERT INTO periods (slot, start_time, end_time) VALUES (?, ?, ?) " +
    "ON CONFLICT(slot) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time"
  );
  db.exec("BEGIN");
  try {
    for (const row of rows) update.run(row[0], row[1], row[2]);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  res.json({ ok: true });
});

// 2026-2027 学年第 1 学期 海关检验检疫安全2601 课表
// [课程, 教师, 教室, 星期, 起始节, 结束节, 起始周, 结束周, 单双周, 颜色]
const SAMPLE_COURSES = [
  ["大学英语I", "管小繁", "志学楼-B404", 1, 1, 2, 4, 16, "even", "#1d4ed8"],
  ["管理学", "孔晓丹", "志学楼-205", 1, 5, 6, 4, 4, "even", "#b45309"],
  ["管理学", "宋杨", "志学楼-205", 1, 5, 6, 6, 16, "even", "#b45309"],
  ["体育I", "叶泽峰", "室外篮球场4", 1, 7, 8, 1, 16, "all", "#0e7357"],
  ["Python程序设计", "汤冬劼", "志学楼-B401", 2, 3, 4, 3, 16, "all", "#0f766e"],
  ["军事理论", "克依沙尔·艾尼娃", "志学楼-阶梯1", 2, 9, 10, 3, 16, "all", "#4338ca"],
  ["大学英语I", "管小繁", "志学楼-307", 3, 3, 4, 3, 16, "all", "#1d4ed8"],
  ["思想道德与法治", "杨寄荣", "志学楼-阶梯3", 3, 5, 6, 4, 16, "even", "#9d174d"],
  ["政治学原理", "娄万锁", "志学楼-103", 3, 7, 8, 3, 16, "all", "#6d28d9"],
  ["大学语文", "杨国明", "志学楼-202", 4, 1, 2, 3, 16, "all", "#0369a1"],
  ["思想道德与法治", "杨寄荣", "志学楼-阶梯3", 4, 3, 4, 3, 16, "all", "#9d174d"],
  ["高等数学B(I)", "董文强", "志学楼-105", 4, 5, 6, 3, 16, "all", "#0369a1"],
  ["大学生心理健康", "宣红萍", "志学楼-阶梯3", 4, 7, 8, 3, 16, "all", "#b45309"],
  ["管理学", "孔晓丹", "志学楼-311（智慧教室）", 5, 3, 4, 3, 4, "all", "#b45309"],
  ["管理学", "宋杨", "志学楼-311（智慧教室）", 5, 3, 4, 5, 16, "all", "#b45309"],
  ["高等数学B(I)", "董文强", "志学楼-105", 5, 5, 6, 3, 15, "odd", "#0369a1"],
  ["形势与政策I", "曾怡", "志学楼-阶梯3", 4, 9, 10, 3, 9, "odd", "#4338ca"],
];

app.post("/api/demo-data", requireAuth, (req, res) => {
  const count = db.prepare("SELECT COUNT(*) AS n FROM courses").get().n;
  if (count > 0) return bad(res, "已经有课程了，先清空再试");

  const now = new Date().toISOString();
  const insertCourse = db.prepare(
    `INSERT INTO courses
     (name, teacher, location, weekday, start_slot, end_slot, week_start, week_end, week_parity, color, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.exec("BEGIN");
  try {
    for (const c of SAMPLE_COURSES) {
      insertCourse.run(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], now);
    }
    setSetting("termStart", "2026-09-07");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const today = new Date();
  const iso = (offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const idOf = (name) =>
    db.prepare("SELECT id FROM courses WHERE name = ? ORDER BY id LIMIT 1").get(name)?.id ?? null;
  const addTask = db.prepare(
    "INSERT INTO assignments (course_id, title, detail, due_date, done, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  );
  addTask.run(idOf("高等数学B(I)"), "习题 3.1 - 3.5", "第三章课后题", iso(1), now);
  addTask.run(idOf("大学英语I"), "Unit 1 作文", "提交到课程平台", iso(4), now);

  res.status(201).json({ ok: true });
});

app.post("/api/data/clear", requireAuth, (req, res) => {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM assignments; DELETE FROM courses;");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  res.json({ ok: true });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "接口不存在" });
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") return bad(res, "请求格式不正确");
  console.error(err);
  res.status(500).json({ error: "服务器出错了" });
});

app.listen(PORT, () => {
  console.log(`course-planner running at http://localhost:${PORT}`);
});
