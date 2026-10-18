import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "course-planner-test-"));
const port = Number(process.env.TEST_PORT) || 3210;
const baseUrl = `http://127.0.0.1:${port}`;
const password = "smoke-test-password";

let cookie = "";
let serverOutput = "";

const server = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    NODE_ENV: "test",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited before startup:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/me`);
      if (response.ok) return;
    } catch {
      // Retry until the listener is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for server:\n${serverOutput}`);
}

async function request(urlPath, options = {}) {
  const expected = options.expected ?? 200;
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;

  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie[0].split(";")[0];

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  assert.equal(
    response.status,
    expected,
    `${options.method ?? "GET"} ${urlPath}: expected ${expected}, got ${response.status}\n${text}`
  );
  return data;
}

try {
  await waitForServer();

  const home = await request("/");
  assert.match(home, /课程表/);
  const appScript = await request("/app.js");
  assert.match(appScript, /async function boot/);
  const health = await request("/api/health");
  assert.equal(health.ok, true);
  assert.equal(health.database, process.env.DATABASE_URL ? "postgres" : "sqlite");

  let me = await request("/api/me");
  assert.deepEqual(me, { hasAccount: false, loggedIn: false });

  await request("/api/setup", {
    method: "POST",
    body: { password },
    expected: 201,
  });
  me = await request("/api/me");
  assert.equal(me.hasAccount, true);
  assert.equal(me.loggedIn, true);

  const periods = await request("/api/periods");
  assert.equal(periods.periods.length, 12);
  assert.equal(periods.periods[0].slot, 1);

  const settings = await request("/api/settings");
  assert.equal(settings.termStart, "2026-09-07");

  const courseBody = {
    name: "Test Course",
    teacher: "Teacher",
    location: "Room 1",
    weekday: 1,
    startSlot: 1,
    endSlot: 2,
    weekStart: 1,
    weekEnd: 16,
    weekParity: "all",
    color: "#0e7357",
  };
  const firstCourse = await request("/api/courses", {
    method: "POST",
    body: courseBody,
    expected: 201,
  });
  assert.equal(typeof firstCourse.id, "number");

  const conflict = await request("/api/courses", {
    method: "POST",
    body: { ...courseBody, name: "Conflicting Course" },
    expected: 409,
  });
  assert.equal(conflict.conflicts.length, 1);

  const forcedCourse = await request("/api/courses", {
    method: "POST",
    body: { ...courseBody, name: "Forced Course", force: true },
    expected: 201,
  });
  assert.equal(typeof forcedCourse.id, "number");

  let courses = await request("/api/courses");
  assert.equal(courses.courses.length, 2);

  await request(`/api/courses/${forcedCourse.id}`, {
    method: "DELETE",
  });
  courses = await request("/api/courses");
  assert.equal(courses.courses.length, 1);

  const assignment = await request("/api/assignments", {
    method: "POST",
    body: {
      courseId: firstCourse.id,
      title: "Smoke test assignment",
      detail: "Verify the assignment flow",
      dueDate: "2026-10-20",
    },
    expected: 201,
  });
  let assignments = await request("/api/assignments");
  assert.equal(assignments.assignments.length, 1);
  assert.equal(assignments.assignments[0].course_name, "Test Course");

  await request(`/api/assignments/${assignment.id}`, {
    method: "PATCH",
    body: { done: true },
  });
  assignments = await request("/api/assignments");
  assert.equal(Boolean(assignments.assignments[0].done), true);

  const nextPeriods = periods.periods.map((period, index) => ({
    slot: period.slot,
    start: index === 0 ? "08:00" : period.start_time,
    end: index === 0 ? "08:45" : period.end_time,
  }));
  await request("/api/periods", {
    method: "PUT",
    body: { periods: nextPeriods },
  });
  const updatedPeriods = await request("/api/periods");
  assert.equal(updatedPeriods.periods[0].start_time, "08:00");

  await request("/api/settings", {
    method: "PUT",
    body: { termStart: "2026-09-14" },
  });
  const updatedSettings = await request("/api/settings");
  assert.equal(updatedSettings.termStart, "2026-09-14");

  await request("/api/logout", { method: "POST" });
  cookie = "";
  await request("/api/courses", { expected: 401 });

  await request("/api/login", {
    method: "POST",
    body: { password: "wrong-password" },
    expected: 401,
  });
  await request("/api/login", {
    method: "POST",
    body: { password },
  });

  await request("/api/data/clear", { method: "POST" });
  await request("/api/demo-data", { method: "POST", expected: 201 });
  courses = await request("/api/courses");
  assignments = await request("/api/assignments");
  assert.equal(courses.courses.length, 17);
  assert.equal(assignments.assignments.length, 2);

  await request("/api/data/clear", { method: "POST" });
  courses = await request("/api/courses");
  assignments = await request("/api/assignments");
  assert.equal(courses.courses.length, 0);
  assert.equal(assignments.assignments.length, 0);

  console.log("Smoke test passed: auth, courses, conflicts, assignments, settings, periods, demo data.");
} finally {
  server.kill();
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once("exit", resolve);
    setTimeout(resolve, 2_000).unref();
  });
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (path.resolve(dataDir).startsWith(tempRoot)) {
    await rm(dataDir, { recursive: true, force: true });
  }
}
