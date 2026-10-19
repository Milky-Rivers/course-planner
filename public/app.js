const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SLOTS = 12;
const COLORS = [
  "#0e7357", "#1d4ed8", "#b45309", "#9d174d",
  "#4338ca", "#0f766e", "#6d28d9", "#0369a1",
];

const state = {
  me: null,
  courses: [],
  assignments: [],
  periods: [],
  termStart: "",
  week: 1,
  tab: "timetable",
  taskQuery: "",
  taskStatus: "open",
  courseFilter: "",
};

const $ = (selector, root = document) => root.querySelector(selector);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) {
    const error = new Error(data.error || `请求失败（${res.status}）`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

/* ---------- 日期工具 ---------- */

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseISO(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function mondayOf(date) {
  const copy = new Date(date);
  const offset = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - offset);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function weekNumberToday() {
  if (!state.termStart) return 1;
  const diff = daysBetween(parseISO(state.termStart), parseISO(isoDate(new Date())));
  return Math.max(1, Math.floor(diff / 7) + 1);
}

function currentWeekStart() {
  const start = new Date(parseISO(state.termStart));
  start.setDate(start.getDate() + (state.week - 1) * 7);
  return start;
}

function dueLabel(due) {
  const today = parseISO(isoDate(new Date()));
  const diff = daysBetween(today, parseISO(due));
  if (diff < 0) return { text: `已逾期 ${-diff} 天`, tone: "late" };
  if (diff === 0) return { text: "今天截止", tone: "soon" };
  if (diff === 1) return { text: "明天截止", tone: "soon" };
  if (diff <= 3) return { text: `${diff} 天后截止`, tone: "soon" };
  return { text: `${due.slice(5)} 截止`, tone: "" };
}

/* ---------- 启动 ---------- */

async function boot() {
  const savedTheme = localStorage.getItem("theme");
  applyTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  registerServiceWorker();

  try {
    state.me = await api("/api/me");
  } catch (error) {
    renderFatal(error.message);
    return;
  }

  if (!state.me.loggedIn) {
    renderAuth();
    return;
  }

  await loadData();
  renderApp();
  checkReminders();
  setInterval(() => checkReminders(), 10 * 60 * 1000);
}

async function loadData() {
  const [courses, assignments, settings, periods] = await Promise.all([
    api("/api/courses"),
    api("/api/assignments"),
    api("/api/settings"),
    api("/api/periods"),
  ]);
  state.courses = courses.courses;
  state.assignments = assignments.assignments;
  state.periods = periods.periods;
  state.termStart = settings.termStart || isoDate(mondayOf(new Date()));
  state.week = weekNumberToday();
}

function renderFatal(message) {
  $("#app").innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand"><span class="brand-mark">课</span><span>课程表</span></div>
        <h1>连不上服务</h1>
        <p class="muted">${esc(message)}</p>
        <button class="btn btn-primary btn-block" data-action="reload">重试</button>
      </div>
    </div>`;
}

/* ---------- 登录 / 首次设置 ---------- */

function renderAuth() {
  const setup = !state.me.hasAccount;
  $("#app").innerHTML = `
    <div class="auth-wrap">
      <form class="auth-card" id="authForm">
        <div class="brand"><span class="brand-mark">课</span><span>课程表</span></div>
        <h1>${setup ? "设置一个密码" : "欢迎回来"}</h1>
        <p class="muted">${setup
          ? "第一次使用，先设置密码。密码只保存在你自己的服务器上。"
          : "输入密码进入你的课程表和作业。"}</p>
        <label class="field">
          <span>密码</span>
          <input type="password" id="password" minlength="6" required
            autocomplete="${setup ? "new-password" : "current-password"}" placeholder="至少 6 位">
        </label>
        ${setup ? `
        <label class="field">
          <span>再输一次</span>
          <input type="password" id="password2" minlength="6" required autocomplete="new-password">
        </label>` : ""}
        <p class="form-error" id="authError" hidden></p>
        <button class="btn btn-primary btn-block" type="submit">${setup ? "创建并进入" : "进入"}</button>
      </form>
    </div>`;

  $("#authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("#authError");
    errorBox.hidden = true;
    const password = $("#password").value;

    if (setup && password !== $("#password2").value) {
      errorBox.textContent = "两次输入的密码不一致";
      errorBox.hidden = false;
      return;
    }

    try {
      await api(setup ? "/api/setup" : "/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      state.me = await api("/api/me");
      await loadData();
      renderApp();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  });
}

/* ---------- 主界面 ---------- */

function renderApp() {
  const open = state.assignments.filter((item) => !item.done).length;
  const parityText = state.week % 2 === 1 ? "单周" : "双周";
  const today = isoDate(new Date());
  const tomorrow = isoDate(new Date(Date.now() + 86400000));
  const pending = state.assignments.filter((item) => !item.done);
  const overdue = pending.filter((item) => item.due_date < today).length;
  const dueToday = pending.filter((item) => item.due_date === today).length;
  const dueTomorrow = pending.filter((item) => item.due_date === tomorrow).length;
  const weekStart = currentWeekStart();
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const rangeLabel = `${weekStart.getMonth() + 1}/${weekStart.getDate()} - ${weekEnd.getMonth() + 1}/${weekEnd.getDate()}`;
  $("#app").innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand"><span class="brand-mark">课</span><span>课程表</span></div>
        <div class="week-nav">
          <button class="icon-btn" data-action="prev-week" aria-label="上一周">‹</button>
          <span class="week-label">第 ${state.week} 周<small class="week-parity">${parityText}</small></span>
          <button class="icon-btn" data-action="next-week" aria-label="下一周">›</button>
          <button class="link-btn" data-action="this-week">本周</button>
        </div>
        <div class="topbar-actions">
          <button class="icon-btn" data-action="toggle-theme" aria-label="切换深浅色" title="切换深浅色（D）">
            <svg class="icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4"></circle>
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>
            </svg>
            <svg class="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
            </svg>
          </button>
          <button class="icon-btn hide-sm" data-action="shortcuts" aria-label="键盘快捷键" title="键盘快捷键（?）">?</button>
          <button class="btn btn-ghost btn-sm" data-action="print">打印</button>
          <button class="btn btn-ghost btn-sm" data-action="settings">设置</button>
          <button class="btn btn-ghost btn-sm" data-action="logout">退出</button>
        </div>
      </div>
    </header>

    <div class="tabs" role="tablist">
      <button role="tab" data-action="tab" data-tab="timetable"
        aria-selected="${state.tab === "timetable"}">课表</button>
      <button role="tab" data-action="tab" data-tab="assignments"
        aria-selected="${state.tab === "assignments"}">作业${open ? `<span class="count">${open}</span>` : ""}</button>
    </div>

    <main class="content">
      <div class="print-head">
        <h1>${state.tab === "timetable" ? `第 ${state.week} 周课表` : "作业清单"}</h1>
        <p>${state.tab === "timetable" ? rangeLabel : `${today} 打印`}</p>
      </div>
      ${state.tab === "timetable" ? renderTodayBar(overdue, dueToday, dueTomorrow) : ""}
      ${state.tab === "timetable" ? renderTimetable() : renderAssignments()}
    </main>

    <button class="fab" data-action="add" aria-label="${state.tab === "timetable" ? "添加课程" : "添加作业"}">+</button>`;
}

function renderTodayBar(overdue, dueToday, dueTomorrow) {
  let text = "近两天没有要交的作业";
  let tone = "";
  if (overdue > 0) {
    text = `有 ${overdue} 条作业已逾期`;
    tone = "late";
  } else if (dueToday > 0) {
    text = `今天有 ${dueToday} 条作业要交`;
    tone = "soon";
  } else if (dueTomorrow > 0) {
    text = `明天有 ${dueTomorrow} 条作业要交`;
    tone = "soon";
  }

  return `<button class="today-bar ${tone}" data-action="tab" data-tab="assignments">
    <span class="today-dot" aria-hidden="true"></span>
    <span class="today-text">${text}</span>
    <span class="today-more">查看作业</span>
  </button>`;
}

function renderTimetable() {
  const weekStart = currentWeekStart();
  const today = isoDate(new Date());

  let html = `<div class="tt-scroll"><div class="timetable">`;
  html += `<div class="tt-corner"></div>`;

  DAYS.forEach((name, index) => {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + index);
    const current = isoDate(date) === today;
    html += `<div class="tt-day ${current ? "today" : ""}">
      <span>${name}</span><small>${date.getMonth() + 1}/${date.getDate()}</small>
    </div>`;
  });

  for (let slot = 1; slot <= SLOTS; slot++) {
    const period = state.periods.find((item) => item.slot === slot);
    const range = period ? `${period.start_time}-${period.end_time}` : "";
    html += `<div class="tt-slot" style="grid-column:1;grid-row:${slot + 1}">
      <b>${slot}</b>${range ? `<small>${esc(range)}</small>` : ""}
    </div>`;
    for (let day = 1; day <= 7; day++) {
      html += `<button class="tt-cell" style="grid-column:${day + 1};grid-row:${slot + 1}"
        data-action="add-course" data-weekday="${day}" data-slot="${slot}"
        aria-label="${DAYS[day - 1]}第 ${slot} 节，添加课程"></button>`;
    }
  }

  const parity = state.week % 2 === 1 ? "odd" : "even";
  const visible = state.courses.filter((course) =>
    state.week >= course.week_start &&
    state.week <= course.week_end &&
    (course.week_parity === "all" || course.week_parity === parity)
  );
  const conflicted = new Set();
  const conflictCount = new Map();
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i];
      const b = visible[j];
      if (a.weekday === b.weekday && a.start_slot <= b.end_slot && b.start_slot <= a.end_slot) {
        conflicted.add(a.id);
        conflicted.add(b.id);
      }
    }
  }

  for (const course of visible) {
    const parityLabel = course.week_parity === "odd" ? "单周" : course.week_parity === "even" ? "双周" : "";
    const meta = [parityLabel, course.location].filter(Boolean).join(" · ");
    const overlap = conflicted.has(course.id);
    const shifted = overlap && conflictCount.get(course.weekday) % 2 === 1;
    if (overlap) conflictCount.set(course.weekday, (conflictCount.get(course.weekday) ?? 0) + 1);
    html += `<button class="course ${overlap ? "conflict" : ""} ${shifted ? "alt" : ""}" style="grid-column:${course.weekday + 1};grid-row:${course.start_slot + 1}/span ${course.end_slot - course.start_slot + 1};--c:${course.color}"
      data-action="edit-course" data-id="${course.id}"${overlap ? ' title="与另一门课时间重叠"' : ""}>
      <strong>${esc(course.name)}</strong>
      ${meta ? `<span>${esc(meta)}</span>` : ""}
    </button>`;
  }

  html += `</div></div>`;
  if (!state.courses.length) {
    html += `<p class="empty">还没有课程。点右下角的加号添加，或者到「设置」里载入示例数据先看看效果。</p>`;
  }
  return html;
}

function renderAssignments() {
  return `
    <div class="filters">
      <div class="search-box">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>
        </svg>
        <input id="taskSearch" type="search" placeholder="搜索作业、备注或课程（按 / 聚焦）"
          value="${esc(state.taskQuery)}" autocomplete="off" aria-label="搜索作业">
      </div>
      <select id="courseFilter" aria-label="按课程筛选">
        <option value="">全部课程</option>
        ${state.courses.map((course) => `
          <option value="${course.id}" ${state.courseFilter === String(course.id) ? "selected" : ""}>${esc(course.name)}</option>`).join("")}
      </select>
      <div class="seg" role="group" aria-label="按完成状态筛选">
        ${[["open", "未完成"], ["all", "全部"], ["done", "已完成"]].map(([value, label]) => `
          <button type="button" data-action="task-status" data-status="${value}"
            aria-pressed="${state.taskStatus === value}">${label}</button>`).join("")}
      </div>
    </div>
    <div id="taskListWrap">${renderTaskList()}</div>`;
}

function filteredAssignments() {
  const query = state.taskQuery.trim().toLowerCase();
  return state.assignments.filter((item) => {
    if (state.taskStatus === "open" && item.done) return false;
    if (state.taskStatus === "done" && !item.done) return false;
    if (state.courseFilter && String(item.course_id ?? "") !== state.courseFilter) return false;
    if (query) {
      const haystack = `${item.title} ${item.detail ?? ""} ${item.course_name ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function taskRow(item) {
  const due = dueLabel(item.due_date);
  return `<li class="task ${item.done ? "done" : ""}">
    <input class="task-check" type="checkbox" ${item.done ? "checked" : ""}
      data-action="toggle" data-id="${item.id}"
      aria-label="${item.done ? "标记未完成" : "标记完成"}：${esc(item.title)}">
    <div class="task-main">
      <p class="task-title">${esc(item.title)}</p>
      <p class="task-meta">
        ${item.course_name ? `<span class="tag" style="--c:${item.course_color}">${esc(item.course_name)}</span>` : ""}
        <span class="due ${due.tone}">${due.text}</span>
        ${item.detail ? `<span>${esc(item.detail)}</span>` : ""}
      </p>
    </div>
    <button class="icon-btn" data-action="delete-assignment" data-id="${item.id}" aria-label="删除作业">×</button>
  </li>`;
}

function renderTaskList() {
  if (!state.assignments.length) {
    return `<p class="empty">还没有作业。点右下角的加号，添加第一条。</p>`;
  }
  const items = filteredAssignments();
  if (!items.length) {
    return `<p class="empty">没有符合条件的作业。换个关键词或筛选条件试试。</p>`;
  }
  return `<ul class="tasks">${items.map(taskRow).join("")}</ul>`;
}

/* ---------- 弹窗 ---------- */

function slotOptions(selected) {
  return Array.from({ length: SLOTS }, (_, index) => index + 1)
    .map((n) => `<option value="${n}" ${n === selected ? "selected" : ""}>${n}</option>`)
    .join("");
}

function openCourseDialog({ course = null, weekday = 1, slot = 1 } = {}) {
  const dialog = $("#dialog");
  dialog.innerHTML = `
    <form class="dialog-form" id="courseForm">
      <h2>${course ? "编辑课程" : "添加课程"}</h2>
      <label class="field"><span>课程名称</span>
        <input name="name" required maxlength="40" value="${esc(course?.name ?? "")}" placeholder="例如：高等数学">
      </label>
      <div class="row">
        <label class="field"><span>星期</span>
          <select name="weekday">${DAYS.map((name, index) =>
            `<option value="${index + 1}" ${(course?.weekday ?? weekday) === index + 1 ? "selected" : ""}>${name}</option>`).join("")}</select>
        </label>
        <label class="field"><span>开始节次</span>
          <select name="startSlot">${slotOptions(course?.start_slot ?? slot)}</select>
        </label>
        <label class="field"><span>结束节次</span>
          <select name="endSlot">${slotOptions(course?.end_slot ?? slot)}</select>
        </label>
      </div>
      <p class="slot-hint" id="slotHint"></p>
      <div class="row">
        <label class="field"><span>起始周</span>
          <input name="weekStart" type="number" min="1" max="30" value="${course?.week_start ?? 1}">
        </label>
        <label class="field"><span>结束周</span>
          <input name="weekEnd" type="number" min="1" max="30" value="${course?.week_end ?? 16}">
        </label>
      </div>
      <div class="field">
        <span>上课周次</span>
        <div class="seg" role="radiogroup" aria-label="上课周次">
          ${[
            ["all", "每周"],
            ["odd", "单周"],
            ["even", "双周"],
          ].map(([value, label]) => `
            <label>
              <input type="radio" name="weekParity" value="${value}"
                ${(course?.week_parity ?? "all") === value ? "checked" : ""}>
              <span>${label}</span>
            </label>`).join("")}
        </div>
      </div>
      <label class="field"><span>上课地点</span>
        <input name="location" maxlength="40" value="${esc(course?.location ?? "")}" placeholder="例如：教三-201">
      </label>
      <label class="field"><span>任课老师</span>
        <input name="teacher" maxlength="30" value="${esc(course?.teacher ?? "")}">
      </label>
      <fieldset class="colors">
        <legend>颜色</legend>
        ${COLORS.map((color) => `
          <label><input type="radio" name="color" value="${color}"
            ${(course?.color ?? COLORS[0]) === color ? "checked" : ""}>
            <span style="--c:${color}"></span>
          </label>`).join("")}
      </fieldset>
      <div class="dialog-actions">
        ${course ? `<button type="button" class="btn btn-danger" data-action="delete-course" data-id="${course.id}">删除</button>` : ""}
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" data-action="close-dialog">取消</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`;

  dialog.showModal();

  const form = $("#courseForm");
  const updateSlotHint = () => {
    const first = state.periods.find((item) => item.slot === Number(form.startSlot.value));
    const last = state.periods.find((item) => item.slot === Number(form.endSlot.value));
    $("#slotHint").textContent =
      first && last ? `上课时间 ${first.start_time} – ${last.end_time}` : "";
  };
  form.startSlot.addEventListener("change", updateSlotHint);
  form.endSlot.addEventListener("change", updateSlotHint);
  updateSlotHint();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target).entries());
    const save = async (force) => {
      const payload = JSON.stringify({ ...body, force });
      if (course) {
        return api(`/api/courses/${course.id}`, { method: "PUT", body: payload });
      }
      return api("/api/courses", { method: "POST", body: payload });
    };

    try {
      try {
        await save(false);
      } catch (error) {
        if (error.status !== 409 || !error.data?.conflicts?.length) throw error;
        const list = error.data.conflicts
          .map((item) => `《${item.name}》${DAYS[item.weekday - 1]}第 ${item.start_slot}-${item.end_slot} 节`)
          .join("、");
        if (!confirm(`和 ${list} 时间冲突，仍然保存吗？`)) return;
        await save(true);
      }
      dialog.close();
      await loadData();
      renderApp();
    } catch (error) {
      alert(error.message);
    }
  });
}

function openAssignmentDialog() {
  const dialog = $("#dialog");
  dialog.innerHTML = `
    <form class="dialog-form" id="assignmentForm">
      <h2>添加作业</h2>
      <label class="field"><span>标题</span>
        <input name="title" required maxlength="80" placeholder="例如：第三章习题">
      </label>
      <div class="row" style="grid-template-columns:1fr 1fr">
        <label class="field"><span>课程</span>
          <select name="courseId">
            <option value="">不关联课程</option>
            ${state.courses.map((course) => `<option value="${course.id}">${esc(course.name)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>截止日期</span>
          <input name="dueDate" type="date" required value="${isoDate(new Date())}">
        </label>
      </div>
      <label class="field"><span>备注</span>
        <textarea name="detail" maxlength="300" placeholder="可选"></textarea>
      </label>
      <div class="dialog-actions">
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" data-action="close-dialog">取消</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`;

  dialog.showModal();

  $("#assignmentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target).entries());
    try {
      await api("/api/assignments", { method: "POST", body: JSON.stringify(body) });
      dialog.close();
      await loadData();
      state.tab = "assignments";
      renderApp();
    } catch (error) {
      alert(error.message);
    }
  });
}

function openSettingsDialog() {
  const dialog = $("#dialog");
  dialog.innerHTML = `
    <form class="dialog-form" id="settingsForm">
      <h2>设置</h2>
      <label class="field"><span>学期第一周的周一</span>
        <input name="termStart" type="date" value="${esc(state.termStart)}">
      </label>
      <p class="muted" style="margin:0 0 16px;font-size:13px">用来计算「第几周」。改完保存，课表会按新日期重新排列。</p>
      <fieldset class="periods">
        <legend>节次时间</legend>
        <div class="period-grid">
          ${state.periods.map((period) => `
            <label class="period-row">
              <span>第 ${period.slot} 节</span>
              <input type="time" name="start-${period.slot}" value="${period.start_time}" required>
              <em>–</em>
              <input type="time" name="end-${period.slot}" value="${period.end_time}" required>
            </label>`).join("")}
        </div>
      </fieldset>
      <fieldset class="periods">
        <legend>作业提醒</legend>
        <p class="notify-status" id="notifyStatus">${reminderStatus()}</p>
        <div class="notify-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="enable-notifications">开启提醒</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="test-notification">发一条测试提醒</button>
        </div>
      </fieldset>
      <fieldset class="periods" id="installSection" hidden>
        <legend>安装</legend>
        <p class="notify-status">装到桌面后可以像 App 一样打开，断网也能查看课表。</p>
        <button type="button" class="btn btn-ghost btn-sm" data-action="install-app">安装到桌面</button>
      </fieldset>
      <div class="danger-zone">
        <div>
          <strong>清空数据</strong>
          <span>删除全部课程和作业，账号、节次时间保留。</span>
        </div>
        <button type="button" class="btn btn-danger" data-action="clear-data">清空</button>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" data-action="demo-data">载入示例数据</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" data-action="close-dialog">取消</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`;

  dialog.showModal();
  if (installEvent) {
    const installSection = $("#installSection");
    if (installSection) installSection.hidden = false;
  }

  $("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const periods = state.periods.map((period) => ({
      slot: period.slot,
      start: form.elements[`start-${period.slot}`].value,
      end: form.elements[`end-${period.slot}`].value,
    }));
    for (const period of periods) {
      if (!period.start || !period.end) {
        return alert(`第 ${period.slot} 节的时间没填完`);
      }
      if (period.end <= period.start) {
        return alert(`第 ${period.slot} 节的结束时间要晚于开始时间`);
      }
    }
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ termStart: form.termStart.value }),
      });
      await api("/api/periods", { method: "PUT", body: JSON.stringify({ periods }) });
      dialog.close();
      await loadData();
      renderApp();
    } catch (error) {
      alert(error.message);
    }
  });
}

/* ---------- 主题 / 快捷键 / 提醒 / PWA ---------- */

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "";
  localStorage.setItem("theme", dark ? "dark" : "light");
  const meta = document.getElementById("themeColor");
  if (meta) meta.setAttribute("content", dark ? "#0f1413" : "#13181a");
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

function openShortcutsDialog() {
  const dialog = $("#dialog");
  dialog.innerHTML = `
    <div class="dialog-form">
      <h2>键盘快捷键</h2>
      <dl class="shortcuts">
        <div><dt><kbd>N</kbd></dt><dd>新建课程或作业</dd></div>
        <div><dt><kbd>1</kbd> <kbd>2</kbd></dt><dd>切换课表 / 作业</dd></div>
        <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>上一周 / 下一周</dd></div>
        <div><dt><kbd>T</kbd></dt><dd>回到本周</dd></div>
        <div><dt><kbd>/</kbd></dt><dd>搜索作业</dd></div>
        <div><dt><kbd>D</kbd></dt><dd>切换深浅色</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>关闭弹窗</dd></div>
      </dl>
      <div class="dialog-actions">
        <span class="spacer"></span>
        <button type="button" class="btn btn-primary" data-action="close-dialog">知道了</button>
      </div>
    </div>`;
  dialog.showModal();
}

function reminderStatus() {
  if (!("Notification" in window)) return "当前浏览器不支持通知";
  if (Notification.permission === "denied") return "通知被浏览器拒绝，需要在站点设置里恢复";
  if (Notification.permission !== "granted") return "未开启";
  return localStorage.getItem("reminders.enabled") === "1"
    ? "已开启，作业到期前会提醒"
    : "已授权，点下面的按钮启用";
}

async function enableNotifications() {
  if (!("Notification" in window)) return alert("当前浏览器不支持通知");
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return alert("没有拿到通知权限。可以在浏览器地址栏左侧的站点设置里允许通知后重试。");
  }
  localStorage.setItem("reminders.enabled", "1");
  const status = $("#notifyStatus");
  if (status) status.textContent = reminderStatus();
  checkReminders({ force: true });
}

function sendTestNotification() {
  if (!("Notification" in window)) return alert("当前浏览器不支持通知");
  if (Notification.permission !== "granted") return alert("先点「开启提醒」并允许通知");
  new Notification("这是一条测试提醒", {
    body: "作业快到截止日期时，会收到这样的提醒。",
    icon: "./icon-192.png",
    tag: "test-reminder",
  });
}

function checkReminders({ force = false } = {}) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (localStorage.getItem("reminders.enabled") !== "1") return;

  const today = isoDate(new Date());
  const tomorrow = isoDate(new Date(Date.now() + 86400000));
  const pending = state.assignments.filter((item) => !item.done && item.due_date <= tomorrow);
  if (!pending.length) return;

  const key = `reminders.last.${today}`;
  if (!force && localStorage.getItem(key) === "1") return;

  const names = pending.slice(0, 3).map((item) => item.title).join("、");
  const body = pending.length > 3
    ? `${names} 等 ${pending.length} 条作业即将到期`
    : `${names} 即将到期`;
  try {
    new Notification("作业提醒", { body, icon: "./icon-192.png", tag: "assignment-reminder" });
    localStorage.setItem(key, "1");
  } catch {
    // 个别浏览器只允许通过 Service Worker 发通知，失败时静默跳过
  }
}

let installEvent = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installEvent = event;
});

async function promptInstall() {
  if (!installEvent) {
    return alert("当前浏览器没有提供安装入口，可以试试浏览器菜单里的「安装应用」。");
  }
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

/* ---------- 事件 ---------- */

document.addEventListener("click", async (event) => {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;

  if (action === "reload") return location.reload();
  if (action === "prev-week") { state.week = Math.max(1, state.week - 1); return renderApp(); }
  if (action === "next-week") { state.week += 1; return renderApp(); }
  if (action === "this-week") { state.week = weekNumberToday(); return renderApp(); }
  if (action === "tab") { state.tab = trigger.dataset.tab; return renderApp(); }
  if (action === "print") {
    if (state.tab !== "timetable") {
      state.tab = "timetable";
      renderApp();
    }
    setTimeout(() => window.print(), 150);
    return;
  }
  if (action === "close-dialog") return $("#dialog").close();
  if (action === "add") {
    return state.tab === "timetable" ? openCourseDialog() : openAssignmentDialog();
  }
  if (action === "add-course") {
    return openCourseDialog({
      weekday: Number(trigger.dataset.weekday),
      slot: Number(trigger.dataset.slot),
    });
  }
  if (action === "edit-course") {
    const course = state.courses.find((item) => item.id === Number(trigger.dataset.id));
    return openCourseDialog({ course });
  }
  if (action === "delete-course") {
    if (!confirm("删除这门课？关联的作业会保留，但不再显示课程名。")) return;
    await api(`/api/courses/${trigger.dataset.id}`, { method: "DELETE" });
    $("#dialog").close();
    await loadData();
    return renderApp();
  }
  if (action === "delete-assignment") {
    if (!confirm("删除这条作业？")) return;
    await api(`/api/assignments/${trigger.dataset.id}`, { method: "DELETE" });
    await loadData();
    return renderApp();
  }
  if (action === "settings") return openSettingsDialog();
  if (action === "demo-data") {
    try {
      await api("/api/demo-data", { method: "POST" });
      $("#dialog").close();
      await loadData();
      renderApp();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  if (action === "clear-data") {
    if (!confirm("将删除全部课程和作业，无法恢复。确定清空吗？")) return;
    try {
      await api("/api/data/clear", { method: "POST" });
      $("#dialog").close();
      await loadData();
      renderApp();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  if (action === "toggle-theme") return toggleTheme();
  if (action === "shortcuts") return openShortcutsDialog();
  if (action === "task-status") {
    state.taskStatus = trigger.dataset.status;
    document.querySelectorAll('[data-action="task-status"]').forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.status === state.taskStatus));
    });
    $("#taskListWrap").innerHTML = renderTaskList();
    return;
  }
  if (action === "enable-notifications") return enableNotifications();
  if (action === "test-notification") return sendTestNotification();
  if (action === "install-app") return promptInstall();
  if (action === "logout") {
    await api("/api/logout", { method: "POST" });
    return location.reload();
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.id === "courseFilter") {
    state.courseFilter = event.target.value;
    $("#taskListWrap").innerHTML = renderTaskList();
    return;
  }
  const trigger = event.target.closest('[data-action="toggle"]');
  if (!trigger) return;
  try {
    await api(`/api/assignments/${trigger.dataset.id}`, {
      method: "PATCH",
      body: JSON.stringify({ done: trigger.checked }),
    });
    await loadData();
    renderApp();
  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "taskSearch") return;
  state.taskQuery = event.target.value;
  const wrap = $("#taskListWrap");
  if (wrap) wrap.innerHTML = renderTaskList();
});

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest("input, textarea, select, [contenteditable]")) return;
  const dialog = $("#dialog");
  if (dialog && dialog.open) return;

  if (event.key === "n" || event.key === "N") {
    event.preventDefault();
    return state.tab === "timetable" ? openCourseDialog() : openAssignmentDialog();
  }
  if (event.key === "1") { state.tab = "timetable"; return renderApp(); }
  if (event.key === "2") { state.tab = "assignments"; return renderApp(); }
  if (event.key === "t" || event.key === "T") { state.week = weekNumberToday(); return renderApp(); }
  if (event.key === "d" || event.key === "D") return toggleTheme();
  if (event.key === "?") { event.preventDefault(); return openShortcutsDialog(); }
  if (event.key === "/") {
    if (state.tab === "assignments") {
      event.preventDefault();
      $("#taskSearch")?.focus();
    }
    return;
  }
  if (state.tab === "timetable" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    state.week = Math.max(1, state.week + (event.key === "ArrowRight" ? 1 : -1));
    return renderApp();
  }
});

boot();
