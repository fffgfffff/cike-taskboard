/* ==========================================================================
 * 任务排程 · 宿主半侧
 *
 * 职责只有三件：
 *   1. 把任务/设置/历史存成一份本地 JSON（原子写入，自动备份）；
 *   2. 跨天时先归档、再把昨天没打勾的任务顺延到今天（首次运行不搬运）；
 *   3. 在 DSH WebServer 上挂 `/dsh-taskboard` 路由，供浏览器半侧读写。
 *
 * 排程算法在 ./scheduler.js ——浏览器半侧用同一份源码排程，宿主不重复实现。
 * ========================================================================== */

import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SETTINGS,
  addDays,
  estimateOf,
  fromMinutes,
  localDateKey,
  normalizeDateTime,
  priorityOf,
  toMinutes,
} from './scheduler.js';

export const name = 'dsh-taskboard';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-taskboard';
const STATE_VERSION = 1;
const HISTORY_LIMIT_DAYS = 120;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ACTION_HEADER = 'x-dsh-taskboard';
const ACTION_HEADER_VALUE = '1';

/* ------------------------------------------------------------------ 路径 */

export function dataRoot() {
  const home = process.env.DSH_HOME ? String(process.env.DSH_HOME) : join(homedir(), '.dsh');
  return join(home, 'dsh-taskboard');
}

function nowIso() {
  return new Date().toISOString();
}

function genId() {
  return 't_' + Date.now().toString(36) + '_' + randomBytes(3).toString('hex');
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function timeOr(value, fallback) {
  return toMinutes(value) === null ? fallback : String(value).trim();
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

/* ------------------------------------------------------------ 规范化/迁移 */

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    workStart: timeOr(src.workStart ?? DEFAULT_SETTINGS.workStart, DEFAULT_SETTINGS.workStart),
    workEnd: timeOr(src.workEnd ?? DEFAULT_SETTINGS.workEnd, DEFAULT_SETTINGS.workEnd),
    lunchStart: timeOr(src.lunchStart ?? DEFAULT_SETTINGS.lunchStart, DEFAULT_SETTINGS.lunchStart),
    lunchEnd: timeOr(src.lunchEnd ?? DEFAULT_SETTINGS.lunchEnd, DEFAULT_SETTINGS.lunchEnd),
    lunchOn: src.lunchOn !== false,
    autoCarry: src.autoCarry !== false,
    defaultEstimateMin: clampInt(src.defaultEstimateMin, 5, 480, DEFAULT_SETTINGS.defaultEstimateMin),
    remindersOn: src.remindersOn !== false,
    reminderLeadMin: clampInt(src.reminderLeadMin, 1, 60, 5),
    reminderSound: src.reminderSound !== false,
    todayOverride: null,
  };

  const override = src.todayOverride;
  if (override && typeof override === 'object' && isDateKey(override.date)) {
    const normalized = { date: override.date };
    for (const key of ['workStart', 'workEnd', 'lunchStart', 'lunchEnd']) {
      if (override[key] !== undefined && override[key] !== null && toMinutes(override[key]) !== null) {
        normalized[key] = timeOr(override[key], DEFAULT_SETTINGS[key]);
      }
    }
    if (override.lunchOn !== undefined) normalized.lunchOn = override.lunchOn !== false;
    out.todayOverride = normalized;
  }
  return out;
}

export function normalizeTask(raw, today) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!title) return null;

  const date = isDateKey(raw.date) ? String(raw.date) : today;
  const estimateMin = clampInt(raw.estimateMin, 1, 24 * 60, DEFAULT_SETTINGS.defaultEstimateMin);
  const actualMin = raw.actualMin === null || raw.actualMin === undefined || raw.actualMin === ''
    ? null
    : clampInt(raw.actualMin, 0, 24 * 60, null);
  const order = Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0;

  return {
    id: String(raw.id || genId()).slice(0, 80),
    title,
    note: String(raw.note ?? '').slice(0, 4000),
    priority: priorityOf(raw),
    estimateMin,
    dueAt: normalizeDateTime(raw.dueAt),
    pinnedStart: normalizeDateTime(raw.pinnedStart),
    date,
    done: raw.done === true,
    carried: raw.carried === true,
    actualMin,
    order,
    createdAt: normalizeDateTime(raw.createdAt) || nowIso(),
    doneAt: raw.doneAt ? normalizeDateTime(raw.doneAt) : null,
  };
}

export function normalizeVirtualTask(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!title) return null;
  const minutes = raw.pinnedTime === null || raw.pinnedTime === undefined ? null : toMinutes(raw.pinnedTime);
  return {
    id: String(raw.id || genId()).slice(0, 80),
    title,
    priority: priorityOf(raw),
    estimateMin: clampInt(raw.estimateMin, 1, 24 * 60, DEFAULT_SETTINGS.defaultEstimateMin),
    pinnedTime: minutes === null ? null : fromMinutes(minutes),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    createdAt: normalizeDateTime(raw.createdAt) || nowIso(),
  };
}

export function normalizeVirtual(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const tasks = Array.isArray(src.tasks)
    ? src.tasks.map((task, index) => normalizeVirtualTask(task, index)).filter(Boolean)
    : [];
  return {
    tasks: tasks.map((task, index) => Object.assign({}, task, { order: index })),
    updatedAt: normalizeDateTime(src.updatedAt) || nowIso(),
  };
}

/**
 * 接受两种输入：
 *   - 本插件自己的 state（version: 1）；
 *   - 旧版原生小窗 `taskboard/data/state.json`（`{ v: 1, tasks, history, settings }`）。
 * 旧任务的字段名一致，因此只需要把顶层形状归一化。
 */
export function normalizeState(raw, today = localDateKey()) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const settings = normalizeSettings(src.settings);
  const tasks = Array.isArray(src.tasks) ? src.tasks.map((task) => normalizeTask(task, today)).filter(Boolean) : [];

  const history = {};
  if (src.history && typeof src.history === 'object') {
    for (const [date, entry] of Object.entries(src.history)) {
      if (!isDateKey(date)) continue;
      const list = Array.isArray(entry) ? entry : Array.isArray(entry?.tasks) ? entry.tasks : null;
      if (!list) continue;
      const archived = list.map((task) => normalizeTask({ ...task, date }, date)).filter(Boolean);
      history[date] = {
        date,
        archivedAt: normalizeDateTime(entry?.archivedAt) || nowIso(),
        tasks: archived,
        stats: summarizeDay(archived),
      };
    }
  }

  const meta = src.meta && typeof src.meta === 'object' ? src.meta : {};
  return {
    version: STATE_VERSION,
    settings,
    tasks,
    history,
    virtual: normalizeVirtual(src.virtual),
    meta: {
      firstRunDate: isDateKey(meta.firstRunDate) ? meta.firstRunDate : isDateKey(src.settings?.lastCarry) ? src.settings.lastCarry : today,
      lastRolloverDate: isDateKey(meta.lastRolloverDate)
        ? meta.lastRolloverDate
        : isDateKey(src.settings?.lastCarry)
          ? src.settings.lastCarry
          : null,
      createdAt: normalizeDateTime(meta.createdAt) || nowIso(),
      updatedAt: normalizeDateTime(meta.updatedAt) || nowIso(),
    },
  };
}

export function emptyState(today = localDateKey()) {
  return {
    version: STATE_VERSION,
    settings: normalizeSettings({}),
    tasks: [],
    history: {},
    virtual: normalizeVirtual(null),
    meta: {
      firstRunDate: today,
      lastRolloverDate: today,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  };
}

function summarizeDay(tasks) {
  const total = tasks.length;
  const done = tasks.filter((task) => task.done).length;
  return {
    total,
    done,
    undone: total - done,
    estimateMin: tasks.reduce((sum, task) => sum + estimateOf(task, DEFAULT_SETTINGS), 0),
    doneMin: tasks.filter((task) => task.done).reduce((sum, task) => sum + estimateOf(task, DEFAULT_SETTINGS), 0),
  };
}

function archiveIntoHistory(state, tasks, now) {
  const byDate = new Map();
  for (const task of tasks) {
    if (!byDate.has(task.date)) byDate.set(task.date, []);
    byDate.get(task.date).push(task);
  }
  for (const [date, list] of byDate) {
    state.history[date] = {
      date,
      archivedAt: now.toISOString(),
      tasks: list.map((task) => ({ ...task })),
      stats: summarizeDay(list),
    };
  }
}

/* ---------------------------------------------------------------- 跨天顺延 */

/**
 * 跨天处理：先按天归档，再把未完成任务顺延到今天（`autoCarry` 关闭时留在归档里）。
 * 第一次运行（`lastRolloverDate` 为空）只落锚点，不搬运任何历史任务。
 * @returns {boolean} 状态是否被修改
 */
export function rollover(state, today = localDateKey(), now = new Date()) {
  let changed = false;
  state.meta = state.meta && typeof state.meta === 'object' ? state.meta : {};

  if (!state.meta.firstRunDate) {
    state.meta.firstRunDate = today;
    changed = true;
  }
  if (!state.meta.lastRolloverDate) {
    state.meta.lastRolloverDate = today;
    state.meta.firstRunDate = state.meta.firstRunDate || today;
    changed = true;
    // 首次运行：只归档更早的遗留，不搬进今天（E8）。
    const past = state.tasks.filter((task) => task.date < today);
    if (past.length > 0) {
      archiveIntoHistory(state, past, now);
      state.tasks = state.tasks.filter((task) => task.date >= today);
    }
    if (state.settings.todayOverride && state.settings.todayOverride.date !== today) {
      state.settings.todayOverride = null;
    }
    return changed;
  }

  if (state.meta.lastRolloverDate === today) {
    if (state.settings.todayOverride && state.settings.todayOverride.date !== today) {
      state.settings.todayOverride = null;
      changed = true;
    }
    return changed;
  }

  const past = state.tasks.filter((task) => task.date < today);
  const keep = state.tasks.filter((task) => task.date >= today);

  if (past.length > 0) {
    archiveIntoHistory(state, past, now);

    let nextOrder = keep.reduce((max, task) => Math.max(max, Number(task.order) || 0), 0) + 1;
    const carried = [];
    if (state.settings.autoCarry !== false) {
      for (const task of past) {
        if (task.done) continue;
        carried.push({
          ...task,
          date: today,
          carried: true,
          done: false,
          doneAt: null,
          order: nextOrder++,
        });
      }
    }
    state.tasks = [...keep, ...carried];
  } else {
    state.tasks = keep;
  }

  for (const key of Object.keys(state.history).sort()) {
    if (Object.keys(state.history).length <= HISTORY_LIMIT_DAYS) break;
    delete state.history[key];
  }

  if (state.settings.todayOverride && state.settings.todayOverride.date !== today) {
    state.settings.todayOverride = null;
  }

  state.meta.lastRolloverDate = today;
  return true;
}

/* ------------------------------------------------------------------ 存储 */

export class TaskStore {
  constructor(root = dataRoot()) {
    this.root = root;
    this.file = join(root, 'state.json');
    this.backupFile = join(root, 'state.bak.json');
    this.state = null;
    this.mtimeMs = 0;
  }

  ensureDir() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.root, 0o700);
    } catch {
      /* Windows/受限文件系统忽略 */
    }
  }

  load() {
    this.ensureDir();
    if (!existsSync(this.file)) {
      this.state = emptyState();
      this.persist();
      return this.state;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.state = normalizeState(raw);
      this.mtimeMs = statSync(this.file).mtimeMs;
      try {
        copyFileSync(this.file, this.backupFile);
        try {
          chmodSync(this.backupFile, 0o600);
        } catch {
          /* Windows/受限文件系统忽略 */
        }
      } catch {
        /* 备份失败不影响主流程 */
      }
    } catch (error) {
      // 文件坏了：留证据，再从备份恢复；备份也坏就开一份新的空状态。
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corrupt = this.file + '.corrupt-' + stamp;
      try {
        copyFileSync(this.file, corrupt);
      } catch {
        /* ignore */
      }
      let recovered = null;
      try {
        recovered = normalizeState(JSON.parse(readFileSync(this.backupFile, 'utf8')));
      } catch {
        /* ignore */
      }
      console.error('[dsh-taskboard] state.json 无法读取，已保留副本 ' + corrupt + '：' + (error?.message || error));
      this.state = recovered || emptyState();
      this.persist();
    }
    return this.state;
  }

  read() {
    if (!this.state) {
      this.load();
    } else {
      // 用户直接改文件时也能读到新内容（同进程写入会刷新 mtime）。
      try {
        const stat = statSync(this.file);
        if (stat.mtimeMs !== this.mtimeMs) this.load();
      } catch {
        /* 文件暂不可读时沿用内存状态 */
      }
    }
    const changed = rollover(this.state);
    if (changed) this.persist();
    return this.state;
  }

  persist() {
    this.ensureDir();
    this.state.meta.updatedAt = nowIso();
    const text = JSON.stringify(this.state, null, 2);
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    this.mtimeMs = statSync(this.file).mtimeMs;
    return this.state;
  }

  snapshot() {
    const state = this.read();
    return {
      ok: true,
      version: STATE_VERSION,
      today: localDateKey(),
      now: nowIso(),
      dataFile: this.file,
      state,
    };
  }

  /** 执行一个动作并持久化；失败抛 HttpError（带状态码与错误码）。 */
  dispatch(action, payload) {
    const state = this.read();
    const today = localDateKey();
    const input = payload && typeof payload === 'object' ? payload : {};

    switch (action) {
      case 'addTask': {
        const title = String(input.title ?? '').trim();
        if (!title) throw new HttpError(400, 'title_required', '任务内容不能为空');
        const targetDate = isDateKey(input.date) && input.date >= today ? input.date : today;
        const maxOrder = state.tasks
          .filter((task) => task.date === targetDate)
          .reduce((max, task) => Math.max(max, Number(task.order) || 0), 0);
        state.tasks.push({
          id: genId(),
          title: title.slice(0, 500),
          note: '',
          priority: clampInt(input.priority, 0, 3, 2),
          estimateMin: clampInt(input.estimateMin, 1, 24 * 60, state.settings.defaultEstimateMin),
          dueAt: normalizeDateTime(input.dueAt),
          pinnedStart: normalizeDateTime(input.pinnedStart),
          date: targetDate,
          done: false,
          carried: false,
          actualMin: null,
          order: maxOrder + 1,
          createdAt: nowIso(),
          doneAt: null,
        });
        break;
      }

      case 'updateTask': {
        const task = state.tasks.find((item) => item.id === input.id);
        if (!task) throw new HttpError(404, 'task_not_found', '任务不存在');
        if (input.title !== undefined) {
          const title = String(input.title).replace(/\s+/g, ' ').trim();
          if (!title) throw new HttpError(400, 'title_required', '任务内容不能为空');
          task.title = title.slice(0, 500);
        }
        if (input.note !== undefined) task.note = String(input.note).slice(0, 4000);
        if (input.priority !== undefined) task.priority = clampInt(input.priority, 0, 3, task.priority);
        if (input.estimateMin !== undefined) {
          task.estimateMin = clampInt(input.estimateMin, 1, 24 * 60, task.estimateMin);
        }
        if (input.dueAt !== undefined) task.dueAt = normalizeDateTime(input.dueAt);
        if (input.pinnedStart !== undefined) task.pinnedStart = normalizeDateTime(input.pinnedStart);
        if (input.actualMin !== undefined) {
          task.actualMin =
            input.actualMin === null || input.actualMin === ''
              ? null
              : clampInt(input.actualMin, 0, 24 * 60, null);
        }
        if (input.date !== undefined && isDateKey(input.date) && input.date >= today && input.date !== task.date) {
          const maxOrder = state.tasks
            .filter((item) => item.date === input.date && item.id !== task.id)
            .reduce((max, item) => Math.max(max, Number(item.order) || 0), 0);
          task.date = input.date;
          task.order = maxOrder + 1;
        }
        break;
      }

      case 'toggleTask': {
        const task = state.tasks.find((item) => item.id === input.id);
        if (!task) throw new HttpError(404, 'task_not_found', '任务不存在');
        task.done = !task.done;
        task.doneAt = task.done ? nowIso() : null;
        // 由客户端按「计划开始 → 现在」估一个实际耗时；已有实际值不覆盖。
        if (task.done && input.actualMin !== undefined && task.actualMin === null) {
          task.actualMin = clampInt(input.actualMin, 0, 24 * 60, null);
        }
        break;
      }

      case 'deleteTask': {
        const before = state.tasks.length;
        state.tasks = state.tasks.filter((task) => task.id !== input.id);
        if (state.tasks.length === before) throw new HttpError(404, 'task_not_found', '任务不存在');
        break;
      }

      case 'setActual': {
        const task = state.tasks.find((item) => item.id === input.id);
        if (!task) throw new HttpError(404, 'task_not_found', '任务不存在');
        task.actualMin =
          input.actualMin === null || input.actualMin === ''
            ? null
            : clampInt(input.actualMin, 0, 24 * 60, null);
        break;
      }

      case 'reorder': {
        const ids = Array.isArray(input.ids) ? input.ids : [];
        const index = new Map(ids.map((id, i) => [String(id), i]));
        for (const task of state.tasks) {
          if (index.has(task.id)) task.order = index.get(task.id);
        }
        break;
      }

      case 'carryToTomorrow': {
        const task = state.tasks.find((item) => item.id === input.id);
        if (!task) throw new HttpError(404, 'task_not_found', '任务不存在');
        const targetDate = addDays(task.date || today, 1);
        const maxOrder = state.tasks
          .filter((item) => item.date === targetDate)
          .reduce((max, item) => Math.max(max, Number(item.order) || 0), 0);
        task.date = targetDate;
        task.carried = true;
        task.done = false;
        task.doneAt = null;
        task.order = maxOrder + 1;
        break;
      }

      case 'saveSettings': {
        const merged = { ...state.settings, ...(input.settings || input) };
        // 只接受已知字段，避免把任意键写进设置。
        const next = normalizeSettings({
          workStart: merged.workStart,
          workEnd: merged.workEnd,
          lunchStart: merged.lunchStart,
          lunchEnd: merged.lunchEnd,
          lunchOn: merged.lunchOn,
          autoCarry: merged.autoCarry,
          defaultEstimateMin: merged.defaultEstimateMin,
          remindersOn: merged.remindersOn,
          reminderLeadMin: merged.reminderLeadMin,
          reminderSound: merged.reminderSound,
          todayOverride: state.settings.todayOverride,
        });
        state.settings = next;
        break;
      }

      case 'setTodayOverride': {
        if (input.clear === true) {
          state.settings.todayOverride = null;
          break;
        }
        const normalized = normalizeSettings({
          ...state.settings,
          todayOverride: {
            date: today,
            workStart: input.workStart,
            workEnd: input.workEnd,
            lunchStart: input.lunchStart,
            lunchEnd: input.lunchEnd,
            lunchOn: input.lunchOn,
          },
        });
        state.settings.todayOverride = normalized.todayOverride;
        break;
      }

      case 'clearHistory': {
        state.history = {};
        break;
      }

      case 'virtualAdd': {
        const virtual = state.virtual || (state.virtual = normalizeVirtual(null));
        const title = String(input.title ?? '').trim();
        if (!title) throw new HttpError(400, 'title_required', '任务内容不能为空');
        const maxOrder = virtual.tasks.reduce((max, task) => Math.max(max, Number(task.order) || 0), 0);
        virtual.tasks.push(
          normalizeVirtualTask(
            {
              title,
              priority: input.priority,
              estimateMin: input.estimateMin,
              pinnedTime: input.pinnedTime,
              order: maxOrder + 1,
            },
            virtual.tasks.length,
          ),
        );
        virtual.updatedAt = nowIso();
        break;
      }

      case 'virtualUpdate': {
        const virtual = state.virtual || (state.virtual = normalizeVirtual(null));
        const task = virtual.tasks.find((item) => item.id === input.id);
        if (!task) throw new HttpError(404, 'virtual_task_not_found', '虚拟任务不存在');
        if (input.title !== undefined) {
          const title = String(input.title).replace(/\s+/g, ' ').trim();
          if (!title) throw new HttpError(400, 'title_required', '任务内容不能为空');
          task.title = title.slice(0, 500);
        }
        if (input.priority !== undefined) task.priority = clampInt(input.priority, 0, 3, task.priority);
        if (input.estimateMin !== undefined) {
          task.estimateMin = clampInt(input.estimateMin, 1, 24 * 60, task.estimateMin);
        }
        if (input.pinnedTime !== undefined) {
          const minutes = input.pinnedTime === null || input.pinnedTime === '' ? null : toMinutes(input.pinnedTime);
          task.pinnedTime = minutes === null ? null : fromMinutes(minutes);
        }
        virtual.updatedAt = nowIso();
        break;
      }

      case 'virtualDelete': {
        const virtual = state.virtual || (state.virtual = normalizeVirtual(null));
        const before = virtual.tasks.length;
        virtual.tasks = virtual.tasks.filter((item) => item.id !== input.id);
        if (virtual.tasks.length === before) throw new HttpError(404, 'virtual_task_not_found', '虚拟任务不存在');
        virtual.updatedAt = nowIso();
        break;
      }

      case 'virtualReorder': {
        const virtual = state.virtual || (state.virtual = normalizeVirtual(null));
        const ids = Array.isArray(input.ids) ? input.ids : [];
        const index = new Map(ids.map((id, i) => [String(id), i]));
        virtual.tasks.forEach((task) => {
          if (index.has(task.id)) task.order = index.get(task.id);
        });
        virtual.tasks.sort((a, b) => a.order - b.order);
        virtual.updatedAt = nowIso();
        break;
      }

      case 'virtualClear': {
        state.virtual = normalizeVirtual(null);
        break;
      }

      case 'virtualImport': {
        const incoming = input.data ?? input.virtual ?? input;
        const source = incoming && typeof incoming === 'object' && Array.isArray(incoming.tasks) ? incoming : { tasks: incoming };
        state.virtual = normalizeVirtual(source);
        break;
      }

      case 'virtualApply': {
        const virtual = state.virtual || (state.virtual = normalizeVirtual(null));
        if (virtual.tasks.length === 0) throw new HttpError(400, 'virtual_empty', '虚拟时间轴还是空的');
        const targetDate = isDateKey(input.date) && input.date >= today ? input.date : today;
        const copies = virtual.tasks.map((task, index) => ({
          id: genId(),
          title: task.title,
          note: '',
          priority: task.priority,
          estimateMin: task.estimateMin,
          dueAt: null,
          pinnedStart: task.pinnedTime ? targetDate + 'T' + task.pinnedTime : null,
          date: targetDate,
          done: false,
          carried: false,
          actualMin: null,
          order: index + 1,
          createdAt: nowIso(),
          doneAt: null,
        }));
        state.tasks = state.tasks.filter((task) => task.date !== targetDate).concat(copies);
        break;
      }

      case 'importState': {
        const incoming = input.data ?? input.state ?? input;
        const imported = normalizeState(incoming, today);
        // 导入的旧任务：未完成的搬进今天（保留截止时间），已完成的进历史。
        const legacy = imported.tasks.filter((task) => task.date !== today);
        if (legacy.length > 0) {
          let nextOrder = imported.tasks
            .filter((task) => task.date === today)
            .reduce((max, task) => Math.max(max, Number(task.order) || 0), 0) + 1;
          const todayTasks = imported.tasks.filter((task) => task.date === today);
          const archived = { ...imported.history };
          for (const task of legacy) {
            if (task.done) {
              const date = task.date || today;
              if (!archived[date]) archived[date] = { date, archivedAt: nowIso(), tasks: [], stats: null };
              archived[date].tasks.push({ ...task, date });
            } else {
              todayTasks.push({ ...task, date: today, carried: true, order: nextOrder++ });
            }
          }
          for (const entry of Object.values(archived)) entry.stats = summarizeDay(entry.tasks || []);
          imported.tasks = todayTasks;
          imported.history = archived;
        }
        imported.meta.lastRolloverDate = today;
        imported.meta.firstRunDate = isDateKey(imported.meta.firstRunDate) ? imported.meta.firstRunDate : today;
        state.version = STATE_VERSION;
        state.settings = imported.settings;
        state.tasks = imported.tasks;
        state.history = imported.history;
        state.virtual = imported.virtual || normalizeVirtual(null);
        state.meta = imported.meta;
        break;
      }

      default:
        throw new HttpError(400, 'unknown_action', '未知动作：' + String(action));
    }

    this.persist();
    return this.snapshot();
  }
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ HTTP */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * 只接受同源页面发起的动作请求：
 *   - 自定义头会让跨站请求先走 CORS 预检，而本服务不返回放行头；
 *   - 再校验 content-type / Origin / Sec-Fetch-Site，防表单/beacon 类 CSRF。
 */
function assertActionRequest(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/.test(type)) {
    throw new HttpError(415, 'content_type_required', '动作请求必须是 application/json');
  }
  if (req.headers[ACTION_HEADER] !== ACTION_HEADER_VALUE) {
    throw new HttpError(403, 'action_header_required', '缺少任务排程动作头');
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'origin_rejected', '请求来源无效');
    }
    if (!req.headers.host || originHost !== req.headers.host) {
      throw new HttpError(403, 'origin_rejected', '拒绝跨站动作请求');
    }
  }
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'origin_rejected', '拒绝跨站动作请求');
  }
}

async function readBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body_too_large', '提交内容过大');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', '提交内容过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHandler(store) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const path = url.pathname.startsWith(ROUTE_PREFIX)
        ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
        : url.pathname;

      // 不实现 CORS 预检：跨站自定义头请求直接失败，避免被页面改写数据。
      if (req.method === 'OPTIONS') {
        return sendJson(res, 405, { ok: false, error: { code: 'cors_not_allowed', message: '不支持跨站请求' } });
      }

      if (req.method === 'GET' && (path === '/' || path === '/state')) {
        return sendJson(res, 200, store.snapshot());
      }

      if (req.method === 'GET' && path === '/export') {
        const snapshot = store.snapshot();
        const text = JSON.stringify(snapshot.state, null, 2);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="taskboard-${snapshot.today}.json"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-length': Buffer.byteLength(text),
        });
        return res.end(text);
      }

      if (req.method === 'POST' && path === '/action') {
        assertActionRequest(req);
        const raw = await readBody(req);
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON');
        }
        const result = store.dispatch(body.action, body.payload);
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { ok: false, error: { code: 'not_found', message: '未知接口' } });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) {
        console.error('[dsh-taskboard] 路由处理失败：', error);
      }
      return sendJson(res, status, {
        ok: false,
        error: {
          code: error instanceof HttpError ? error.code : 'internal_error',
          message: status >= 500 ? '服务器内部错误' : error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
}

/* -------------------------------------------------------------- 插件入口 */

export function apply(ctx) {
  const store = new TaskStore(dataRoot());
  try {
    store.read();
  } catch (error) {
    console.error('[dsh-taskboard] 初始化本地状态失败：', error);
  }

  const handler = createHandler(store);
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler,
      }),
    'dsh-taskboard: local state routes',
  );
}

/** 测试/诊断用：路由前缀。 */
export const routePrefix = ROUTE_PREFIX;
