/* dsh-taskboard 浏览器半侧 · 由 scripts/build.mjs 生成，请改 src/ 里的源码 */
window.__ModuleLoader__.load({
  id: 'dsh-taskboard',
  factory(require) {
'use strict';

/* ==========================================================================
 * 任务排程核心算法（宿主、浏览器、测试三处共用）
 *
 * 规则来自《需求说明书》第 2.4 / 4 节：
 *   1. 钉住的任务先按钉住时刻落位，不参与排序；
 *   2. 其余任务按「已过期优先 → 截止时间近 → 优先级高 → 添加顺序」排序；
 *   3. 每件事放进「最早放得下它的空档」：不切分、不跨午休、不与他人重叠；
 *   4. 所有空档都放不下 → 进「没排上」，由使用者决定顺延还是删除；
 *   5. 可用时长 < 任务总时长 → 超载；不自动删除、不自动降级任何任务。
 *
 * 日期一律用本地日期键 `YYYY-MM-DD`，时刻用 `YYYY-MM-DDTHH:mm` 的本地
 * 字符串（不带时区），避免浏览器与宿主跨时区解释成不同的一天。
 * ========================================================================== */

const DEFAULT_ESTIMATE_MIN = 30;

const DEFAULT_SETTINGS = Object.freeze({
  workStart: '09:00',
  workEnd: '18:00',
  lunchStart: '12:00',
  lunchEnd: '13:00',
  lunchOn: true,
  autoCarry: true,
  defaultEstimateMin: DEFAULT_ESTIMATE_MIN,
});

const PRIORITY_LABELS = Object.freeze(['P0', 'P1', 'P2', 'P3']);

/* ---------------------------------------------------------------- 时间工具 */

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function fromMinutes(value) {
  const v = Math.max(0, Math.min(1440, Math.round(Number(value) || 0)));
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

function localDateKey(value) {
  const d = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

/** 解析 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`（也接受空格分隔）；无效返回 null。 */
function parseLocalDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value).trim());
  if (!m) return null;
  if (Number(m[4] ?? 0) > 23 || Number(m[5] ?? 0) > 59 || Number(m[6] ?? 0) > 59) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    0,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 把任意可解析的时刻规范成 `YYYY-MM-DDTHH:mm`；空值返回 null。 */
function normalizeDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = parseLocalDateTime(value);
  if (!d) return null;
  return (
    localDateKey(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  );
}

function addDays(dateKey, days) {
  const d = parseLocalDateTime(dateKey + 'T00:00');
  if (!d) return dateKey;
  d.setDate(d.getDate() + Number(days || 0));
  return localDateKey(d);
}

/** `90` → `1h30m`；`45` → `45m`；负数原样带符号。 */
function formatDuration(minutes) {
  const n = Math.round(Number(minutes) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return sign + m + 'm';
  if (m === 0) return sign + h + 'h';
  return sign + h + 'h' + String(m).padStart(2, '0') + 'm';
}

function formatClock(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '--:--';
  return fromMinutes(n);
}

function weekdayLabel(dateKey) {
  const d = parseLocalDateTime(dateKey + 'T00:00');
  if (!d) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '';
}

function dateLabel(dateKey, todayKey) {
  const d = parseLocalDateTime(dateKey + 'T00:00');
  if (!d) return dateKey || '';
  const base = d.getMonth() + 1 + '月' + d.getDate() + '日';
  if (todayKey === dateKey) return '今天 · ' + base;
  if (todayKey && addDays(todayKey, -1) === dateKey) return '昨天 · ' + base;
  if (todayKey && addDays(todayKey, 1) === dateKey) return '明天 · ' + base;
  return base;
}

/* ------------------------------------------------------------ 设置与时间窗 */

/** 今天生效的设置：`todayOverride.date === dateKey` 时覆盖对应字段。 */
function effectiveSettings(settings, dateKey) {
  const base = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const override = base.todayOverride;
  if (override && override.date === dateKey) {
    for (const key of ['workStart', 'workEnd', 'lunchStart', 'lunchEnd', 'lunchOn']) {
      if (override[key] !== undefined && override[key] !== null) base[key] = override[key];
    }
  }
  return base;
}

/**
 * 把一天切成连续可排时段。
 * @returns {{settings: object, segments: Array<{start:number,end:number}>, lunch: {start:number,end:number}|null, availableMin: number}}
 */
function workWindows(settings, dateKey) {
  const s = effectiveSettings(settings, dateKey);
  const start = toMinutes(s.workStart) ?? 9 * 60;
  const end = toMinutes(s.workEnd) ?? 18 * 60;
  const segments = [];
  let lunch = null;

  if (end > start) {
    const lunchStart = s.lunchOn === false ? null : toMinutes(s.lunchStart);
    const lunchEnd = s.lunchOn === false ? null : toMinutes(s.lunchEnd);
    if (lunchStart !== null && lunchEnd !== null && lunchEnd > lunchStart && lunchStart > start && lunchStart < end) {
      lunch = { start: lunchStart, end: Math.min(lunchEnd, end) };
      segments.push({ start, end: lunchStart });
      if (lunch.end < end) segments.push({ start: lunch.end, end });
    } else {
      segments.push({ start, end });
    }
  }

  return {
    settings: s,
    segments,
    lunch,
    availableMin: segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0),
  };
}

/* ------------------------------------------------------------------- 判据 */

function estimateOf(task, settings) {
  const raw = Number(task && task.estimateMin);
  if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.round(raw));
  const dflt = Number(settings && settings.defaultEstimateMin);
  return Number.isFinite(dflt) && dflt > 0 ? Math.max(1, Math.round(dflt)) : DEFAULT_ESTIMATE_MIN;
}

function isOverdue(task, now) {
  const due = parseLocalDateTime(task && task.dueAt);
  if (!due) return false;
  return due.getTime() < (now instanceof Date ? now.getTime() : Number(now) || Date.now());
}

function priorityOf(task) {
  const p = Math.round(Number(task && task.priority));
  return Number.isFinite(p) ? Math.max(0, Math.min(3, p)) : 2;
}

/** 自动分段时，单个碎片小于这个分钟数就不切开，留给下一件小事。 */
const MIN_SPLIT_PART_MIN = 10;

/** 一个时间范围内真正落在上班时间里的分钟数（午休不计）。 */
function workMinutesBetween(settings, dateKey, startMin, endMin) {
  if (!(Number(endMin) > Number(startMin))) return 0;
  const { segments } = workWindows(settings, dateKey);
  let total = 0;
  for (const segment of segments) {
    const start = Math.max(segment.start, startMin);
    const end = Math.min(segment.end, endMin);
    if (end > start) total += end - start;
  }
  return total;
}

/** `atMin` 起最早可工作的分钟；在午休里就返回午休结束，在下班后原样返回。 */
function nextWorkMinute(settings, dateKey, atMin) {
  const { segments } = workWindows(settings, dateKey);
  for (const segment of segments) {
    if (atMin < segment.start) return segment.start;
    if (atMin >= segment.start && atMin < segment.end) return atMin;
  }
  return atMin;
}

/** 从 `startMin` 起做 `minutes` 分钟工作后的结束时刻（跨午休顺延，不含午休）。 */
function addWorkMinutes(settings, dateKey, startMin, minutes) {
  const { segments } = workWindows(settings, dateKey);
  let remaining = Math.max(0, Math.round(Number(minutes) || 0));
  let cursor = startMin;
  let end = startMin;
  for (const segment of segments) {
    if (remaining <= 0) break;
    if (segment.end <= cursor) continue;
    const start = Math.max(segment.start, cursor);
    const take = Math.min(remaining, segment.end - start);
    if (take <= 0) continue;
    remaining -= take;
    end = start + take;
    cursor = end;
  }
  if (remaining > 0) end = cursor + remaining;
  return end;
}

/* ------------------------------------------------------------------ 排程 */

/**
 * @param {Array} tasks    当天全部任务（含已完成；其它日期的会被忽略）
 * @param {object} settings
 * @param {string} dateKey 排哪一天 `YYYY-MM-DD`
 * @param {{now?: Date|number}} [options]
 */
function schedule(tasks, settings, dateKey, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const nowMs = now.getTime();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const windows = workWindows(settings, dateKey);
  const anchorMin =
    Number.isFinite(options.anchorMin) && Number(options.anchorMin) > 0
      ? Math.max(0, Math.round(Number(options.anchorMin)))
      : null;
  // 「从现在重排」时把上班时间窗裁到当前分钟；之前的时段不再参与自动排程。
  const segments =
    anchorMin === null
      ? windows.segments
      : windows.segments
          .map((segment) => Object.assign({}, segment, { start: Math.max(segment.start, anchorMin) }))
          .filter((segment) => segment.end > segment.start);
  const lunch =
    anchorMin !== null && windows.lunch && anchorMin > windows.lunch.start ? null : windows.lunch;
  const availableMin = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);

  // 当天「富余」只看实时到下班，不受早上已经排过什么影响。
  const workStartMin = windows.segments.length > 0 ? windows.segments[0].start : null;
  const workEndMin = windows.segments.length > 0 ? windows.segments[windows.segments.length - 1].end : null;
  const remainingAvailableMin =
    workStartMin === null
      ? 0
      : dateKey === localDateKey(now)
        ? workMinutesBetween(windows.settings, dateKey, Math.max(nowMin, workStartMin), workEndMin)
        : availableMin;
  const all = (tasks || []).filter((task) => task && task.date === dateKey);
  const pending = all.filter((task) => !task.done);
  const done = all.filter((task) => task.done);
  const needMin = pending.reduce((sum, task) => sum + estimateOf(task, windows.settings), 0);

  /**
   * 一天里还没被占用的可工作时间。自动任务按这些区间从头到尾连续填充：
   * 上午没干完的活会接着排到下午，不再因为午休而整体挪走。
   */
  let free = segments.map((seg, index) => ({ start: seg.start, end: seg.end, segmentIndex: index }));

  const placed = [];
  const unplaced = [];

  function nearestSegment(start) {
    if (segments.length === 0) return -1;
    let idx = 0;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= start) idx = i;
    }
    return idx;
  }

  function subtractFree(start, end) {
    if (!(end > start)) return;
    const next = [];
    for (const interval of free) {
      if (end <= interval.start || start >= interval.end) {
        next.push(interval);
        continue;
      }
      if (start > interval.start) next.push(Object.assign({}, interval, { end: start }));
      if (end < interval.end) next.push(Object.assign({}, interval, { start: end }));
    }
    free = next;
  }

  function makeEntry(task, parts, pinned, flags) {
    parts.sort((a, b) => a.startMin - b.startMin);
    parts.forEach((part, index) => {
      part.partIndex = index;
      part.partCount = parts.length;
      part.current = false;
    });
    const entry = {
      task,
      parts,
      pinned,
      flags,
      conflict: false,
      startMin: parts[0].startMin,
      endMin: parts[parts.length - 1].endMin,
      durationMin: parts.reduce((sum, part) => sum + (part.endMin - part.startMin), 0),
      split: parts.length > 1,
      current: false,
      currentPart: null,
    };
    entry.conflict = !!(
      flags.outside ||
      flags.lunch ||
      flags.overrun ||
      flags.overlap ||
      flags.overdue ||
      flags.due > 0
    );
    return entry;
  }

  /* 1. 钉住的任务先落位；长任务同样在午休处自动分段，而不是跨着午休干。 */
  const pinnedTasks = pending
    .filter((task) => task.pinnedStart)
    .sort(
      (a, b) =>
        (parseLocalDateTime(a.pinnedStart)?.getTime() ?? 0) -
        (parseLocalDateTime(b.pinnedStart)?.getTime() ?? 0),
    );

  for (const task of pinnedTasks) {
    const dt = parseLocalDateTime(task.pinnedStart);
    const duration = estimateOf(task, windows.settings);
    if (!dt) {
      unplaced.push(task);
      continue;
    }
    const startMin = dt.getHours() * 60 + dt.getMinutes();
    const sameDay = localDateKey(dt) === dateKey;
    const baseFlags = {
      outside: false,
      lunch: false,
      overrun: false,
      overlap: false,
      overdue: false,
      due: 0,
      past: false,
    };

    if (!sameDay) {
      const entry = makeEntry(
        task,
        [{ startMin, endMin: startMin + duration, segmentIndex: nearestSegment(startMin) }],
        true,
        Object.assign({}, baseFlags, { outside: true }),
      );
      placed.push(entry);
      continue;
    }

    const endMin = startMin + duration;
    const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : null;

    // 「从现在重排」后：已经整段过去的钉住任务归入「已过去」，不再占用当前空档。
    if (anchorMin !== null && endMin <= anchorMin) {
      const entry = makeEntry(
        task,
        [{ startMin, endMin, segmentIndex: nearestSegment(anchorMin) }],
        true,
        Object.assign({}, baseFlags, { outside: true, past: true }),
      );
      placed.push(entry);
      continue;
    }

    // 钉住任务在锚点之前开始、但还没结束：保留剩余部分，从锚点接着显示。
    if (anchorMin !== null && startMin < anchorMin && endMin > anchorMin) {
      const partStart = anchorMin;
      const entry = makeEntry(
        task,
        [{ startMin: partStart, endMin, segmentIndex: nearestSegment(partStart) }],
        true,
        Object.assign({}, baseFlags, { overrun: lastEnd !== null && endMin > lastEnd }),
      );
      placed.push(entry);
      for (const segment of segments) {
        const start = Math.max(partStart, segment.start);
        const end = Math.min(endMin, segment.end);
        if (end > start) subtractFree(start, end);
      }
      continue;
    }

    const firstStart = segments.length > 0 ? segments[0].start : null;
    const startInLunch = !!(lunch && startMin >= lunch.start && startMin < lunch.end);
    const beforeWork = firstStart !== null && startMin < firstStart;
    const afterWork = lastEnd !== null && startMin >= lastEnd;

    if (beforeWork || afterWork || startInLunch) {
      const entry = makeEntry(
        task,
        [{ startMin, endMin, segmentIndex: nearestSegment(startMin) }],
        true,
        Object.assign({}, baseFlags, {
          outside: beforeWork || afterWork,
          lunch: startInLunch,
          overrun: lastEnd !== null && endMin > lastEnd,
        }),
      );
      placed.push(entry);
      for (const segment of segments) {
        const start = Math.max(startMin, segment.start);
        const end = Math.min(endMin, segment.end);
        if (end > start) subtractFree(start, end);
      }
      continue;
    }

    // 从钉住时刻起，沿当天的工作段连续占用；跨午休就拆成上午/下午两段。
    const parts = [];
    let remaining = duration;
    let cursor = startMin;
    segments.forEach((segment, index) => {
      if (remaining <= 0 || segment.end <= cursor) return;
      const start = Math.max(segment.start, cursor);
      const take = Math.min(remaining, segment.end - start);
      if (take <= 0) return;
      parts.push({ startMin: start, endMin: start + take, segmentIndex: index });
      remaining -= take;
      cursor = start + take;
    });
    const overrun = remaining > 0;
    if (overrun) {
      parts.push({
        startMin: cursor,
        endMin: cursor + remaining,
        segmentIndex: nearestSegment(cursor),
      });
    }
    const entry = makeEntry(task, parts, true, Object.assign({}, baseFlags, { overrun }));
    placed.push(entry);
    for (const part of parts) {
      for (const segment of segments) {
        const start = Math.max(part.startMin, segment.start);
        const end = Math.min(part.endMin, segment.end);
        if (end > start) subtractFree(start, end);
      }
    }
  }

  /* 两个钉住任务互相重叠时，两边都标红（不只是后落位的那一个）。 */
  for (let i = 0; i < placed.length; i += 1) {
    for (let k = i + 1; k < placed.length; k += 1) {
      const a = placed[i];
      const b = placed[k];
      if (!a.pinned || !b.pinned || a.flags.outside || b.flags.outside) continue;
      const overlap = a.parts.some((pa) =>
        b.parts.some((pb) => pa.startMin < pb.endMin && pb.startMin < pa.endMin),
      );
      if (overlap) {
        a.flags.overlap = true;
        b.flags.overlap = true;
        a.conflict = true;
        b.conflict = true;
      }
    }
  }

  /* 2. 其余任务排序：过期 → 截止近 → 优先级 → 添加顺序。 */
  const rest = pending
    .filter((task) => !task.pinnedStart)
    .sort((a, b) => {
      const ao = isOverdue(a, now) ? 0 : 1;
      const bo = isOverdue(b, now) ? 0 : 1;
      if (ao !== bo) return ao - bo;

      const ad = parseLocalDateTime(a.dueAt)?.getTime() ?? Infinity;
      const bd = parseLocalDateTime(b.dueAt)?.getTime() ?? Infinity;
      if (ad !== bd) return ad - bd;

      const ap = priorityOf(a);
      const bp = priorityOf(b);
      if (ap !== bp) return ap - bp;

      const aOrd = Number(a.order);
      const bOrd = Number(b.order);
      if (Number.isFinite(aOrd) && Number.isFinite(bOrd) && aOrd !== bOrd) return aOrd - bOrd;

      return (
        (parseLocalDateTime(a.createdAt)?.getTime() ?? 0) -
        (parseLocalDateTime(b.createdAt)?.getTime() ?? 0)
      );
    });

  /**
   * 从最早的空白开始，把任务时长连续铺进去。
   * 一个任务可以横跨午休，也可以绕开钉住任务，产生多个片段。
   * 分配失败时不消耗任何空白（先拷一份再提交）。
   */
  function allocate(duration) {
    if (duration <= 0) return [];
    const working = free.map((interval) => Object.assign({}, interval));
    const parts = [];
    let remaining = duration;
    for (let i = 0; i < working.length && remaining > 0; i += 1) {
      const interval = working[i];
      const available = interval.end - interval.start;
      if (available <= 0) continue;
      const take = Math.min(remaining, available);
      // 只剩几十分钟、却要切成比 10 分钟还碎的一片时，跳过这个缝隙。
      if (take < remaining && take < MIN_SPLIT_PART_MIN) continue;
      parts.push({
        startMin: interval.start,
        endMin: interval.start + take,
        segmentIndex: interval.segmentIndex,
      });
      interval.start += take;
      remaining -= take;
    }
    if (remaining > 0) return null;
    free = working.filter((interval) => interval.end > interval.start);
    return parts;
  }

  for (const task of rest) {
    const duration = estimateOf(task, windows.settings);
    const parts = allocate(duration);
    if (!parts) {
      unplaced.push(task);
      continue;
    }
    placed.push(
      makeEntry(task, parts, false, {
        outside: false,
        lunch: false,
        overrun: false,
        overlap: false,
        overdue: false,
        due: 0,
      }),
    );
  }

  /* 3. 警示：过期 / 将晚于截止（按最后一段结束时刻算）。 */
  for (const entry of placed) {
    const due = parseLocalDateTime(entry.task.dueAt);
    if (due) {
      if (due.getTime() < nowMs) entry.flags.overdue = true;
      if (localDateKey(due) === dateKey) {
        const dueMin = due.getHours() * 60 + due.getMinutes();
        if (entry.endMin > dueMin) entry.flags.due = entry.endMin - dueMin;
      }
    }
    entry.conflict = entry.pinned
      ? !!(
          entry.flags.outside ||
          entry.flags.lunch ||
          entry.flags.overrun ||
          entry.flags.overlap ||
          entry.flags.overdue ||
          entry.flags.due > 0
        )
      : !!(entry.flags.overdue || entry.flags.due > 0);
  }

  /* 4. 实时高亮：当前这一分钟落在哪一段，就标在哪一段。 */
  for (const entry of placed) {
    entry.currentPart = entry.flags.outside
      ? null
      : entry.parts.find((part) => nowMin >= part.startMin && nowMin < part.endMin) || null;
    entry.current = !!entry.currentPart;
    if (entry.currentPart) entry.currentPart.current = true;
    // 计划结束时间已经过去、但还没打勾：说明这件事比计划拖后了。
    entry.overrunMin = !entry.flags.outside && nowMin > entry.endMin ? nowMin - entry.endMin : 0;
    entry.overPlan = entry.overrunMin > 0;
  }

  placed.sort(
    (a, b) =>
      a.startMin - b.startMin ||
      (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) ||
      (Number(a.task.order) || 0) - (Number(b.task.order) || 0),
  );

  const blocks = [];
  for (const entry of placed) {
    for (const part of entry.parts) blocks.push({ entry, part });
  }
  blocks.sort(
    (a, b) =>
      a.part.startMin - b.part.startMin ||
      a.part.partIndex - b.part.partIndex ||
      (Number(a.entry.task.order) || 0) - (Number(b.entry.task.order) || 0),
  );

  const scheduledMin = placed.reduce((sum, entry) => sum + entry.durationMin, 0);
  const unplacedMin = unplaced.reduce((sum, task) => sum + estimateOf(task, windows.settings), 0);
  const doneMin = done.reduce((sum, task) => sum + estimateOf(task, windows.settings), 0);
  const lateCount = placed.filter((entry) => entry.flags.due > 0).length;
  const overdueCount = placed.filter((entry) => entry.flags.overdue).length;
  const conflictCount = placed.filter((entry) => entry.pinned && entry.conflict).length;
  const overrunCount = placed.filter((entry) => entry.overPlan).length;
  const current = placed.find((entry) => entry.current) || null;

  return {
    date: dateKey,
    now: now.toISOString(),
    nowMin,
    anchorMin,
    settings: windows.settings,
    segments,
    lunch,
    availableMin,
    remainingAvailableMin,
    placed,
    blocks,
    unplaced,
    current,
    currentPart: current ? current.currentPart : null,
    pinnedConflicts: placed.filter((entry) => entry.pinned && entry.conflict).map((entry) => entry.task.id),
    stats: {
      taskCount: all.length,
      pendingCount: pending.length,
      doneCount: done.length,
      doneMin,
      scheduledCount: placed.length,
      scheduledMin,
      unplacedCount: unplaced.length,
      unplacedMin,
      needMin,
      availableMin: remainingAvailableMin,
      remainingAvailableMin,
      surplusMin: remainingAvailableMin - needMin,
      overloadMin: Math.max(0, needMin - remainingAvailableMin),
      lateCount,
      overdueCount,
      conflictCount,
      overrunCount,
    },
    // 兼容旧测试/旧调用方的别名
    segs: segments.map((seg) => [seg.start, seg.end]),
    availMin: availableMin,
    needMin,
    placedMin: scheduledMin,
    freeMin: Math.max(0, availableMin - scheduledMin),
    overloadMin: Math.max(0, needMin - availableMin),
  };
}

/** 「下一件」：当前时刻起最近的一件已排任务；都已过则取第一件。 */
function nextUp(plan, nowMinutes) {
  if (!plan || !plan.placed || plan.placed.length === 0) return null;
  const now = Number(nowMinutes);
  const candidates = plan.placed.filter((item) => !Number.isFinite(now) || item.endMin > now);
  return candidates[0] || plan.placed[0] || null;
}

/** 排序后的待办集合：把钉住任务与被排上的任务都算进去，供列表使用。 */
function orderedPending(plan) {
  if (!plan) return [];
  const pinned = plan.placed.filter((item) => item.pinned).sort((a, b) => a.startMin - b.startMin);
  const auto = plan.placed.filter((item) => !item.pinned);
  const seen = new Set(plan.placed.map((item) => item.task.id));
  const unplaced = plan.unplaced.filter((task) => !seen.has(task.id));
  return [...pinned, ...auto, ...unplaced.map((task) => ({ task, unplaced: true }))];
}


/* ---- 00-core.js ---- */
/* ==========================================================================
 * dsh-taskboard · 浏览器半侧：核心
 *
 * 这个文件不单独执行：scripts/build.mjs 会把 scheduler.js + client/*.js
 * 拼进同一个 `window.__ModuleLoader__.load({ factory(require) { ... } })`
 * 作用域，因此下面所有顶层声明在 client/page.js、client/dock.js 里可见。
 *
 * react 由 DSH 平台种子模块提供（不能打包进来）。
 * ========================================================================== */

const React = require('react');
const h = React.createElement;
const { useState, useEffect, useMemo, useRef, useCallback } = React;
const useStoreHook = React.useSyncExternalStore;

const API_BASE = '/dsh-taskboard';
const DOCK_STORAGE_KEY = 'dsh-taskboard:dock:v2';
const ANCHOR_STORAGE_KEY = 'dsh-taskboard:anchor:v1';
const TOAST_MS = 2800;

/** apply() 时记下的 cordis 上下文；悬浮小窗用它打开完整面板。 */
let appContext = null;

/* ------------------------------------------------------------------ 小工具 */

function cx() {
  return Array.prototype.slice.call(arguments).filter(Boolean).join(' ');
}

function useStoreSnapshot(subscribe, getSnapshot) {
  if (typeof useStoreHook === 'function') return useStoreHook(subscribe, getSnapshot);
  // React 17 兜底（DSH 当前是 18，正常不会走到这里）。
  const [snap, setSnap] = useState(getSnapshot);
  useEffect(() => {
    const update = () => setSnap(getSnapshot());
    update();
    return subscribe(update);
  }, [subscribe, getSnapshot]);
  return snap;
}

function todayKeyOf(date) {
  return localDateKey(date instanceof Date ? date : new Date());
}

function minuteOfDay(date) {
  const d = date instanceof Date ? date : new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function combineDateTime(date, time) {
  if (!date || !time) return null;
  return date + 'T' + time;
}

function splitDateTime(value) {
  const d = parseLocalDateTime(value);
  if (!d) return { date: '', time: '' };
  return { date: localDateKey(d), time: fromMinutes(d.getHours() * 60 + d.getMinutes()) };
}

function dueText(task, today) {
  const due = parseLocalDateTime(task && task.dueAt);
  if (!due) return '';
  const time = fromMinutes(due.getHours() * 60 + due.getMinutes());
  const date = localDateKey(due);
  if (date === today) return time;
  if (date === addDays(today, -1)) return '昨天 ' + time;
  if (date === addDays(today, 1)) return '明天 ' + time;
  return date.slice(5).replace('-', '/') + ' ' + time;
}

function relativeMinutes(endMin, nowMin) {
  const diff = endMin - nowMin;
  if (diff >= 60) return formatDuration(diff);
  return Math.max(0, diff) + ' 分钟';
}

function priorityClass(priority) {
  return 'is-p' + Math.max(0, Math.min(3, Number(priority) || 0));
}

/** 排程条目的时间文案；自动分段的显示首段开始到末段结束。 */
function entryTimeLabel(entry) {
  if (!entry || !entry.parts || entry.parts.length === 0) return '';
  const first = entry.parts[0];
  const last = entry.parts[entry.parts.length - 1];
  if (entry.parts.length === 1) return formatClock(first.startMin) + '–' + formatClock(first.endMin);
  return formatClock(first.startMin) + '–' + formatClock(last.endMin) + ' · ' + entry.parts.length + ' 段';
}

/** 按计划分段估算到 `nowMin` 为止已经投入的工作分钟数（用于完成时预填实际）。 */
function workedMinutes(entry, nowMin) {
  if (!entry || !entry.parts) return 0;
  let total = 0;
  for (const part of entry.parts) {
    if (nowMin <= part.startMin) break;
    total += Math.min(nowMin, part.endMin) - part.startMin;
  }
  return Math.max(0, Math.round(total));
}

function readDockPrefs() {
  const fallback = { enabled: true, open: true, side: 'right', top: 92, width: 348, height: 0, migrated: true };
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    // 旧版「×」会直接把 enabled 置 false，导致小窗彻底消失、无处找回。
    // 迁移一次：恢复成「只收起成细条」，让右侧细条重新出现。
    if (parsed.enabled === false && parsed.migrated !== true) {
      parsed.enabled = true;
      parsed.open = false;
      parsed.migrated = true;
      try {
        localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(parsed));
      } catch {
        /* ignore */
      }
    }
    return {
      enabled: parsed.enabled !== false,
      open: parsed.open !== false,
      side: parsed.side === 'left' ? 'left' : 'right',
      top: Number.isFinite(parsed.top) ? Math.max(0, Math.min(4000, parsed.top)) : fallback.top,
      width: Number.isFinite(parsed.width) ? Math.max(300, Math.min(560, parsed.width)) : fallback.width,
      height: Number.isFinite(parsed.height) ? parsed.height : 0,
      migrated: parsed.migrated === true,
    };
  } catch {
    return fallback;
  }
}

function writeDockPrefs(prefs) {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式/禁用 localStorage：只影响记忆，不影响功能 */
  }
}

/** 页面页头与设置页共用的「显示/隐藏悬浮小窗」动作。 */
function setDockVisibility(enabled) {
  const prefs = readDockPrefs();
  prefs.enabled = !!enabled;
  if (prefs.enabled) prefs.open = true;
  prefs.migrated = true;
  writeDockPrefs(prefs);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('dsh-taskboard:dock', { detail: prefs }));
  }
  return prefs;
}

/* ------------------------------------------------ 从现在重排（当日锚点） */

function readAnchorMinute(today) {
  try {
    const raw = localStorage.getItem(ANCHOR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.date === today && Number.isFinite(parsed.minute)) {
      return Math.max(0, Math.min(1440, Math.round(parsed.minute)));
    }
  } catch {
    /* ignore */
  }
  return null;
}

function anchorEvent(today, minute) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('dsh-taskboard:anchor', { detail: { date: today, minute } }));
  }
}

function writeAnchorMinute(today, minute) {
  const value = Math.max(0, Math.min(1440, Math.round(minute)));
  try {
    localStorage.setItem(ANCHOR_STORAGE_KEY, JSON.stringify({ date: today, minute: value }));
  } catch {
    /* ignore */
  }
  anchorEvent(today, value);
  return value;
}

function clearAnchorMinute(today) {
  try {
    localStorage.removeItem(ANCHOR_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  anchorEvent(today, null);
}

/** 当日「从现在重排」锚点；跨天后自动失效。 */
function useAnchorMinute(today) {
  const [minute, setMinute] = useState(() => readAnchorMinute(today));
  useEffect(() => {
    setMinute(readAnchorMinute(today));
    const onChange = () => setMinute(readAnchorMinute(today));
    window.addEventListener('dsh-taskboard:anchor', onChange);
    return () => window.removeEventListener('dsh-taskboard:anchor', onChange);
  }, [today]);
  return minute;
}

let toastTimer = null;

/**
 * 用普通 DOM 画 toast：不依赖 React root，插件热重载后也不会出现重复的 toast 容器。
 */
function showToast(message, tone) {
  if (typeof document === 'undefined') return;
  let host = document.getElementById('dsh-taskboard-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'dsh-taskboard-toast-host';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  const element = document.createElement('div');
  element.className = 'tb-toast' + (tone === 'error' ? ' is-error' : '');
  element.textContent = String(message || '');
  host.appendChild(element);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (element.parentNode) element.remove();
  }, TOAST_MS);
}

/* 30 秒一跳的“现在”，用来刷新过期/倒计时/跨天判定。 */
function useNowTick(intervalMs) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs || 30000);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* -------------------------------------------------------------- 数据仓库 */

const boardStore = {
  snapshot: {
    status: 'loading',
    state: null,
    today: todayKeyOf(),
    dataFile: '',
    error: null,
    pending: 0,
    lastSync: 0,
  },
  listeners: new Set(),
  started: false,
  inFlight: null,
  getSnapshot() {
    return boardStore.snapshot;
  },
  subscribe(listener) {
    boardStore.listeners.add(listener);
    boardStore.start();
    return () => boardStore.listeners.delete(listener);
  },
  emit(patch) {
    boardStore.snapshot = Object.assign({}, boardStore.snapshot, patch);
    boardStore.listeners.forEach((listener) => listener());
  },
  start() {
    if (boardStore.started) return;
    boardStore.started = true;
    boardStore.refresh();
    setInterval(() => {
      if (document.visibilityState !== 'hidden') boardStore.refresh({ quiet: true });
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') boardStore.refresh({ quiet: true });
    });
  },
  async refresh(options) {
    const quiet = !!(options && options.quiet);
    if (boardStore.inFlight) return boardStore.inFlight;
    const request = (async () => {
      try {
        const res = await fetch(API_BASE + '/state', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || body.ok === false) {
          throw new Error((body && body.error && body.error.message) || 'HTTP ' + res.status);
        }
        boardStore.emit({
          status: 'ready',
          state: body.state,
          today: body.today || todayKeyOf(),
          dataFile: body.dataFile || '',
          error: null,
          pending: 0,
          lastSync: Date.now(),
        });
        return body;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        boardStore.emit(
          quiet && boardStore.snapshot.state
            ? { error: message }
            : { status: boardStore.snapshot.state ? 'ready' : 'error', error: message, pending: 0 },
        );
        return null;
      } finally {
        boardStore.inFlight = null;
      }
    })();
    boardStore.inFlight = request;
    return request;
  },
  async dispatch(action, payload) {
    boardStore.emit({ pending: boardStore.snapshot.pending + 1 });
    try {
      const res = await fetch(API_BASE + '/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-taskboard': '1' },
        body: JSON.stringify({ action, payload: payload || {} }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.ok === false) {
        throw new Error((body && body.error && body.error.message) || 'HTTP ' + res.status);
      }
      boardStore.emit({
        status: 'ready',
        state: body.state,
        today: body.today || todayKeyOf(),
        dataFile: body.dataFile || boardStore.snapshot.dataFile,
        error: null,
        pending: Math.max(0, boardStore.snapshot.pending - 1),
        lastSync: Date.now(),
      });
      return body;
    } catch (error) {
      boardStore.emit({
        pending: Math.max(0, boardStore.snapshot.pending - 1),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
};

function useBoard() {
  return useStoreSnapshot(boardStore.subscribe, boardStore.getSnapshot);
}

/** 统一处理动作失败：toast + 不打断界面。 */
async function runAction(action, payload) {
  try {
    return await boardStore.dispatch(action, payload);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
    return null;
  }
}

/* ------------------------------------------------------------------ 图标 */

function Svg(props) {
  return h(
    'svg',
    {
      width: props.size || 16,
      height: props.size || 16,
      viewBox: props.viewBox || '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props.strokeWidth || 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      className: props.className,
    },
    props.children,
  );
}

function IconTaskboard(props) {
  const size = (props && props.size) || 16;
  return h(
    Svg,
    { size, strokeWidth: 1.8 },
    h('rect', { x: 3.5, y: 4, width: 17, height: 16.5, rx: 3.2 }),
    h('path', { d: 'M8 9.2h5.6' }),
    h('path', { d: 'M8 13h3.6' }),
    h('path', { d: 'M8 16.8h2.6' }),
    h('path', { d: 'M16.4 9.4l.9 1.4 2-2.6' }),
    h('path', { d: 'M16.4 15.2l.9 1.4 2-2.6' }),
  );
}

function IconHistory(props) {
  return h(
    Svg,
    { size: (props && props.size) || 16 },
    h('path', { d: 'M3.6 12a8.4 8.4 0 1 0 2.5-6' }),
    h('path', { d: 'M3.2 4.2v4.4h4.4' }),
    h('path', { d: 'M12 7.8V12l3 1.8' }),
  );
}

function IconSettings(props) {
  return h(
    Svg,
    { size: (props && props.size) || 16 },
    h('path', { d: 'M4 7h5.2M13.2 7H20M4 12h8.2M16.2 12H20M4 17h2.6M10.6 17H20' }),
    h('circle', { cx: 11.2, cy: 7, r: 1.8 }),
    h('circle', { cx: 14.2, cy: 12, r: 1.8 }),
    h('circle', { cx: 8.6, cy: 17, r: 1.8 }),
  );
}

function IconPanel(props) {
  return h(
    Svg,
    { size: (props && props.size) || 16 },
    h('rect', { x: 3.2, y: 4.4, width: 17.6, height: 15.2, rx: 2.6 }),
    h('path', { d: 'M14.6 4.6v14.8' }),
    h('path', { d: 'M6.4 9h4.6M6.4 12.4h4.6M6.4 15.8h3' }),
  );
}

function IconPlus(props) {
  return h(Svg, { size: (props && props.size) || 16 }, h('path', { d: 'M12 5v14M5 12h14' }));
}

function IconClose(props) {
  return h(Svg, { size: (props && props.size) || 16 }, h('path', { d: 'M6 6l12 12M18 6L6 18' }));
}

function IconPin(props) {
  return h(
    Svg,
    { size: (props && props.size) || 14 },
    h('path', { d: 'M9 4h6l-.7 5.2 3 3.1H6.7l3-3.1L9 4z' }),
    h('path', { d: 'M12 12.3V20' }),
  );
}

function IconTrash(props) {
  return h(
    Svg,
    { size: (props && props.size) || 16 },
    h('path', { d: 'M4.5 7h15' }),
    h('path', { d: 'M9.5 7V5.2c0-.6.5-1.2 1.2-1.2h2.6c.7 0 1.2.6 1.2 1.2V7' }),
    h('path', { d: 'M6.5 7l.8 12.1c0 .6.6 1.1 1.2 1.1h7c.6 0 1.2-.5 1.2-1.1L17.5 7' }),
    h('path', { d: 'M10 11v5M14 11v5' }),
  );
}

function IconChevron(props) {
  const up = props && props.direction === 'up';
  return h(Svg, { size: (props && props.size) || 14 }, h('path', { d: up ? 'M6 14l6-6 6 6' : 'M6 9l6 6 6-6' }));
}

function IconBack(props) {
  return h(
    Svg,
    { size: (props && props.size) || 16 },
    h('path', { d: 'M14.5 5.5L8 12l6.5 6.5' }),
    h('path', { d: 'M8 12h11' }),
  );
}

function IconRefresh(props) {
  return h(
    Svg,
    { size: (props && props.size) || 16 },
    h('path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }),
    h('path', { d: 'M19.8 4.5v4.7h-4.7' }),
    h('path', { d: 'M12 8v4.3l2.8 1.7' }),
  );
}

function IconCalendar(props) {
  return h(
    Svg,
    { size: (props && props.size) || 16 },
    h('rect', { x: 3.4, y: 5, width: 17.2, height: 15.4, rx: 2.4 }),
    h('path', { d: 'M7.5 3.5v3M16.5 3.5v3M3.6 9.5h16.8' }),
    h('path', { d: 'M7.5 13h.01M12 13h.01M16.5 13h.01M7.5 16.8h.01M12 16.8h.01' }),
  );
}

function IconBell(props) {
  return h(
    Svg,
    { size: (props && props.size) || 16 },
    h('path', { d: 'M18 8.5a6 6 0 0 0-12 0c0 6-2.2 7.2-2.2 7.2h16.4S18 14.5 18 8.5z' }),
    h('path', { d: 'M13.7 19a2 2 0 0 1-3.4 0' }),
  );
}

function IconLayers(props) {
  return h(
    Svg,
    { size: (props && props.size) || 16 },
    h('path', { d: 'M12 3.8l8.3 4.3L12 12.4 3.7 8.1 12 3.8z' }),
    h('path', { d: 'M4.5 12.2l7.5 3.9 7.5-3.9' }),
    h('path', { d: 'M4.5 16.2l7.5 3.9 7.5-3.9' }),
  );
}

function IconTomorrow(props) {
  return h(
    Svg,
    { size: (props && props.size) || 15 },
    h('path', { d: 'M4 12h11.5' }),
    h('path', { d: 'M11.5 6.5L18 12l-6.5 5.5' }),
    h('path', { d: 'M20 4.5v15' }),
  );
}

function IconCheck(props) {
  return h(Svg, { size: (props && props.size) || 13, strokeWidth: 2.4 }, h('path', { d: 'M5 12.5l4.4 4.4L19 6.8' }));
}

/* ------------------------------------------------------------------- 样式 */

const BOARD_CSS = `
.tb-root{
  --tb-bg:var(--dsw-alias-bg-base,#17181c);
  --tb-panel:var(--dsw-alias-bg-layer-1,#1e2025);
  --tb-card:var(--dsw-alias-bg-layer-2,#26282f);
  --tb-card2:var(--dsw-alias-bg-layer-3,#2e313a);
  --tb-line:var(--dsw-alias-border-l2,rgba(255,255,255,.10));
  --tb-line-soft:var(--dsw-alias-border-l1,rgba(255,255,255,.06));
  --tb-text:var(--dsw-alias-label-primary,#ececf1);
  --tb-text2:var(--dsw-alias-label-secondary,#a7abb7);
  --tb-text3:var(--dsw-alias-label-tertiary,#787d8b);
  --tb-accent:#4f74f0;
  --tb-accent-strong:#3f5bd6;
  --tb-red:var(--dsw-alias-state-error-primary,#ef5350);
  --tb-warn:var(--dsw-alias-state-warn-primary,#e2a33c);
  --tb-ok:var(--dsw-alias-state-success-primary,#46b47d);
  --tb-radius:var(--dsw-radius-lg,12px);
  --tb-radius-sm:var(--dsw-radius-md,8px);
  --tb-shadow:var(--dsw-shadow-lv3,0 16px 48px rgba(0,0,0,.38));
  --tb-font:var(--dsw-font-family,"PingFang SC","Microsoft YaHei",system-ui,-apple-system,sans-serif);
  color:var(--tb-text);
  font-family:var(--tb-font);
  font-size:13px;
  line-height:1.45;
  -webkit-font-smoothing:antialiased;
}
.tb-root *{box-sizing:border-box}
.tb-root :where(button,input,textarea,select){font:inherit;color:inherit}
.tb-root :where(button){cursor:pointer;background:none;border:none;padding:0}
.tb-root input,.tb-root textarea{outline:none}
.tb-root ::selection{background:color-mix(in srgb,var(--tb-accent) 34%,transparent)}

/* ---------- 按钮 ---------- */
.tb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 11px;border-radius:8px;border:1px solid var(--tb-line);background:var(--tb-card);color:var(--tb-text);font-size:12.5px;white-space:nowrap;transition:background .14s,border-color .14s,color .14s,transform .08s}
.tb-btn:hover{background:var(--tb-card2);border-color:color-mix(in srgb,var(--tb-line) 60%,var(--tb-text3))}
.tb-btn.is-on{background:color-mix(in srgb,var(--tb-accent) 14%,transparent);border-color:color-mix(in srgb,var(--tb-accent) 35%,var(--tb-line));color:var(--tb-accent)}
.tb-btn:active{transform:translateY(.5px)}
.tb-btn:disabled{opacity:.5;cursor:default;transform:none}
.tb-btn.is-primary{background:var(--tb-accent);border-color:transparent;color:#fff}
.tb-btn.is-primary:hover{background:color-mix(in srgb,var(--tb-accent) 86%,#fff)}
.tb-btn.is-ghost{background:transparent;border-color:transparent;color:var(--tb-text2)}
.tb-btn.is-ghost:hover{background:var(--tb-card);color:var(--tb-text)}
.tb-btn.is-danger{color:var(--tb-red);border-color:color-mix(in srgb,var(--tb-red) 28%,var(--tb-line));background:transparent}
.tb-btn.is-danger:hover{background:color-mix(in srgb,var(--tb-red) 12%,transparent)}
.tb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;color:var(--tb-text2);transition:background .14s,color .14s}
.tb-iconbtn:hover{background:var(--tb-card2);color:var(--tb-text)}
.tb-iconbtn.is-on{background:color-mix(in srgb,var(--tb-accent) 16%,transparent);color:var(--tb-accent)}
.tb-iconbtn:disabled{opacity:.4;cursor:default}

/* ---------- 面板页 ---------- */
.tb-page{height:100%;min-height:0;display:flex;flex-direction:column;background:
  radial-gradient(1200px 480px at 82% -10%,color-mix(in srgb,var(--tb-accent) 10%,transparent),transparent 62%),
  var(--tb-bg);
  overflow:hidden;position:relative}
.tb-page-head{display:flex;align-items:center;gap:14px;padding:18px 22px 14px;flex:none;border-bottom:1px solid var(--tb-line-soft)}
.tb-brand{display:flex;align-items:center;gap:10px;min-width:0}
.tb-brand-mark{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(140deg,color-mix(in srgb,var(--tb-accent) 92%,#fff),color-mix(in srgb,var(--tb-accent) 58%,#10131c));box-shadow:0 6px 18px color-mix(in srgb,var(--tb-accent) 30%,transparent);flex:none}
.tb-brand-title{font-size:15.5px;font-weight:650;letter-spacing:.2px;white-space:nowrap}
.tb-brand-sub{font-size:11.5px;color:var(--tb-text3);white-space:nowrap;margin-top:1px}
.tb-head-mid{display:flex;align-items:center;gap:8px;margin-left:6px;flex-wrap:wrap;min-width:0}
.tb-head-right{margin-left:auto;display:flex;align-items:center;gap:4px;flex:none}
.tb-back{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 9px 0 6px;border-radius:8px;border:1px solid transparent;color:var(--tb-text2);font-size:12px;white-space:nowrap;flex:none;transition:background .14s,color .14s,border-color .14s}
.tb-back:hover{background:var(--tb-card);border-color:var(--tb-line-soft);color:var(--tb-text)}
.tb-back:active{transform:translateY(.5px)}
.tb-back-label{font-size:11.5px}
.tb-pill{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 9px;border-radius:99px;background:var(--tb-card);border:1px solid var(--tb-line-soft);color:var(--tb-text2);font-size:11.5px;white-space:nowrap}
.tb-pill.is-danger{color:var(--tb-red);background:color-mix(in srgb,var(--tb-red) 10%,transparent);border-color:color-mix(in srgb,var(--tb-red) 24%,transparent)}
.tb-pill.is-warn{color:var(--tb-warn);background:color-mix(in srgb,var(--tb-warn) 10%,transparent);border-color:color-mix(in srgb,var(--tb-warn) 22%,transparent)}
.tb-pill.is-ok{color:var(--tb-ok);background:color-mix(in srgb,var(--tb-ok) 9%,transparent);border-color:color-mix(in srgb,var(--tb-ok) 20%,transparent)}
.tb-pill .tb-dot{width:6px;height:6px;border-radius:99px;background:currentColor;flex:none}

.tb-page-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(300px,356px) minmax(0,1fr);gap:16px;padding:16px 22px 14px;overflow:hidden}
.tb-side{min-height:0;display:flex;flex-direction:column;gap:12px;overflow:auto;padding-right:2px}
.tb-side::-webkit-scrollbar,.tb-timeline-scroll::-webkit-scrollbar,.tb-dialog-body::-webkit-scrollbar{width:8px}
.tb-side::-webkit-scrollbar-thumb,.tb-timeline-scroll::-webkit-scrollbar-thumb,.tb-dialog-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(255,255,255,.12));border-radius:9px}
.tb-main{min-width:0;min-height:0;display:flex;flex-direction:column}

/* ---------- 快速添加 ---------- */
.tb-quick{background:var(--tb-panel);border:1px solid var(--tb-line);border-radius:var(--tb-radius);padding:12px;box-shadow:0 1px 0 rgba(255,255,255,.03) inset;flex:none}
.tb-quick-row{display:flex;align-items:center;gap:8px}
.tb-quick-input{flex:1;min-width:0;height:38px;border-radius:9px;border:1px solid var(--tb-line);background:var(--tb-bg);padding:0 12px;font-size:13.5px;color:var(--tb-text);transition:border-color .15s,box-shadow .15s}
.tb-quick-input::placeholder{color:var(--tb-text3)}
.tb-quick-input:focus{border-color:color-mix(in srgb,var(--tb-accent) 65%,var(--tb-line));box-shadow:0 0 0 3px color-mix(in srgb,var(--tb-accent) 14%,transparent)}
.tb-quick-add{width:38px;height:38px;border-radius:9px;background:var(--tb-accent);color:#fff;display:flex;align-items:center;justify-content:center;flex:none;transition:filter .14s}
.tb-quick-add:hover{filter:brightness(1.08)}
.tb-quick-add:disabled{opacity:.45;cursor:default}
.tb-quick-opts{display:flex;align-items:center;gap:8px;margin-top:9px;flex-wrap:wrap}
.tb-prio-chips{display:inline-flex;gap:3px;padding:2px;border-radius:8px;background:var(--tb-bg);border:1px solid var(--tb-line-soft)}
.tb-prio-chip{height:22px;min-width:27px;padding:0 6px;border-radius:6px;font-size:11px;font-weight:650;color:var(--tb-text3);letter-spacing:.2px}
.tb-prio-chip:hover{color:var(--tb-text);background:var(--tb-card)}
.tb-prio-chip.is-on[data-p="0"]{background:color-mix(in srgb,var(--tb-red) 88%,#000);color:#fff}
.tb-prio-chip.is-on[data-p="1"]{background:#c9772a;color:#fff}
.tb-prio-chip.is-on[data-p="2"]{background:var(--tb-accent);color:#fff}
.tb-prio-chip.is-on[data-p="3"]{background:#5c6270;color:#fff}
.tb-mini-field{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 7px;border-radius:7px;border:1px solid var(--tb-line-soft);background:var(--tb-bg);color:var(--tb-text2);font-size:11.5px}
.tb-mini-field input{width:34px;border:none;background:transparent;text-align:right;color:var(--tb-text);font-size:12px}
.tb-mini-field input[type=time]{width:58px;text-align:left}
.tb-mini-field input[type=date]{width:104px;text-align:left}
.tb-mini-field input::-webkit-calendar-picker-indicator{opacity:.5;cursor:pointer}
.tb-mini-field.is-focus{border-color:color-mix(in srgb,var(--tb-accent) 50%,var(--tb-line));color:var(--tb-text)}
.tb-quick-hint{font-size:10.5px;color:var(--tb-text3);margin-left:auto;white-space:nowrap}
.tb-quick-time{margin-top:9px;padding-top:9px;border-top:1px dashed var(--tb-line-soft)}

/* ---------- 时间轴 ---------- */
.tb-timeline{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--tb-panel);border:1px solid var(--tb-line);border-radius:var(--tb-radius);overflow:hidden}
.tb-timeline-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--tb-line-soft);flex:none;flex-wrap:wrap;row-gap:5px}
.tb-timeline-title{font-size:12.5px;font-weight:600;letter-spacing:.2px}
.tb-timeline-sub{font-size:11px;color:var(--tb-text3)}
.tb-now-pill{display:inline-flex;align-items:center;gap:5px;max-width:250px;height:20px;padding:0 8px;border-radius:99px;font-size:10px;color:var(--tb-accent);background:color-mix(in srgb,var(--tb-accent) 9%,transparent);border:1px solid color-mix(in srgb,var(--tb-accent) 20%,transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-now-pill.is-live{background:color-mix(in srgb,var(--tb-accent) 15%,transparent);border-color:color-mix(in srgb,var(--tb-accent) 34%,transparent);font-weight:600}
.tb-now-row{display:flex;align-items:center;gap:8px;padding:1px 6px;color:var(--tb-accent);font-size:9.5px;font-weight:650;letter-spacing:.2px}
.tb-now-line{flex:1;height:1px;background:linear-gradient(90deg,color-mix(in srgb,var(--tb-accent) 75%,transparent),transparent)}
.tb-timeline-legend{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:10.5px;color:var(--tb-text3)}
.tb-legend-item{display:inline-flex;align-items:center;gap:4px}
.tb-legend-dot{width:7px;height:7px;border-radius:2px;background:var(--tb-text3)}
.tb-legend-dot.is-pin{background:var(--tb-warn)}
.tb-timeline-scroll{flex:1;min-height:0;overflow:auto;padding:8px 12px 14px}
.tb-seg-head{display:flex;align-items:baseline;gap:8px;padding:9px 4px 4px;color:var(--tb-text3);font-size:10.5px;letter-spacing:.3px}
.tb-seg-head b{font-size:11px;font-weight:600;color:var(--tb-text2)}
.tb-seg-line{flex:1;height:1px;background:var(--tb-line-soft);align-self:center}
.tb-seg-time{font-variant-numeric:tabular-nums}
.tb-gap{display:flex;align-items:center;gap:8px;height:26px;padding:0 6px;color:var(--tb-text3);font-size:10.5px}
.tb-gap-line{flex:1;height:1px;background:repeating-linear-gradient(90deg,var(--tb-line) 0 4px,transparent 4px 8px);opacity:.55}
.tb-lunch{display:flex;align-items:center;gap:8px;height:30px;padding:0 6px;color:var(--tb-text3);font-size:10.5px}
.tb-lunch .tb-gap-line{background:var(--tb-line-soft)}
.tb-lunch-tag{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:6px;background:var(--tb-card);border:1px solid var(--tb-line-soft);color:var(--tb-text2);font-size:10.5px;flex:none}
.tb-task{position:relative;display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:10px;border:1px solid transparent;transition:background .13s,border-color .13s;cursor:pointer}
.tb-task:hover{background:var(--tb-card)}
.tb-task.is-active{background:var(--tb-card);border-color:color-mix(in srgb,var(--tb-accent) 42%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--tb-accent) 8%,transparent)}
.tb-task.is-done{opacity:.62}
.tb-task.is-pinned{background:
  linear-gradient(90deg,color-mix(in srgb,var(--tb-warn) 8%,transparent),transparent 52%),
  var(--tb-panel)}
.tb-task.is-conflict{box-shadow:inset 3px 0 0 var(--tb-red)}
.tb-task.is-now{background:linear-gradient(90deg,color-mix(in srgb,var(--tb-accent) 15%,transparent),transparent 62%),var(--tb-card);box-shadow:inset 3px 0 0 var(--tb-accent),0 0 0 1px color-mix(in srgb,var(--tb-accent) 30%,transparent)}
.tb-task.is-now:hover{background:linear-gradient(90deg,color-mix(in srgb,var(--tb-accent) 19%,transparent),transparent 62%),var(--tb-card)}
.tb-task.is-continuation{padding-left:24px}
.tb-task.is-continuation:before{content:"↳";position:absolute;left:11px;top:9px;color:var(--tb-text3);font-size:11px;line-height:1}
.tb-check{width:19px;height:19px;border-radius:6px;border:1.6px solid color-mix(in srgb,var(--tb-text3) 65%,transparent);background:transparent;display:flex;align-items:center;justify-content:center;color:#fff;flex:none;margin-top:2px;transition:background .14s,border-color .14s}
.tb-check:hover{border-color:var(--tb-accent)}
.tb-check.is-on{background:var(--tb-accent);border-color:var(--tb-accent)}
.tb-task-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.tb-task-line1{display:flex;align-items:center;gap:7px;min-width:0}
.tb-prio{flex:none;height:19px;min-width:24px;padding:0 5px;border-radius:5px;font-size:10px;font-weight:700;letter-spacing:.2px;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:#5c6270}
.tb-prio[data-p="0"]{background:linear-gradient(140deg,#f2555a,#c62d34)}
.tb-prio[data-p="1"]{background:linear-gradient(140deg,#e09a3a,#b86a1c)}
.tb-prio[data-p="2"]{background:linear-gradient(140deg,#6d8cff,#4664e0)}
.tb-prio[data-p="3"]{background:#5c6270}
.tb-task-title{font-size:13px;color:var(--tb-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.tb-task.is-done .tb-task-title{text-decoration:line-through;color:var(--tb-text2)}
.tb-task-dur{font-size:11px;color:var(--tb-text3);flex:none;font-variant-numeric:tabular-nums}
.tb-task-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:10.5px;color:var(--tb-text3);min-height:14px}
.tb-badge{display:inline-flex;align-items:center;gap:3px;height:17px;padding:0 6px;border-radius:5px;font-size:10px;line-height:1;white-space:nowrap}
.tb-badge.is-red{color:var(--tb-red);background:color-mix(in srgb,var(--tb-red) 13%,transparent)}
.tb-badge.is-warn{color:var(--tb-warn);background:color-mix(in srgb,var(--tb-warn) 13%,transparent)}
.tb-badge.is-blue{color:var(--tb-accent);background:color-mix(in srgb,var(--tb-accent) 13%,transparent)}
.tb-badge.is-muted{color:var(--tb-text2);background:var(--tb-card2)}
.tb-badge.is-live{color:var(--tb-accent);background:color-mix(in srgb,var(--tb-accent) 13%,transparent)}
.tb-live-dot{display:inline-block;width:6px;height:6px;border-radius:99px;background:currentColor;flex:none;animation:tb-pulse 1.6s ease-in-out infinite}
@keyframes tb-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.78)}}
.tb-task-time{margin-left:auto;flex:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--tb-text2);font-variant-numeric:tabular-nums;align-self:center;padding-left:8px;white-space:nowrap}
.tb-task-time.is-over{color:var(--tb-red)}
.tb-pin-mark{color:var(--tb-warn);display:inline-flex;flex:none}

/* ---------- 行内编辑 ---------- */
.tb-editor{margin:2px 0 8px 29px;padding:11px 12px;border-radius:10px;background:var(--tb-card);border:1px solid var(--tb-line);display:flex;flex-direction:column;gap:9px;cursor:default}
.tb-editor-input{width:100%;height:32px;border-radius:7px;border:1px solid var(--tb-line);background:var(--tb-bg);padding:0 10px;font-size:13px}
.tb-editor-input:focus{border-color:color-mix(in srgb,var(--tb-accent) 60%,var(--tb-line));box-shadow:0 0 0 3px color-mix(in srgb,var(--tb-accent) 12%,transparent)}
.tb-editor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px}
.tb-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.tb-field-label{font-size:10.5px;color:var(--tb-text3);letter-spacing:.2px}
.tb-field input,.tb-field select{height:30px;border-radius:7px;border:1px solid var(--tb-line);background:var(--tb-bg);padding:0 8px;font-size:12px;min-width:0;color:var(--tb-text)}
.tb-field input:focus,.tb-field select:focus{border-color:color-mix(in srgb,var(--tb-accent) 58%,var(--tb-line))}
.tb-field-pair{display:flex;gap:5px}
.tb-field-pair input[type=date]{flex:1.25;min-width:0}
.tb-field-pair input[type=time]{flex:1;min-width:0}
.tb-field-actions{display:flex;gap:2px;flex-wrap:wrap;margin-top:1px}
.tb-field-actions .tb-linkbtn{font-size:10px;padding:2px 4px;line-height:1.2}
.tb-editor-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tb-editor-hint{font-size:10.5px;color:var(--tb-text3)}
.tb-editor-foot .tb-spacer{flex:1}
.tb-linkbtn{color:var(--tb-text2);font-size:11px;padding:4px 6px;border-radius:6px}
.tb-linkbtn:hover{color:var(--tb-accent);background:color-mix(in srgb,var(--tb-accent) 10%,transparent)}

/* ---------- 区块 ---------- */
.tb-section{background:var(--tb-panel);border:1px solid var(--tb-line);border-radius:var(--tb-radius);overflow:hidden;flex:none}
.tb-section-head{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;font-size:12px;color:var(--tb-text2)}
.tb-section-head:hover{background:var(--tb-card)}
.tb-section-title{font-weight:600;color:var(--tb-text)}
.tb-section-count{color:var(--tb-text3);font-size:11px}
.tb-section-spacer{flex:1}
.tb-section-body{padding:0 8px 8px;display:flex;flex-direction:column;gap:2px}
.tb-section-empty{padding:4px 6px 10px;color:var(--tb-text3);font-size:11px}
.tb-mini-row{display:flex;align-items:center;gap:7px;padding:6px 6px;border-radius:7px;cursor:pointer}
.tb-mini-row:hover{background:var(--tb-card)}
.tb-mini-title{flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-mini-dur{font-size:10.5px;color:var(--tb-text3);flex:none}
.tb-mini-actions{display:flex;gap:1px;opacity:0;transition:opacity .12s}
.tb-mini-row:hover .tb-mini-actions{opacity:1}
.tb-mini-check{width:15px;height:15px;border-radius:5px;border:1.4px solid var(--tb-text3);flex:none;display:flex;align-items:center;justify-content:center}
.tb-mini-check:hover{border-color:var(--tb-accent)}
.tb-tinybtn{width:22px;height:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;color:var(--tb-text3)}
.tb-tinybtn:hover{background:var(--tb-card2);color:var(--tb-text)}
.tb-tinybtn.is-danger:hover{color:var(--tb-red);background:color-mix(in srgb,var(--tb-red) 12%,transparent)}

/* ---------- 页脚统计 ---------- */
.tb-foot{flex:none;display:flex;align-items:center;gap:14px;padding:10px 22px 14px;color:var(--tb-text3);font-size:11px;flex-wrap:wrap}
.tb-stat{display:inline-flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums}
.tb-stat b{color:var(--tb-text2);font-weight:600}
.tb-stat.is-over b{color:var(--tb-red)}
.tb-progress{flex:1;min-width:120px;height:4px;border-radius:99px;background:var(--tb-card);overflow:hidden;max-width:340px}
.tb-progress span{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--tb-accent),color-mix(in srgb,var(--tb-accent) 55%,#fff));transition:width .3s}
.tb-progress.is-over span{background:linear-gradient(90deg,var(--tb-red),#ff8a80)}
.tb-foot-hint{margin-left:auto;display:inline-flex;align-items:center;gap:5px;color:var(--tb-text3)}

/* ---------- 空态 / 加载 ---------- */
.tb-empty{flex:1;min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;color:var(--tb-text3);padding:22px;text-align:center}
.tb-empty-mark{width:46px;height:46px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:var(--tb-card);color:var(--tb-text2);border:1px solid var(--tb-line-soft)}
.tb-empty-title{font-size:13px;color:var(--tb-text2)}
.tb-empty-sub{font-size:11px;max-width:260px;line-height:1.6}
.tb-loading{display:flex;flex-direction:column;gap:8px;padding:20px}
.tb-skel{height:44px;border-radius:10px;background:linear-gradient(100deg,var(--tb-card) 20%,var(--tb-card2) 40%,var(--tb-card) 60%);background-size:220% 100%;animation:tb-shimmer 1.3s linear infinite}
@keyframes tb-shimmer{to{background-position:-120% 0}}
.tb-error{display:flex;align-items:flex-start;gap:9px;margin:14px 0;padding:12px 14px;border-radius:10px;border:1px solid color-mix(in srgb,var(--tb-red) 28%,var(--tb-line));background:color-mix(in srgb,var(--tb-red) 8%,transparent);color:var(--tb-text2);font-size:11.5px;line-height:1.6}
.tb-error code{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--tb-text3);word-break:break-all}
.tb-note{display:flex;align-items:flex-start;gap:9px;padding:11px 12px;border-radius:10px;border:1px solid var(--tb-line);background:var(--tb-panel);color:var(--tb-text2);font-size:11px;line-height:1.65}
.tb-note.is-warn{border-color:color-mix(in srgb,var(--tb-red) 26%,var(--tb-line));background:color-mix(in srgb,var(--tb-red) 7%,transparent)}

/* ---------- 弹层 ---------- */
.tb-modal-mask{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px;animation:tb-fade .14s ease}
@keyframes tb-fade{from{opacity:0}to{opacity:1}}
.tb-dialog{width:min(560px,100%);max-height:min(720px,calc(100vh - 48px));display:flex;flex-direction:column;background:var(--tb-panel);border:1px solid var(--tb-line);border-radius:16px;box-shadow:var(--tb-shadow);overflow:hidden;animation:tb-pop .16s cubic-bezier(.2,.9,.3,1.2)}
.tb-dialog.is-wide{width:min(760px,100%)}
@keyframes tb-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
.tb-dialog-head{display:flex;align-items:center;gap:10px;padding:15px 18px;border-bottom:1px solid var(--tb-line-soft);flex:none}
.tb-dialog-title{font-size:14px;font-weight:650}
.tb-dialog-sub{font-size:11px;color:var(--tb-text3)}
.tb-dialog-close{margin-left:auto}
.tb-dialog-body{padding:16px 18px;overflow:auto;overflow-anchor:none;display:flex;flex-direction:column;gap:16px}
.tb-dialog-foot{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--tb-line-soft);flex:none}
.tb-dialog-foot .tb-spacer{flex:1}
.tb-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.tb-form-grid .tb-field{gap:5px}
.tb-form-grid .tb-field input{height:32px}
.tb-form-block{border:1px solid var(--tb-line-soft);border-radius:11px;padding:13px;display:flex;flex-direction:column;gap:11px;background:color-mix(in srgb,var(--tb-card) 42%,transparent)}
.tb-form-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--tb-text)}
.tb-form-title .tb-form-note{font-weight:400;font-size:10.5px;color:var(--tb-text3);margin-left:auto}
.tb-form-hint{font-size:10.5px;color:var(--tb-text3);line-height:1.6}
.tb-calendar-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.tb-cal-day{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:10px 11px;border-radius:10px;border:1px solid var(--tb-line);background:var(--tb-card);text-align:left;transition:background .14s,border-color .14s}
.tb-cal-day:hover{background:var(--tb-card2);border-color:color-mix(in srgb,var(--tb-line) 55%,var(--tb-text3))}
.tb-cal-day.is-on{border-color:color-mix(in srgb,var(--tb-accent) 55%,transparent);background:color-mix(in srgb,var(--tb-accent) 12%,transparent)}
.tb-cal-day-top{font-size:11px;color:var(--tb-text2)}
.tb-cal-day-num{font-size:15px;font-weight:650;color:var(--tb-text);font-variant-numeric:tabular-nums}
.tb-cal-day-meta{font-size:10px;color:var(--tb-text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
@media (max-width:620px){.tb-calendar-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.tb-switch{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;color:var(--tb-text2);cursor:pointer;user-select:none}
.tb-switch input{display:none}
.tb-switch-track{width:32px;height:18px;border-radius:99px;background:var(--tb-card2);border:1px solid var(--tb-line);position:relative;transition:background .15s}
.tb-switch-track:after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:99px;background:var(--tb-text2);transition:transform .15s,background .15s}
.tb-switch input:checked + .tb-switch-track{background:color-mix(in srgb,var(--tb-accent) 72%,#000)}
.tb-switch input:checked + .tb-switch-track:after{transform:translateX(14px);background:#fff}
.tb-seg-ctl{display:inline-flex;padding:2px;border-radius:8px;background:var(--tb-bg);border:1px solid var(--tb-line-soft)}
.tb-seg-ctl button{height:24px;padding:0 9px;border-radius:6px;font-size:11px;color:var(--tb-text3)}
.tb-seg-ctl button.is-on{background:var(--tb-card2);color:var(--tb-text)}

/* ---------- 历史 ---------- */
.tb-history{display:grid;grid-template-columns:168px minmax(0,1fr);gap:14px;min-height:300px}
.tb-history-list{display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto;padding-right:4px}
.tb-history-date{display:flex;align-items:center;gap:7px;padding:8px 9px;border-radius:8px;font-size:11.5px;color:var(--tb-text2);cursor:pointer;text-align:left;width:100%}
.tb-history-date:hover{background:var(--tb-card)}
.tb-history-date.is-on{background:var(--tb-card2);color:var(--tb-text)}
.tb-history-date small{margin-left:auto;color:var(--tb-text3);font-size:10px}
.tb-history-panel{min-width:0;border-left:1px solid var(--tb-line-soft);padding-left:14px;display:flex;flex-direction:column;gap:8px;max-height:420px;overflow:auto}
.tb-history-day-title{font-size:12px;font-weight:600}
.tb-history-day-sub{font-size:10.5px;color:var(--tb-text3);margin-bottom:2px}
.tb-history-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px dashed var(--tb-line-soft);font-size:11.5px;color:var(--tb-text2)}
.tb-history-row:last-child{border-bottom:none}
.tb-history-row .is-done{text-decoration:line-through;color:var(--tb-text3)}
.tb-history-check{width:14px;height:14px;border-radius:4px;border:1.3px solid var(--tb-text3);flex:none}
.tb-history-check.is-on{background:var(--tb-accent);border-color:var(--tb-accent);color:#fff;display:flex;align-items:center;justify-content:center}

/* ---------- 完成提示 ---------- */
.tb-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1200;display:flex;align-items:center;gap:8px;padding:9px 14px;border-radius:10px;background:var(--dsw-alias-toast-bg,#2b2e36);color:var(--dsw-alias-toast-label,#f2f3f5);box-shadow:0 12px 32px rgba(0,0,0,.32);font-size:12px;animation:tb-toast-in .18s ease}
.tb-toast.is-error{background:color-mix(in srgb,var(--tb-red) 88%,#000);color:#fff}
@keyframes tb-toast-in{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}

/* ---------- 悬浮小窗 ---------- */
.tb-dock{position:absolute;inset:0;z-index:22;pointer-events:none}
.tb-dock-card{pointer-events:auto;position:absolute;display:flex;flex-direction:column;background:color-mix(in srgb,var(--tb-panel) 96%,transparent);border:1px solid var(--tb-line);border-radius:15px;box-shadow:var(--tb-shadow);overflow:hidden;backdrop-filter:blur(14px)}
.tb-dock-card[data-dragging="true"]{transition:none!important;box-shadow:0 22px 60px rgba(0,0,0,.48)}
.tb-dock-head{display:flex;align-items:center;gap:7px;padding:10px 10px 8px;cursor:grab;user-select:none;flex:none;background:linear-gradient(180deg,color-mix(in srgb,var(--tb-card) 60%,transparent),transparent)}
.tb-dock-head[data-dragging="true"]{cursor:grabbing}
.tb-dock-grip{color:var(--tb-text3);display:flex;flex:none}
.tb-dock-title{font-size:12px;font-weight:650;white-space:nowrap}
.tb-dock-sub{font-size:10px;color:var(--tb-text3);white-space:nowrap}
.tb-dock-head-actions{margin-left:auto;display:flex;gap:1px;flex:none;padding-right:14px}
.tb-dock-body{flex:1;min-height:0;display:flex;flex-direction:column;padding:0 10px 8px;gap:8px;overflow:hidden}
.tb-dock-quick{display:flex;gap:6px;flex:none}
.tb-dock-quick input{flex:1;min-width:0;height:32px;border-radius:8px;border:1px solid var(--tb-line);background:var(--tb-bg);padding:0 10px;font-size:12px}
.tb-dock-quick input:focus{border-color:color-mix(in srgb,var(--tb-accent) 60%,var(--tb-line))}
.tb-dock-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px;margin:0 -4px;padding:0 4px}
.tb-dock-list::-webkit-scrollbar{width:6px}
.tb-dock-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(255,255,255,.12));border-radius:9px}
.tb-mini-item{display:flex;align-items:flex-start;gap:7px;padding:6px;border-radius:7px;cursor:pointer}
.tb-mini-item:hover{background:var(--tb-card)}
.tb-mini-item.is-next{background:color-mix(in srgb,var(--tb-accent) 9%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tb-accent) 22%,transparent)}
.tb-mini-item.is-now{background:color-mix(in srgb,var(--tb-accent) 13%,transparent);box-shadow:inset 2px 0 0 var(--tb-accent)}
.tb-mini-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.tb-mini-item-title{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-mini-item-meta{font-size:9.5px;color:var(--tb-text3);display:flex;gap:6px;align-items:center}
.tb-mini-item[data-prio="0"] .tb-mini-item-title{color:color-mix(in srgb,var(--tb-red) 88%,var(--tb-text))}
.tb-dock-foot{display:flex;align-items:center;gap:8px;padding:7px 10px 9px;border-top:1px solid var(--tb-line-soft);flex:none;font-size:10px;color:var(--tb-text3)}
.tb-dock-foot b{color:var(--tb-text2);font-weight:600}
.tb-dock-stats{margin-left:auto;display:flex;align-items:center;gap:7px;white-space:nowrap}
.tb-dock-stats .is-over{color:var(--tb-red)}
.tb-dock-strip-hit{pointer-events:auto;position:absolute;display:flex;justify-content:flex-end;align-items:center;z-index:2}
.tb-dock-strip-hit[data-side="left"]{justify-content:flex-start}
.tb-dock-rail{position:absolute;pointer-events:auto;cursor:pointer;z-index:1;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--tb-accent) 22%,transparent));border-radius:8px 0 0 8px}
.tb-dock-rail[data-side="left"]{background:linear-gradient(270deg,transparent,color-mix(in srgb,var(--tb-accent) 22%,transparent));border-radius:0 8px 8px 0}
.tb-dock-strip{pointer-events:auto;position:relative;width:13px;height:156px;border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;text-orientation:mixed;letter-spacing:2px;font-size:10px;color:#fff;background:linear-gradient(180deg,color-mix(in srgb,var(--tb-accent) 94%,#fff),color-mix(in srgb,var(--tb-accent) 62%,#0a0d16));box-shadow:-2px 0 14px color-mix(in srgb,var(--tb-accent) 24%,transparent);cursor:pointer;user-select:none;transition:width .16s,filter .16s}
.tb-dock-strip:hover{width:15px;filter:brightness(1.05)}
.tb-dock-strip[data-side="left"]{border-radius:0 8px 8px 0;box-shadow:2px 0 14px color-mix(in srgb,var(--tb-accent) 24%,transparent)}
.tb-strip-badge{position:absolute;top:5px;right:1px;min-width:13px;height:13px;padding:0 3px;border-radius:99px;background:var(--tb-red);color:#fff;font-size:8.5px;line-height:13px;text-align:center;writing-mode:horizontal-tb}
.tb-dock-empty{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--tb-text3);font-size:10.5px;padding:18px 10px;line-height:1.7}

/* ---------- 虚拟时间轴 ---------- */
.tb-virtual{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;min-height:360px}
.tb-virtual-col{display:flex;flex-direction:column;gap:10px;min-width:0}
.tb-virtual-list{display:flex;flex-direction:column;gap:3px;max-height:320px;overflow:auto;padding-right:2px}
.tb-virtual-row{display:flex;align-items:center;gap:7px;padding:6px 7px;border-radius:8px;background:var(--tb-card);border:1px solid var(--tb-line-soft);font-size:11.5px}
.tb-virtual-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-virtual-dur{font-size:10px;color:var(--tb-text3);flex:none}
.tb-virtual-preview{flex:1;min-height:300px;max-height:430px;overflow:auto;padding:11px 12px;border-radius:10px;background:var(--tb-bg);border:1px solid var(--tb-line-soft);display:flex;flex-direction:column;gap:3px}
.tb-virtual-preview-row{display:flex;align-items:center;gap:8px;padding:5px 4px;border-bottom:1px dashed var(--tb-line-soft);font-size:11.5px}
.tb-virtual-preview-row:last-child{border-bottom:none}
.tb-virtual-preview-time{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--tb-accent);flex:none;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-virtual-preview-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--tb-text)}
.tb-virtual-preview-dur{font-size:10px;color:var(--tb-text3);flex:none}
@media (max-width:820px){.tb-virtual{grid-template-columns:minmax(0,1fr)}}

/* ---------- 到点提醒 ---------- */
.tb-reminder{position:fixed;left:50%;bottom:140px;transform:translateX(-50%);z-index:1200;display:flex;align-items:flex-start;gap:11px;width:min(430px,calc(100vw - 32px));padding:13px 14px;border-radius:14px;background:var(--tb-panel);border:1px solid color-mix(in srgb,var(--tb-accent) 40%,var(--tb-line));box-shadow:0 18px 50px rgba(0,0,0,.45),0 0 0 1px color-mix(in srgb,var(--tb-accent) 10%,transparent);animation:tb-reminder-in .2s ease}
@keyframes tb-reminder-in{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}
.tb-reminder-icon{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--tb-accent) 15%,transparent);color:var(--tb-accent);flex:none}
.tb-reminder-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.tb-reminder-kicker{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--tb-accent);font-weight:650;letter-spacing:.2px}
.tb-reminder-count{margin-left:auto;color:var(--tb-text3);font-weight:400}
.tb-reminder-title{font-size:13.5px;font-weight:650;color:var(--tb-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-reminder-meta{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--tb-text3);flex-wrap:wrap}
.tb-reminder-actions{display:flex;flex-direction:column;gap:5px;flex:none}
.tb-reminder-actions .tb-btn{height:26px;padding:0 9px;font-size:11px}
@media (max-width:620px){.tb-reminder{flex-wrap:wrap}.tb-reminder-actions{flex-direction:row;width:100%;justify-content:flex-end}}

/* ---------- 窄屏 ---------- */
@media (max-width:900px){
  .tb-page-body{grid-template-columns:minmax(0,1fr);overflow:auto;padding:12px 14px}
  .tb-side{overflow:visible;order:1}
  .tb-main{order:2;min-height:360px}
  .tb-page-head{padding:14px 14px 11px;gap:8px;flex-wrap:wrap}
  .tb-head-mid{order:3;width:100%;margin-left:0}
  .tb-head-right{margin-left:auto}
  .tb-foot{padding:8px 14px 12px}
  .tb-brand-sub{display:none}
}
@media (max-width:620px){
  .tb-form-grid{grid-template-columns:1fr}
  .tb-history{grid-template-columns:1fr}
  .tb-history-panel{border-left:none;padding-left:0;border-top:1px solid var(--tb-line-soft);padding-top:10px}
  .tb-editor{margin-left:0}
  .tb-dock-toggle-label{display:none}
  .tb-reflow-label{display:none}
  .tb-restore{font-size:10px;padding:0 4px;white-space:nowrap}
  .tb-calendar-label{display:none}
  .tb-virtual-label{display:none}
  .tb-back-label{display:none}
  .tb-back{padding:0 7px}
}
@media (prefers-reduced-motion:reduce){
  .tb-root *{animation-duration:0s!important;transition-duration:0s!important}
}
`;

function ensureBoardStyles() {
  if (typeof document === 'undefined') return;
  const id = 'dsh-taskboard/styles';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.dataset.plugin = 'dsh-taskboard';
  style.textContent = BOARD_CSS;
  document.head.appendChild(style);
}


/* ---- 10-ui.js ---- */
/* ==========================================================================
 * dsh-taskboard · 浏览器半侧：共享组件与弹层
 * ========================================================================== */

/* -------------------------------------------------------------- 基础组件 */

function IconButton(props) {
  return h(
    'button',
    {
      type: 'button',
      className: cx('tb-iconbtn', props.on ? 'is-on' : '', props.className),
      title: props.label,
      'aria-label': props.label,
      onClick: props.onClick,
      disabled: props.disabled,
    },
    props.children,
  );
}

function PrimaryButton(props) {
  return h(
    'button',
    {
      type: 'button',
      className: cx('tb-btn', props.primary ? 'is-primary' : '', props.danger ? 'is-danger' : '', props.ghost ? 'is-ghost' : '', props.className),
      onClick: props.onClick,
      disabled: props.disabled,
      title: props.title,
    },
    props.children,
  );
}

function PriorityBadge(props) {
  const p = Math.max(0, Math.min(3, Number(props.priority) || 0));
  return h('span', { className: 'tb-prio', 'data-p': p, title: '优先级 ' + PRIORITY_LABELS[p] }, PRIORITY_LABELS[p]);
}

function SwitchRow(props) {
  return h(
    'label',
    { className: 'tb-switch' },
    h('input', { type: 'checkbox', checked: !!props.checked, onChange: (event) => props.onChange(event.target.checked) }),
    h('span', { className: 'tb-switch-track' }),
    h('span', null, props.label),
  );
}

function FormField(props) {
  return h('div', { className: 'tb-field' }, h('span', { className: 'tb-field-label' }, props.label), props.children);
}

function Segmented(props) {
  return h(
    'div',
    { className: 'tb-seg-ctl', role: 'group', 'aria-label': props.label },
    (props.options || []).map((option) =>
      h(
        'button',
        {
          key: option.value,
          type: 'button',
          className: cx(String(props.value) === String(option.value) ? 'is-on' : ''),
          onClick: () => props.onChange(option.value),
        },
        option.label,
      ),
    ),
  );
}

function useEscape(handler, active) {
  useEffect(() => {
    if (active === false) return undefined;
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        handler();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handler, active]);
}

function Dialog(props) {
  useEscape(props.onClose, true);
  const bodyRef = useRef(null);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, []);
  return h(
    'div',
    {
      className: 'tb-modal-mask',
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) props.onClose();
      },
    },
    h(
      'div',
      { className: cx('tb-dialog', props.wide ? 'is-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
      h(
        'div',
        { className: 'tb-dialog-head' },
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'tb-dialog-title' }, props.title),
          props.subtitle ? h('div', { className: 'tb-dialog-sub' }, props.subtitle) : null),
        h(IconButton, { label: '关闭', onClick: props.onClose, className: 'tb-dialog-close' }, h(IconClose, { size: 17 })),
      ),
      h('div', { className: 'tb-dialog-body', ref: bodyRef }, props.children),
      props.footer ? h('div', { className: 'tb-dialog-foot' }, props.footer) : null,
    ),
  );
}

function ConfirmDialog(props) {
  useEscape(props.onClose, true);
  return h(
    'div',
    {
      className: 'tb-modal-mask',
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) props.onClose();
      },
    },
    h(
      'div',
      { className: 'tb-dialog', style: { width: 'min(420px,100%)' }, role: 'alertdialog', 'aria-modal': 'true', 'aria-label': props.title },
      h('div', { className: 'tb-dialog-head' }, h('div', { className: 'tb-dialog-title' }, props.title)),
      h('div', { className: 'tb-dialog-body' },
        h('div', { style: { fontSize: 12.5, lineHeight: 1.7, color: 'var(--tb-text2)' } }, props.message)),
      h('div', { className: 'tb-dialog-foot' },
        h('div', { className: 'tb-spacer' }),
        h(PrimaryButton, { onClick: props.onClose }, '取消'),
        h(PrimaryButton, { primary: true, danger: props.danger !== false, onClick: () => { props.onClose(); props.onConfirm(); } }, props.confirmText || '确定')),
    ),
  );
}

/* ------------------------------------------------------------- 日历弹层 */

function CalendarDialog(props) {
  const { today, selected, tasks, settings, onSelect, onClose } = props;
  const days = Array.from({ length: 8 }, (_, offset) => addDays(today, offset));

  return h(
    Dialog,
    {
      title: '选择日期',
      subtitle: '今天 + 未来 7 天 · 每天独立排程',
      onClose,
    },
    h(
      'div',
      { className: 'tb-calendar-grid' },
      days.map((date) => {
        const list = (tasks || []).filter((task) => task.date === date && !task.done);
        const need = list.reduce((sum, task) => sum + estimateOf(task, settings), 0);
        const isOn = date === selected;
        return h(
          'button',
          {
            key: date,
            type: 'button',
            className: cx('tb-cal-day', isOn ? 'is-on' : ''),
            onClick: () => onSelect(date),
          },
          h('span', { className: 'tb-cal-day-top' }, date === today ? '今天' : weekdayLabel(date)),
          h('span', { className: 'tb-cal-day-num' }, date.slice(5).replace('-', '/')),
          h('span', { className: 'tb-cal-day-meta' }, list.length > 0 ? list.length + ' 件 · ' + formatDuration(need) : '空'),
        );
      }),
    ),
    h('div', { className: 'tb-form-hint' }, '今天下班结束归档后，未完成的任务才会顺延到次日。未来日期各自独立，不会自动搬运今天的任务。'),
  );
}

/* ------------------------------------------------------------- 设置弹层 */

function SettingsDialog(props) {
  const { state, dataFile, onClose } = props;
  const [draft, setDraft] = useState(() => Object.assign({}, state.settings));
  const [overrideOn, setOverrideOn] = useState(!!state.settings.todayOverride);
  const existing = state.settings.todayOverride;
  const [overrideDraft, setOverrideDraft] = useState(() => ({
    workStart: (existing && existing.workStart) || state.settings.workStart,
    workEnd: (existing && existing.workEnd) || state.settings.workEnd,
    lunchOn: existing && existing.lunchOn !== undefined ? existing.lunchOn : state.settings.lunchOn,
    lunchStart: (existing && existing.lunchStart) || state.settings.lunchStart,
    lunchEnd: (existing && existing.lunchEnd) || state.settings.lunchEnd,
  }));
  const [pendingImport, setPendingImport] = useState(null);
  const [dockPrefs, setDockPrefs] = useState(readDockPrefs);
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const set = (key, value) => setDraft((prev) => Object.assign({}, prev, { [key]: value }));

  function setDockVisible(value) {
    const next = setDockVisibility(value);
    setDockPrefs(next);
    showToast(value ? '悬浮小窗已打开' : '悬浮小窗已关闭');
  }

  async function save() {
    setBusy(true);
    const result = await runAction('saveSettings', { settings: draft });
    setBusy(false);
    if (result) {
      showToast('设置已保存');
      onClose();
    }
  }

  async function applyOverride() {
    setBusy(true);
    const result = await runAction('setTodayOverride', {
      workStart: overrideDraft.workStart,
      workEnd: overrideDraft.workEnd,
      lunchOn: overrideDraft.lunchOn,
      lunchStart: overrideDraft.lunchStart,
      lunchEnd: overrideDraft.lunchEnd,
    });
    setBusy(false);
    if (result) showToast('已只改今天，次日自动恢复');
  }

  async function clearOverride() {
    setBusy(true);
    const result = await runAction('setTodayOverride', { clear: true });
    setBusy(false);
    if (result) {
      setOverrideOn(false);
      showToast('今天的临时时间已恢复默认');
    }
  }

  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB');
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('文件内容不是对象');
      setPendingImport({ name: file.name, data });
    } catch (error) {
      showToast('读取备份失败：' + (error instanceof Error ? error.message : String(error)), 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function confirmImport() {
    if (!pendingImport) return;
    setBusy(true);
    const result = await runAction('importState', { data: pendingImport.data });
    setBusy(false);
    if (result) {
      setPendingImport(null);
      showToast('备份已导入');
      onClose();
    }
  }

  return h(
    Dialog,
    {
      title: '任务排程设置',
      subtitle: '改动只影响这台机器上的本地数据',
      onClose,
      footer: [
        h(PrimaryButton, { key: 'cancel', onClick: onClose }, '取消'),
        h('div', { key: 'spacer', className: 'tb-spacer' }),
        h(PrimaryButton, { key: 'save', primary: true, disabled: busy, onClick: save }, busy ? '保存中…' : '保存设置'),
      ],
    },
    h(
      'div',
      { className: 'tb-form-block' },
      h('div', { className: 'tb-form-title' }, '上班时间'),
      h(
        'div',
        { className: 'tb-form-grid' },
        h(FormField, { label: '上班' }, h('input', { type: 'time', value: draft.workStart, onChange: (e) => set('workStart', e.target.value) })),
        h(FormField, { label: '下班' }, h('input', { type: 'time', value: draft.workEnd, onChange: (e) => set('workEnd', e.target.value) })),
      ),
      h(SwitchRow, { label: '午休不排任务', checked: draft.lunchOn, onChange: (value) => set('lunchOn', value) }),
      draft.lunchOn
        ? h(
            'div',
            { className: 'tb-form-grid' },
            h(FormField, { label: '午休开始' }, h('input', { type: 'time', value: draft.lunchStart, onChange: (e) => set('lunchStart', e.target.value) })),
            h(FormField, { label: '午休结束' }, h('input', { type: 'time', value: draft.lunchEnd, onChange: (e) => set('lunchEnd', e.target.value) })),
          )
        : null,
      h('div', { className: 'tb-form-hint' }, '任务不会被切成两段，也不会跨过午休；放不下的会进入「没排上」。'),
    ),

    h(
      'div',
      { className: 'tb-form-block' },
      h('div', { className: 'tb-form-title' }, '只改今天', h('span', { className: 'tb-form-note' }, existing ? '今天已有临时时间' : '次日自动恢复')),
      h(SwitchRow, {
        label: '今天临时调整上下班/午休',
        checked: overrideOn,
        onChange: (value) => {
          setOverrideOn(value);
          if (!value) clearOverride();
        },
      }),
      overrideOn
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h(
              'div',
              { className: 'tb-form-grid' },
              h(FormField, { label: '今天上班' }, h('input', { type: 'time', value: overrideDraft.workStart, onChange: (e) => setOverrideDraft(Object.assign({}, overrideDraft, { workStart: e.target.value })) })),
              h(FormField, { label: '今天下班' }, h('input', { type: 'time', value: overrideDraft.workEnd, onChange: (e) => setOverrideDraft(Object.assign({}, overrideDraft, { workEnd: e.target.value })) })),
            ),
            h(SwitchRow, {
              label: '今天保留午休',
              checked: overrideDraft.lunchOn,
              onChange: (value) => setOverrideDraft(Object.assign({}, overrideDraft, { lunchOn: value })),
            }),
            overrideDraft.lunchOn
              ? h(
                  'div',
                  { className: 'tb-form-grid' },
                  h(FormField, { label: '午休开始' }, h('input', { type: 'time', value: overrideDraft.lunchStart, onChange: (e) => setOverrideDraft(Object.assign({}, overrideDraft, { lunchStart: e.target.value })) })),
                  h(FormField, { label: '午休结束' }, h('input', { type: 'time', value: overrideDraft.lunchEnd, onChange: (e) => setOverrideDraft(Object.assign({}, overrideDraft, { lunchEnd: e.target.value })) })),
                )
              : null,
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h(PrimaryButton, { primary: true, disabled: busy, onClick: applyOverride }, '应用到今天'),
              existing ? h(PrimaryButton, { disabled: busy, onClick: clearOverride }, '恢复默认') : null,
              h('span', { className: 'tb-form-hint', style: { marginLeft: 'auto' } }, '例：加班到 21:00，明天仍是 18:00'),
            ),
          )
        : null,
    ),

    h(
      'div',
      { className: 'tb-form-block' },
      h('div', { className: 'tb-form-title' }, '顺延与默认值'),
      h(SwitchRow, {
        label: '次日自动把没打勾的任务顺延到今天',
        checked: draft.autoCarry,
        onChange: (value) => set('autoCarry', value),
      }),
      h(
        'div',
        { className: 'tb-form-grid' },
        h(FormField, { label: '没填耗时的默认分钟数' },
          h('input', {
            type: 'number',
            min: 5,
            max: 480,
            step: 5,
            value: draft.defaultEstimateMin,
            onChange: (e) => set('defaultEstimateMin', Number(e.target.value) || 30),
          })),
      ),
      h('div', { className: 'tb-form-hint' }, '顺延会保留原截止时间——真过期了就该看到红色提醒。顺延前会先按天归档，历史不丢。'),
    ),

    h(
      'div',
      { className: 'tb-form-block' },
      h('div', { className: 'tb-form-title' }, '提醒'),
      h(SwitchRow, {
        label: '任务开始 / 下个任务开始时弹窗提醒',
        checked: draft.remindersOn !== false,
        onChange: (value) => set('remindersOn', value),
      }),
      draft.remindersOn !== false
        ? h(
            'div',
            { className: 'tb-form-grid' },
            h(FormField, { label: '下个任务提前提醒（分钟）' },
              h('input', {
                type: 'number',
                min: 1,
                max: 60,
                step: 1,
                value: draft.reminderLeadMin,
                onChange: (event) => set('reminderLeadMin', Number(event.target.value) || 5),
              })),
            h('div', { style: { display: 'flex', alignItems: 'flex-end', paddingBottom: 4 } },
              h(SwitchRow, {
                label: '提示音',
                checked: draft.reminderSound !== false,
                onChange: (value) => set('reminderSound', value),
              })),
          )
        : null,
      h('div', { className: 'tb-form-hint' }, '只提醒今天的时间轴：到点弹「现在开始」，下个任务开始前按设定分钟弹「即将开始」。'),
    ),

    h(
      'div',
      { className: 'tb-form-block' },
      h('div', { className: 'tb-form-title' }, '悬浮小窗'),
      h(SwitchRow, {
        label: '在窗口右侧显示贴边悬浮小窗',
        checked: dockPrefs.enabled,
        onChange: setDockVisible,
      }),
      h('div', { className: 'tb-form-hint' }, '小窗上的 × 只是收起成细条。彻底隐藏后，可以在这里或「任务排程」页右上角的悬浮窗按钮重新打开。'),
    ),

    h(
      'div',
      { className: 'tb-form-block' },
      h('div', { className: 'tb-form-title' }, '数据'),
      h('div', { className: 'tb-form-hint' }, '全部数据保存在本机 JSON 文件里，不联网、不登录。'),
      h('div', { style: { fontSize: 10.5, color: 'var(--tb-text3)', wordBreak: 'break-all', fontFamily: 'ui-monospace,Consolas,monospace' } }, dataFile || '（路径将在首次保存后显示）'),
      h(
        'div',
        { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h('a', { className: 'tb-btn', href: API_BASE + '/export', download: '' }, '导出备份'),
        h(PrimaryButton, { onClick: () => fileRef.current && fileRef.current.click() }, '导入备份'),
        h('input', {
          ref: fileRef,
          type: 'file',
          accept: 'application/json,.json',
          style: { display: 'none' },
          onChange: (event) => importFile(event.target.files && event.target.files[0]),
        }),
      ),
      pendingImport
        ? h(
            'div',
            { className: 'tb-error', style: { margin: 0 } },
            h('div', { style: { flex: 1 } },
              h('div', null, '即将用「' + pendingImport.name + '」覆盖当前任务、设置与历史。'),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                h(PrimaryButton, { danger: true, onClick: confirmImport, disabled: busy }, '覆盖导入'),
                h(PrimaryButton, { onClick: () => setPendingImport(null) }, '取消'))),
          )
        : null,
      h('div', { className: 'tb-form-hint' }, '也兼容旧版任务排程小窗的 data/state.json：直接选中那个文件即可。'),
    ),

    h('div', { style: { fontSize: 10.5, color: 'var(--tb-text3)', textAlign: 'center' } }, 'dsh-taskboard v0.1.0 · 排程算法与宿主共用同一份源码'),
  );
}

/* ------------------------------------------------------------- 历史弹层 */

function HistoryDialog(props) {
  const { state, onClose } = props;
  const days = useMemo(() => Object.keys(state.history || {}).sort().reverse(), [state.history]);
  const [selected, setSelected] = useState(days[0] || null);
  const entry = selected ? state.history[selected] : null;

  return h(
    Dialog,
    { title: '历史记录', subtitle: '按天归档，只读；不参与今天的排程', onClose, wide: true },
    days.length === 0
      ? h('div', { className: 'tb-empty', style: { minHeight: 200 } },
          h('div', { className: 'tb-empty-mark' }, h(IconHistory, { size: 22 })),
          h('div', { className: 'tb-empty-title' }, '还没有历史'),
          h('div', { className: 'tb-empty-sub' }, '跨天顺延前会自动把前一天归档，之后就能在这里翻看。'))
      : h(
          'div',
          { className: 'tb-history' },
          h(
            'div',
            { className: 'tb-history-list' },
            days.map((day) =>
              h(
                'button',
                {
                  key: day,
                  type: 'button',
                  className: cx('tb-history-date', day === selected ? 'is-on' : ''),
                  onClick: () => setSelected(day),
                },
                h('span', null, dateLabel(day, state.today || todayKeyOf())),
                h('small', null, (state.history[day].stats ? state.history[day].stats.total : (state.history[day].tasks || []).length) + ' 件'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'tb-history-panel' },
            entry
              ? [
                  h('div', { key: 'title', className: 'tb-history-day-title' }, dateLabel(entry.date || selected, state.today || todayKeyOf())),
                  h('div', { key: 'sub', className: 'tb-history-day-sub' },
                    (entry.stats
                      ? '共 ' + entry.stats.total + ' 件 · 完成 ' + entry.stats.done + ' 件 · 预计 ' + formatDuration(entry.stats.estimateMin)
                      : '共 ' + (entry.tasks || []).length + ' 件')),
                  (entry.tasks || []).length === 0
                    ? h('div', { key: 'empty', className: 'tb-section-empty' }, '这一天没有任务')
                    : (entry.tasks || []).map((task) =>
                        h(
                          'div',
                          { key: task.id, className: 'tb-history-row' },
                          h('span', { className: cx('tb-history-check', task.done ? 'is-on' : '') }, task.done ? h(IconCheck, { size: 10 }) : null),
                          h('span', { className: cx('tb-mini-title', task.done ? 'is-done' : '') }, task.title),
                          h('span', { style: { fontSize: 10, color: 'var(--tb-text3)' } }, PRIORITY_LABELS[task.priority] || 'P2'),
                          h('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--tb-text3)' } }, formatDuration(task.estimateMin)),
                        ),
                      ),
                ]
              : null,
          ),
        ),
  );
}


/* ---- 15-virtual.js ---- */
/* ==========================================================================
 * dsh-taskboard · 浏览器半侧：虚拟时间轴
 *
 * 独立于真实日期的一份草稿：自由加任务、排先后/固定开始，实时预览；
 * 确认后覆盖到页面上选中的那一天；可导出 JSON 给另一台设备导入。
 * ========================================================================== */

const VIRTUAL_DATE = '2000-01-01';

function virtualPreviewPlan(tasks, settings) {
  const mapped = (tasks || []).map((task, index) => ({
    id: task.id,
    title: task.title,
    priority: task.priority,
    estimateMin: task.estimateMin,
    dueAt: null,
    pinnedStart: task.pinnedTime ? VIRTUAL_DATE + 'T' + task.pinnedTime : null,
    date: VIRTUAL_DATE,
    done: false,
    carried: false,
    actualMin: null,
    order: index,
    createdAt: VIRTUAL_DATE + 'T09:00',
  }));
  return schedule(mapped, settings, VIRTUAL_DATE, { now: new Date(VIRTUAL_DATE + 'T00:00') });
}

function VirtualDialog(props) {
  const { state, targetDate, onClose } = props;
  const tasks = (state.virtual && state.virtual.tasks) || [];
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState(2);
  const [estimate, setEstimate] = useState('');
  const [pinnedTime, setPinnedTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileRef = useRef(null);

  const preview = useMemo(() => virtualPreviewPlan(tasks, state.settings), [tasks, state.settings]);

  async function addTask() {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    const result = await runAction('virtualAdd', {
      title: value,
      priority,
      estimateMin: Number(estimate) || undefined,
      pinnedTime: pinnedTime || null,
    });
    setBusy(false);
    if (result) {
      setTitle('');
      setEstimate('');
      setPinnedTime('');
    }
  }

  async function moveTask(id, direction) {
    const ids = tasks.map((task) => task.id);
    const index = ids.indexOf(id);
    const swap = index + direction;
    if (index < 0 || swap < 0 || swap >= ids.length) return;
    const next = ids.slice();
    next[index] = ids[swap];
    next[swap] = id;
    await runAction('virtualReorder', { ids: next });
  }

  async function removeTask(id) {
    await runAction('virtualDelete', { id });
  }

  async function clearAll() {
    setBusy(true);
    await runAction('virtualClear', {});
    setBusy(false);
    setConfirmClear(false);
  }

  async function applyToDate() {
    setBusy(true);
    const result = await runAction('virtualApply', { date: targetDate });
    setBusy(false);
    if (result) {
      showToast('虚拟时间轴已覆盖到 ' + dateLabel(targetDate, todayKeyOf()));
      onClose();
    }
  }

  function exportVirtual() {
    const payload = {
      type: 'dsh-taskboard-virtual',
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks,
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'virtual-timeline-' + todayKeyOf() + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('虚拟时间轴已导出');
    } catch (error) {
      showToast('导出失败：' + (error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  async function importVirtual(file) {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB');
      const text = await file.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data && Array.isArray(data.tasks) ? data.tasks : null;
      if (!list) throw new Error('文件里没有 tasks 数组');
      setBusy(true);
      const result = await runAction('virtualImport', { data: { tasks: list } });
      setBusy(false);
      if (result) showToast('已导入 ' + list.length + ' 个虚拟任务');
    } catch (error) {
      showToast('导入失败：' + (error instanceof Error ? error.message : String(error)), 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return h(
    Dialog,
    {
      title: '虚拟时间轴',
      subtitle: '自由安排任务，确认后覆盖到选中的日期；可导出/导入',
      wide: true,
      onClose,
      footer: confirmApply
        ? [
            h('span', { key: 'warn', style: { fontSize: 11, color: 'var(--tb-warn)', flex: 1 } },
              '会清空 ' + dateLabel(targetDate, todayKeyOf()) + ' 现有全部任务，确认覆盖？'),
            h(PrimaryButton, { key: 'cancel', onClick: () => setConfirmApply(false) }, '取消'),
            h(PrimaryButton, { key: 'ok', primary: true, danger: true, disabled: busy, onClick: applyToDate }, '确认覆盖'),
          ]
        : [
            h(PrimaryButton, { key: 'export', onClick: exportVirtual, title: '导出给其他设备导入' }, '导出'),
            h(PrimaryButton, { key: 'import', onClick: () => fileRef.current && fileRef.current.click() }, '导入'),
            h('input', {
              key: 'file',
              ref: fileRef,
              type: 'file',
              accept: 'application/json,.json',
              style: { display: 'none' },
              onChange: (event) => importVirtual(event.target.files && event.target.files[0]),
            }),
            h('div', { key: 'spacer', className: 'tb-spacer' }),
            h(PrimaryButton, { key: 'close', onClick: onClose }, '关闭'),
            h(PrimaryButton, {
              key: 'apply',
              primary: true,
              disabled: busy || tasks.length === 0,
              onClick: () => setConfirmApply(true),
            }, '覆盖到 ' + dateLabel(targetDate, todayKeyOf())),
          ],
    },
    h(
      'div',
      { className: 'tb-virtual' },
      h(
        'div',
        { className: 'tb-virtual-col' },
        h(
          'div',
          { className: 'tb-quick' },
          h('div', { className: 'tb-quick-row' },
            h('input', {
              className: 'tb-quick-input',
              value: title,
              placeholder: '虚拟任务…',
              maxLength: 500,
              'aria-label': '虚拟任务内容',
              onChange: (event) => setTitle(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTask();
                }
              },
            }),
            h('button', { type: 'button', className: 'tb-quick-add', title: '添加', 'aria-label': '添加虚拟任务', onClick: addTask }, h(IconPlus, { size: 16 })),
          ),
          h(
            'div',
            { className: 'tb-quick-opts' },
            h(
              'div',
              { className: 'tb-prio-chips', role: 'group', 'aria-label': '优先级' },
              [0, 1, 2, 3].map((p) =>
                h('button', {
                  key: p,
                  type: 'button',
                  className: cx('tb-prio-chip', priority === p ? 'is-on' : ''),
                  'data-p': p,
                  onClick: () => setPriority(p),
                }, 'P' + p),
              ),
            ),
            h('label', { className: 'tb-mini-field', title: '预计耗时' },
              h('input', {
                type: 'number',
                min: 1,
                max: 1440,
                step: 5,
                value: estimate,
                placeholder: String(state.settings.defaultEstimateMin),
                'aria-label': '虚拟任务预计耗时',
                onChange: (event) => setEstimate(event.target.value),
              }),
              h('span', null, '分钟')),
            h('label', { className: 'tb-mini-field', title: '固定的开始时刻，可留空' },
              h('span', null, '固定'),
              h('input', {
                type: 'time',
                value: pinnedTime,
                'aria-label': '虚拟任务固定开始',
                onChange: (event) => setPinnedTime(event.target.value),
              })),
          ),
        ),
        h(
          'div',
          { className: 'tb-virtual-list' },
          tasks.length === 0
            ? h('div', { className: 'tb-section-empty' }, '还没有虚拟任务。加几件，看看它们会怎么排。')
            : tasks.map((task, index) =>
                h(
                  'div',
                  { key: task.id, className: 'tb-virtual-row' },
                  h(PriorityBadge, { priority: task.priority }),
                  h('span', { className: 'tb-virtual-title' }, task.title),
                  task.pinnedTime ? h('span', { className: 'tb-badge is-muted' }, '固定 ' + task.pinnedTime) : null,
                  h('span', { className: 'tb-virtual-dur' }, formatDuration(task.estimateMin)),
                  h('button', { type: 'button', className: 'tb-tinybtn', title: '上移', disabled: index === 0, onClick: () => moveTask(task.id, -1) }, h(IconChevron, { size: 12, direction: 'up' })),
                  h('button', { type: 'button', className: 'tb-tinybtn', title: '下移', disabled: index === tasks.length - 1, onClick: () => moveTask(task.id, 1) }, h(IconChevron, { size: 12 })),
                  h('button', { type: 'button', className: 'tb-tinybtn is-danger', title: '删除', onClick: () => removeTask(task.id) }, h(IconTrash, { size: 13 })),
                ),
              ),
        ),
        tasks.length > 0
          ? h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end' } },
              confirmClear
                ? h('span', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--tb-warn)' } },
                    '确定清空虚拟时间轴？',
                    h('button', { type: 'button', className: 'tb-linkbtn', onClick: clearAll }, '清空'),
                    h('button', { type: 'button', className: 'tb-linkbtn', onClick: () => setConfirmClear(false) }, '取消'))
                : h('button', { type: 'button', className: 'tb-linkbtn', onClick: () => setConfirmClear(true) }, '清空虚拟时间轴'),
            )
          : null,
      ),
      h(
        'div',
        { className: 'tb-virtual-col' },
        h(
          'div',
          { className: 'tb-virtual-preview' },
          h('div', { className: 'tb-form-title', style: { marginBottom: 8 } }, '预览 · 虚拟一天'),
          tasks.length === 0
            ? h('div', { className: 'tb-section-empty' }, '添加任务后，这里会显示自动排好的时间。')
            : preview.placed.map((entry) =>
                h(
                  'div',
                  { key: entry.task.id, className: 'tb-virtual-preview-row' },
                  h('span', { className: 'tb-virtual-preview-time' }, entry.parts.map((part) => formatClock(part.startMin) + '–' + formatClock(part.endMin)).join(' + ')),
                  h('span', { className: 'tb-virtual-preview-title' }, entry.task.title),
                  h('span', { className: 'tb-virtual-preview-dur' }, formatDuration(entry.durationMin)),
                ),
              ),
          preview.unplaced.length > 0
            ? h('div', { className: 'tb-form-hint', style: { marginTop: 8, color: 'var(--tb-red)' } },
                '没排上：' + preview.unplaced.map((task) => task.title).join('、'))
            : null,
        ),
        h('div', { className: 'tb-form-hint' },
          '虚拟时间轴只在这台设备上保存；导出 JSON 后可到另一台设备导入。覆盖会替换目标日期当前的全部任务。'),
      ),
    ),
  );
}


/* ---- 20-page.js ---- */
/* ---- 20-page.js ---- */
/* ==========================================================================
 * dsh-taskboard · 浏览器半侧：完整面板（侧边栏「任务排程」）
 * ========================================================================== */

/* -------------------------------------------------------------- 快速添加 */

/** 从完整面板回到刚才的对话：只切主面板，不改变当前会话。 */
function returnToConversation() {
  try {
    const layout = appContext && typeof appContext.get === 'function' ? appContext.get('layout') : null;
    if (layout && typeof layout.selectPanel === 'function') {
      layout.selectPanel(null);
      return true;
    }
  } catch (error) {
    console.warn('[dsh-taskboard] 返回对话失败：' + (error instanceof Error ? error.message : String(error)));
  }
  return false;
}

function QuickAdd(props) {
  const { settings, today } = props;
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState(2);
  const [estimate, setEstimate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [mode, setMode] = useState('auto');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const isTodayView = today === todayKeyOf();

  /** 今天从当前时间开始；未来日期从上班开始。 */
  function defaultStartMinute() {
    if (isTodayView) return nextWorkMinute(settings, today, minuteOfDay(new Date()));
    return toMinutes(workWindows(settings, today).settings.workStart) ?? 9 * 60;
  }

  function enterRange() {
    setMode('range');
    if (!startTime) {
      const start = defaultStartMinute();
      const minutes = Number(estimate) || settings.defaultEstimateMin;
      setStartTime(fromMinutes(start));
      setEndTime(fromMinutes(addWorkMinutes(settings, today, start, minutes)));
    }
  }

  function useNowRange() {
    const start = defaultStartMinute();
    const minutes = Number(estimate) || settings.defaultEstimateMin;
    setMode('range');
    setStartTime(fromMinutes(start));
    setEndTime(fromMinutes(addWorkMinutes(settings, today, start, minutes)));
  }

  /** 把预计耗时直接填成「从当前（或指定开始）到下班」的工作分钟数。 */
  function fillToWorkEnd() {
    const win = workWindows(settings, today);
    const endMin = toMinutes(win.settings.workEnd) ?? 18 * 60;
    const rawStart = mode === 'range' && startTime ? toMinutes(startTime) : defaultStartMinute();
    const startMin = nextWorkMinute(settings, today, rawStart === null ? defaultStartMinute() : rawStart);
    const minutes = workMinutesBetween(settings, today, startMin, endMin);
    if (!(minutes > 0)) {
      showToast('今天已经下班了，没有可排的时间', 'error');
      return;
    }
    setEstimate(String(minutes));
    if (mode === 'range') {
      setStartTime(fromMinutes(startMin));
      setEndTime(fromMinutes(endMin));
    }
  }

  async function submit() {
    const value = title.trim();
    if (!value || busy) return;

    let estimateMin = Number(estimate) || undefined;
    let pinnedStart = null;

    if (mode === 'range') {
      const fallbackStart = defaultStartMinute();
      const rawStart = startTime ? toMinutes(startTime) : fallbackStart;
      if (rawStart === null) {
        showToast('请选择开始时间', 'error');
        return;
      }
      // 午休/上班前选的时间自动落到最近的可工作分钟（例如 12:30 → 13:00）。
      const startMin = nextWorkMinute(settings, today, rawStart);
      const endMin = endTime ? toMinutes(endTime) : null;
      if (endMin !== null && endMin <= startMin) {
        showToast('结束时间要晚于开始时间', 'error');
        return;
      }
      if (endMin !== null) {
        const work = workMinutesBetween(settings, today, startMin, endMin);
        if (work <= 0) {
          showToast('这段区间不在上班时间内（或正好是午休）', 'error');
          return;
        }
        estimateMin = work;
      }
      pinnedStart = today + 'T' + fromMinutes(startMin);
    }

    setBusy(true);
    const wasAutoToday = isTodayView && mode === 'auto';
    const result = await runAction('addTask', {
      title: value,
      priority,
      estimateMin,
      pinnedStart,
      date: today,
      dueAt: combineDateTime(dueDate || (dueTime ? today : ''), dueTime || (dueDate ? '23:59' : '')),
    });
    setBusy(false);
    if (result) {
      // 今天自动排且还在上班时间内：从现在开始接着排，不回填到早上。
      if (wasAutoToday) {
        const win = workWindows(settings, today).settings;
        const nowMin = minuteOfDay(new Date());
        const startMin = toMinutes(win.workStart) ?? 0;
        const endMin = toMinutes(win.workEnd) ?? 24 * 60;
        if (nowMin >= startMin && nowMin < endMin) writeAnchorMinute(today, nowMin);
      }
      setTitle('');
      setDueDate('');
      setDueTime('');
      setMode('auto');
      setStartTime('');
      setEndTime('');
      if (inputRef.current) inputRef.current.focus();
    }
  }

  return h(
    'div',
    { className: 'tb-quick' },
    h(
      'div',
      { className: 'tb-quick-row' },
      h('input', {
        ref: inputRef,
        className: 'tb-quick-input',
        value: title,
        placeholder: '记一件事，回车添加…',
        'aria-label': '任务内容',
        maxLength: 500,
        onChange: (event) => setTitle(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            setTitle('');
          }
        },
      }),
      h(
        'button',
        { type: 'button', className: 'tb-quick-add', title: '添加任务（Enter）', 'aria-label': '添加任务', disabled: !title.trim() || busy, onClick: submit },
        h(IconPlus, { size: 18 }),
      ),
    ),
    h(
      'div',
      { className: 'tb-quick-opts' },
      h(
        'div',
        { className: 'tb-prio-chips', role: 'group', 'aria-label': '优先级' },
        [0, 1, 2, 3].map((p) =>
          h(
            'button',
            {
              key: p,
              type: 'button',
              className: cx('tb-prio-chip', priority === p ? 'is-on' : ''),
              'data-p': p,
              title: p === 0 ? 'P0 最急' : p === 3 ? 'P3 最低' : 'P' + p,
              onClick: () => setPriority(p),
            },
            'P' + p,
          ),
        ),
      ),
      h(
        'label',
        { className: 'tb-mini-field', title: '预计耗时；留空按默认 ' + settings.defaultEstimateMin + ' 分钟' },
        h('input', {
          type: 'number',
          min: 1,
          max: 1440,
          step: 5,
          value: estimate,
          placeholder: String(settings.defaultEstimateMin),
          'aria-label': '预计耗时（分钟）',
          onChange: (event) => setEstimate(event.target.value),
        }),
        h('span', null, '分钟'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'tb-linkbtn',
          title: '按现在（固定时间时按开始时间）到下班计算预计耗时；固定时间时同时把结束设为下班',
          onClick: fillToWorkEnd,
        },
        '到下班',
      ),
      h(
        'label',
        { className: 'tb-mini-field', title: '截止日期是最后期限，不是任务结束时间' },
        h('span', null, '截止'),
        h('input', {
          type: 'date',
          value: dueDate,
          'aria-label': '截止日期',
          onChange: (event) => setDueDate(event.target.value),
        }),
      ),
      h(
        'label',
        { className: 'tb-mini-field', title: '截止时刻是最后期限，不是任务结束时间' },
        h('input', {
          type: 'time',
          value: dueTime,
          'aria-label': '截止时刻',
          onChange: (event) => setDueTime(event.target.value),
        }),
      ),
    ),
    h(
      'div',
      { className: 'tb-quick-opts tb-quick-time' },
      h(
        'div',
        { className: 'tb-seg-ctl', role: 'group', 'aria-label': '排程方式' },
        h('button', { type: 'button', className: mode === 'auto' ? 'is-on' : '', onClick: () => setMode('auto') }, '自动排'),
        h('button', { type: 'button', className: mode === 'range' ? 'is-on' : '', onClick: enterRange }, '固定时间'),
      ),
      mode === 'range'
        ? [
            h(
              'label',
              { key: 'start', className: 'tb-mini-field', title: '固定开始时间；可以选过去的时间来补前面的空档' },
              h('span', null, '开始'),
              h('input', {
                type: 'time',
                value: startTime,
                'aria-label': '开始时间',
                onChange: (event) => setStartTime(event.target.value),
              }),
            ),
            h('button', { key: 'now', type: 'button', className: 'tb-linkbtn', title: isTodayView ? '从现在开始；午休时从午休结束算' : '从上班时间开始', onClick: useNowRange }, isTodayView ? '现在' : '上班'),
            h(
              'label',
              { key: 'end', className: 'tb-mini-field', title: '固定时段的结束；留空 = 只固定开始，耗时用上面的预计耗时' },
              h('span', null, '结束'),
              h('input', {
                type: 'time',
                value: endTime,
                'aria-label': '结束时间',
                onChange: (event) => setEndTime(event.target.value),
              }),
            ),
            h('span', { key: 'hint', className: 'tb-quick-hint', style: { marginLeft: 0 } }, '结束留空 = 只固定开始'),
          ]
        : h('span', { key: 'hint', className: 'tb-quick-hint' }, '自动排会先填满当前空档；要固定开始时间就选「固定时间」'),
    ),
  );
}

/* ------------------------------------------------------------ 行内编辑器 */

function TaskEditor(props) {
  const { task, onClose, onRequestDelete, settings, today } = props;
  const [title, setTitle] = useState(task.title);
  const [estimate, setEstimate] = useState(String(task.estimateMin));
  const [due, setDue] = useState(() => splitDateTime(task.dueAt));
  const [pin, setPin] = useState(() => splitDateTime(task.pinnedStart));
  const [actual, setActual] = useState(task.actualMin === null || task.actualMin === undefined ? '' : String(task.actualMin));
  const [busy, setBusy] = useState(false);
  const titleRef = useRef(null);
  const editorRef = useRef(null);

  useEffect(() => {
    const element = editorRef.current;
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, []);

  async function patch(fields) {
    setBusy(true);
    await runAction('updateTask', Object.assign({ id: task.id }, fields));
    setBusy(false);
  }

  function commitTitle() {
    const next = title.trim();
    if (!next) {
      setTitle(task.title);
      return;
    }
    if (next !== task.title) patch({ title: next });
  }

  function commitEstimate() {
    const next = Number(estimate);
    if (!Number.isFinite(next) || next <= 0) {
      setEstimate(String(task.estimateMin));
      return;
    }
    if (next !== task.estimateMin) patch({ estimateMin: next });
  }

  /** 把预计耗时改成从固定开始（或现在/上班）到下班的工作分钟数。 */
  function fillToWorkEnd() {
    if (!settings || !today) return;
    const win = workWindows(settings, today);
    const endMin = toMinutes(win.settings.workEnd) ?? 18 * 60;
    const pinned = parseLocalDateTime(task.pinnedStart);
    const nowMin = minuteOfDay(new Date());
    const isToday = today === todayKeyOf();
    const base = pinned
      ? pinned.getHours() * 60 + pinned.getMinutes()
      : isToday
        ? nowMin
        : toMinutes(win.settings.workStart) ?? 9 * 60;
    const startMin = nextWorkMinute(settings, today, base);
    const minutes = workMinutesBetween(settings, today, startMin, endMin);
    if (!(minutes > 0)) {
      showToast('已经没有可排的时间了', 'error');
      return;
    }
    setEstimate(String(minutes));
    patch({ estimateMin: minutes });
  }

  const dueValue = combineDateTime(due.date, due.time);
  const pinValue = combineDateTime(pin.date, pin.time);

  return h(
    'div',
    { ref: editorRef, className: 'tb-editor', onClick: (event) => event.stopPropagation(), onMouseDown: (event) => event.stopPropagation() },
    h('input', {
      ref: titleRef,
      className: 'tb-editor-input',
      value: title,
      maxLength: 500,
      'aria-label': '任务内容',
      onChange: (event) => setTitle(event.target.value),
      onBlur: commitTitle,
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitTitle();
          titleRef.current && titleRef.current.blur();
        } else if (event.key === 'Escape') {
          event.stopPropagation();
          setTitle(task.title);
          onClose();
        }
      },
    }),
    h(
      'div',
      { className: 'tb-editor-grid' },
      h(
        FormField,
        { label: '优先级' },
        h(Segmented, {
          value: task.priority,
          label: '优先级',
          options: [0, 1, 2, 3].map((p) => ({ value: p, label: 'P' + p })),
          onChange: (value) => patch({ priority: value }),
        }),
      ),
      h(FormField, { label: '预计耗时（分钟）' },
        h('input', {
          type: 'number',
          min: 1,
          max: 1440,
          step: 5,
          value: estimate,
          onChange: (event) => setEstimate(event.target.value),
          onBlur: commitEstimate,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitEstimate();
            }
          },
        }),
        h('div', { className: 'tb-field-actions' },
          h('button', {
            type: 'button',
            className: 'tb-linkbtn',
            title: '延长 15 分钟，后面的任务自动顺延',
            onClick: () => {
              const next = task.estimateMin + 15;
              setEstimate(String(next));
              patch({ estimateMin: next });
            },
          }, '+15'),
          h('button', {
            type: 'button',
            className: 'tb-linkbtn',
            title: '延长 30 分钟，后面的任务自动顺延',
            onClick: () => {
              const next = task.estimateMin + 30;
              setEstimate(String(next));
              patch({ estimateMin: next });
            },
          }, '+30'),
          h('button', {
            type: 'button',
            className: 'tb-linkbtn',
            title: '改成从固定开始（或现在）到下班，自动扣午休',
            onClick: fillToWorkEnd,
          }, '到下班'))),
      h(FormField, { label: '截止（最后期限）' },
        h('div', { className: 'tb-field-pair' },
          h('input', {
            type: 'date',
            value: due.date,
            'aria-label': '截止日期',
            onChange: (event) => {
              const next = { date: event.target.value, time: due.time || (event.target.value ? '18:00' : '') };
              setDue(next);
              patch({ dueAt: combineDateTime(next.date, next.time) });
            },
          }),
          h('input', {
            type: 'time',
            value: due.time,
            'aria-label': '截止时刻',
            onChange: (event) => {
              const next = { date: due.date || (event.target.value ? today : ''), time: event.target.value };
              setDue(next);
              patch({ dueAt: combineDateTime(next.date, next.time) });
            },
          }))),
      h(FormField, { label: '固定开始' },
        h('div', { className: 'tb-field-pair' },
          h('input', {
            type: 'date',
            value: pin.date,
            'aria-label': '固定开始日期',
            onChange: (event) => {
              const next = { date: event.target.value, time: pin.time || (event.target.value ? '09:00' : '') };
              setPin(next);
              patch({ pinnedStart: combineDateTime(next.date, next.time) });
            },
          }),
          h('input', {
            type: 'time',
            value: pin.time,
            'aria-label': '固定开始时刻',
            onChange: (event) => {
              const next = { date: pin.date || (event.target.value ? today : ''), time: event.target.value };
              setPin(next);
              patch({ pinnedStart: combineDateTime(next.date, next.time) });
            },
          }))),
    ),
    h(
      'div',
      { className: 'tb-editor-foot' },
      h('span', { className: 'tb-editor-hint' }, pinValue ? '固定后位置不动：撞午休/下班/其他固定任务只标红，不搬动。' : '修改即重排；要固定开始时间就填「固定开始」。'),
      h('div', { className: 'tb-spacer' }),
      h(
        'label',
        { className: 'tb-mini-field', title: '实际耗时，可选' },
        h('span', null, '实际'),
        h('input', {
          type: 'number',
          min: 0,
          max: 1440,
          step: 5,
          value: actual,
          'aria-label': '实际耗时（分钟）',
          onChange: (event) => setActual(event.target.value),
          onBlur: () => {
            const next = actual === '' ? null : Number(actual);
            if (next !== task.actualMin) patch({ actualMin: next === null ? null : Math.max(0, next) });
          },
        }),
        h('span', null, '分钟'),
      ),
      dueValue ? h('button', { type: 'button', className: 'tb-linkbtn', onClick: () => { setDue({ date: '', time: '' }); patch({ dueAt: null }); } }, '清除截止') : null,
      pinValue ? h('button', { type: 'button', className: 'tb-linkbtn', onClick: () => { setPin({ date: '', time: '' }); patch({ pinnedStart: null }); } }, '取消固定') : null,
      h('button', { type: 'button', className: 'tb-btn is-danger', disabled: busy, onClick: () => onRequestDelete(task) }, h(IconTrash, { size: 13 }), '删除'),
    ),
  );
}

/* ----------------------------------------------------------------- 任务行 */

function TaskRow(props) {
  const { entry, part, today, active, onOpen, onToggle, dragId, onDragStart, onDragEnd, onDragOver, onDrop, planNowMin } = props;
  const task = entry.task;
  const overdue = entry.flags.overdue;
  const late = entry.flags.due > 0;
  const pinConflict = entry.pinned && entry.conflict;
  const isCurrent = !!part.current;
  const isCont = part.partIndex > 0;
  const remaining = isCurrent ? Math.max(0, part.endMin - planNowMin) : 0;
  const conflictText = [];
  if (entry.pinned) {
    if (entry.flags.past) conflictText.push('已过去');
    else if (entry.flags.outside) conflictText.push('不在工作时段');
    if (entry.flags.lunch) conflictText.push('撞午休');
    if (entry.flags.overrun) conflictText.push('超出下班');
    if (entry.flags.overlap) conflictText.push('与固定任务重叠');
  }

  return h(
    'div',
    {
      className: cx(
        'tb-task',
        active ? 'is-active' : '',
        entry.pinned ? 'is-pinned' : '',
        pinConflict || overdue ? 'is-conflict' : '',
        isCurrent ? 'is-now' : '',
        isCont ? 'is-continuation' : '',
        dragId === task.id ? 'is-dragging' : '',
      ),
      draggable: !entry.pinned,
      'data-task-id': task.id,
      onClick: () => onOpen(task.id),
      onDragStart: (event) => {
        if (entry.pinned) return;
        event.dataTransfer.effectAllowed = 'move';
        try {
          event.dataTransfer.setData('text/plain', task.id);
        } catch {
          /* ignore */
        }
        onDragStart(task.id);
      },
      onDragEnd: onDragEnd,
      onDragOver: (event) => {
        if (!entry.pinned) {
          event.preventDefault();
          onDragOver(task.id);
        }
      },
      onDrop: (event) => {
        event.preventDefault();
        onDrop(task.id);
      },
    },
    h(
      'button',
      {
        type: 'button',
        className: cx('tb-check', task.done ? 'is-on' : ''),
        'aria-label': task.done ? '标记未完成' : '标记完成',
        title: task.done ? '标记未完成' : '完成',
        onClick: (event) => {
          event.stopPropagation();
          onToggle(task.id);
        },
      },
      task.done ? h(IconCheck, { size: 12 }) : null,
    ),
    h(
      'div',
      { className: 'tb-task-main' },
      h(
        'div',
        { className: 'tb-task-line1' },
        h(PriorityBadge, { priority: task.priority }),
        entry.pinned ? h('span', { className: 'tb-pin-mark', title: '已固定开始' }, h(IconPin, { size: 13 })) : null,
        h('span', { className: 'tb-task-title', title: task.title }, task.title),
        isCont ? h('span', { className: 'tb-badge is-muted' }, '续') : null,
        entry.split && !isCont ? h('span', { className: 'tb-badge is-blue' }, '分 ' + entry.parts.length + ' 段') : null,
        h('span', { className: 'tb-task-dur' }, isCont ? formatDuration(part.endMin - part.startMin) : formatDuration(entry.durationMin)),
      ),
      h(
        'div',
        { className: 'tb-task-meta' },
        task.dueAt ? h('span', { title: '截止时间' }, '截止 ' + dueText(task, today)) : h('span', null, '未设截止'),
        task.carried && !task.done ? h('span', { className: 'tb-badge is-muted' }, '顺延') : null,
        overdue ? h('span', { className: 'tb-badge is-red' }, '已过期') : null,
        late ? h('span', { className: 'tb-badge is-warn' }, '将晚 ' + formatDuration(entry.flags.due)) : null,
        entry.overPlan ? h('span', { className: 'tb-badge is-warn', title: '计划结束时间已过，还没打勾' }, '超计划 ' + formatDuration(entry.overrunMin)) : null,
        pinConflict ? h('span', { className: 'tb-badge is-red' }, conflictText.join(' · ') || '固定冲突') : null,
        isCurrent
          ? h('span', { className: 'tb-badge is-live' }, h('span', { className: 'tb-live-dot' }), '进行中 · 剩 ' + formatDuration(remaining))
          : null,
      ),
    ),
    h('div', { className: cx('tb-task-time', pinConflict || overdue ? 'is-over' : '') }, formatClock(part.startMin) + '–' + formatClock(part.endMin)),
  );
}

/* --------------------------------------------------------------- 时间轴 */

function Timeline(props) {
  const { plan, today, isToday = true, editingId, onOpen, onToggle, dragId, onDragStart, onDragEnd, onDragOver, onDrop, renderEditor } = props;
  const nowMin = plan.nowMin;
  const dayLabel = isToday ? '今天' : dateLabel(today, todayKeyOf());

  const workStart = plan.segments.length > 0 ? plan.segments[0].start : null;
  const workEnd = plan.segments.length > 0 ? plan.segments[plan.segments.length - 1].end : null;
  const rangeStart = workStart !== null ? workStart : toMinutes(plan.settings.workStart) ?? 0;
  const rangeEnd = workEnd !== null ? workEnd : toMinutes(plan.settings.workEnd) ?? 0;

  const blocks = useMemo(() => {
    const list = [];
    const bySegment = plan.segments.map(() => []);
    const outside = [];

    for (const block of plan.blocks) {
      const { entry, part } = block;
      if (entry.flags.outside || part.segmentIndex < 0 || !bySegment[part.segmentIndex]) {
        outside.push(block);
      } else {
        bySegment[part.segmentIndex].push(block);
      }
    }

    if (outside.length > 0) {
      list.push({ kind: 'outside-head', key: 'outside-head', allPast: outside.every((item) => item.entry.flags.past) });
      outside.sort((a, b) => a.part.startMin - b.part.startMin);
      for (const block of outside) list.push({ kind: 'part', entry: block.entry, part: block.part, key: block.entry.task.id + ':' + block.part.partIndex });
    }

    plan.segments.forEach((segment, index) => {
      list.push({
        kind: 'segment',
        key: 'seg-' + index,
        label: plan.anchorMin !== null
          ? index === 0 ? '现在之后' : '下午'
          : index === 0 ? '上午' : plan.segments.length === 2 ? '下午' : '第 ' + (index + 1) + ' 段',
        segment,
      });
      let cursor = segment.start;
      const items = bySegment[index].filter((block) => !block.entry.flags.outside).sort((a, b) => a.part.startMin - b.part.startMin);
      for (const block of items) {
        if (block.part.endMin <= cursor) continue;
        if (block.part.startMin > cursor) {
          list.push({ kind: 'gap', key: 'gap-' + index + '-' + cursor, start: cursor, end: block.part.startMin });
        }
        list.push({ kind: 'part', entry: block.entry, part: block.part, key: block.entry.task.id + ':' + block.part.partIndex });
        cursor = Math.max(cursor, block.part.endMin);
      }
      if (cursor < segment.end) list.push({ kind: 'gap', key: 'gap-end-' + index, start: cursor, end: segment.end });
      if (index === 0 && plan.lunch) list.push({ kind: 'lunch', key: 'lunch', lunch: plan.lunch });
    });

    // 把「现在」插到时间轴的真实位置：进行中的任务前、空闲/午休里、或末尾。
    if (!isToday) return list;
    let nowIndex = -1;
    for (let i = 0; i < list.length; i += 1) {
      const block = list[i];
      if (block.kind === 'part' && !block.entry.flags.outside && nowMin >= block.part.startMin && nowMin < block.part.endMin) {
        nowIndex = i;
        break;
      }
      if (block.kind === 'gap' && nowMin >= block.start && nowMin < block.end) {
        nowIndex = i;
        break;
      }
      if (block.kind === 'lunch' && nowMin >= block.lunch.start && nowMin < block.lunch.end) {
        nowIndex = i;
        break;
      }
    }
    if (nowIndex < 0 && workStart !== null && nowMin >= workStart && nowMin < workEnd) {
      for (let i = 0; i < list.length; i += 1) {
        const block = list[i];
        const start =
          block.kind === 'part'
            ? block.entry.flags.outside
              ? null
              : block.part.startMin
            : block.kind === 'gap'
              ? block.start
              : block.kind === 'lunch'
                ? block.lunch.start
                : null;
        if (start !== null && start > nowMin) {
          nowIndex = i;
          break;
        }
      }
      if (nowIndex < 0) nowIndex = list.length;
    }
    if (nowIndex >= 0) list.splice(nowIndex, 0, { kind: 'now', key: 'now' });
    return list;
  }, [plan, nowMin, workStart, workEnd, isToday]);

  if (plan.stats.pendingCount === 0) {
    const empty = plan.stats.taskCount === 0;
    return h(
      'div',
      { className: 'tb-timeline' },
      h(
        'div',
        { className: 'tb-timeline-head' },
        h('span', { className: 'tb-timeline-title' }, dayLabel + '的时间轴'),
        h('span', { className: 'tb-timeline-sub' }, '可用 ' + formatDuration(plan.stats.availableMin)),
        isToday
          ? h('span', { className: 'tb-now-pill' }, h('span', { className: 'tb-live-dot' }), '现在 ' + formatClock(nowMin))
          : h('span', { className: 'tb-now-pill' }, '全天计划'),
      ),
      h(
        'div',
        { className: 'tb-empty' },
        h('div', { className: 'tb-empty-mark' }, h(empty ? IconTaskboard : IconCheck, { size: 22 })),
        h('div', { className: 'tb-empty-title' }, isToday ? (empty ? '今天还没记事情' : '今天的事情都完成了') : empty ? '这一天还没记事情' : '这一天的事情都完成了'),
        h(
          'div',
          { className: 'tb-empty-sub' },
          empty
            ? (isToday
                ? '在左边输入框记下第一件事，回车就会按优先级与截止时间自动排进上班时间。'
                : '在这一天记下第一件事，它会独立排进这一天的上班时间。')
            : '所有任务都打勾了。今天下班结束归档后，未完成的才会顺延到次日。',
        ),
      ),
    );
  }

  let nowState = '空闲';
  if (plan.current) nowState = '进行中 · ' + plan.current.task.title;
  else if (plan.lunch && nowMin >= plan.lunch.start && nowMin < plan.lunch.end) nowState = '午休';
  else if (workStart !== null && nowMin < workStart) nowState = '未上班';
  else if (workEnd !== null && nowMin >= workEnd) nowState = '已下班';

  return h(
    'div',
    { className: 'tb-timeline' },
    h(
      'div',
      { className: 'tb-timeline-head' },
      h('span', { className: 'tb-timeline-title' }, dayLabel + '的时间轴'),
      h(
        'span',
        { className: 'tb-timeline-sub' },
        formatClock(rangeStart) + '–' + formatClock(rangeEnd) + ' · 可用 ' + formatDuration(plan.stats.availableMin),
      ),
      isToday
        ? h(
            'span',
            { className: cx('tb-now-pill', plan.current ? 'is-live' : ''), title: nowState },
            h('span', { className: 'tb-live-dot' }),
            '现在 ' + formatClock(nowMin) + ' · ' + nowState,
          )
        : h('span', { className: 'tb-now-pill' }, '全天计划'),
      h('div', { className: 'tb-timeline-legend' }, h('span', { className: 'tb-legend-item' }, h('span', { className: 'tb-legend-dot is-pin' }), '固定')),
    ),
    h(
      'div',
      { className: 'tb-timeline-scroll' },
      blocks.map((block) => {
        if (block.kind === 'outside-head') {
          const allPast = block.allPast === true;
          return h('div', { key: block.key, className: 'tb-seg-head' },
            h('b', null, allPast ? '固定 · 已过去' : '固定 · 不在当前范围'),
            h('span', { className: 'tb-seg-line' }),
            h('span', null, allPast ? '保留位置，只作记录' : '位置不动，只提示'));
        }
        if (block.kind === 'segment') {
          return h('div', { key: block.key, className: 'tb-seg-head' },
            h('b', null, block.label),
            h('span', { className: 'tb-seg-line' }),
            h('span', { className: 'tb-seg-time' }, formatClock(block.segment.start) + '–' + formatClock(block.segment.end)));
        }
        if (block.kind === 'lunch') {
          return h('div', { key: block.key, className: 'tb-lunch' },
            h('span', { className: 'tb-lunch-tag' }, '午休 ' + formatClock(block.lunch.start) + '–' + formatClock(block.lunch.end)),
            h('span', { className: 'tb-gap-line' }));
        }
        if (block.kind === 'now') {
          return h('div', { key: block.key, className: 'tb-now-row' },
            h('span', null, '现在 ' + formatClock(nowMin)),
            h('span', { className: 'tb-now-line' }));
        }
        if (block.kind === 'gap') {
          return h('div', { key: block.key, className: 'tb-gap' },
            h('span', null, '空闲 ' + formatDuration(block.end - block.start)),
            h('span', { className: 'tb-gap-line' }));
        }
        const { entry, part } = block;
        return h(
          React.Fragment,
          { key: block.key },
          h(TaskRow, {
            entry,
            part,
            today,
            active: editingId === entry.task.id,
            onOpen,
            onToggle,
            dragId,
            onDragStart,
            onDragEnd,
            onDragOver,
            onDrop,
            planNowMin: nowMin,
          }),
          editingId === entry.task.id && part.partIndex === 0 ? renderEditor(entry.task) : null,
        );
      }),
    ),
  );
}

function UnscheduledSection(props) {
  const { plan, editingId, onOpen, onToggle, onCarry, onDelete, renderEditor } = props;
  const [open, setOpen] = useState(true);
  const tasks = plan.unplaced;
  const total = plan.stats.unplacedMin;

  return h(
    'div',
    { className: 'tb-section' },
    h(
      'button',
      { type: 'button', className: 'tb-section-head', onClick: () => setOpen(!open), 'aria-expanded': open },
      h(IconChevron, { size: 13, direction: open ? 'up' : 'down' }),
      h('span', { className: 'tb-section-title' }, '没排上'),
      h('span', { className: 'tb-section-count' }, tasks.length + ' 件 · ' + formatDuration(total)),
      h('span', { className: 'tb-section-spacer' }),
      tasks.length > 0 ? h('span', { className: 'tb-badge is-red' }, '需顺延或删减') : null,
    ),
    open
      ? h(
          'div',
          { className: 'tb-section-body' },
          tasks.length === 0
            ? h('div', { className: 'tb-section-empty' }, '都排上了，没有遗留。')
            : tasks.map((task) =>
                h(
                  React.Fragment,
                  { key: task.id },
                  h(
                    'div',
                    { className: 'tb-mini-row', onClick: () => onOpen(task.id) },
                    h('button', {
                      type: 'button',
                      className: 'tb-mini-check',
                      title: '完成',
                      'aria-label': '完成任务',
                      onClick: (event) => {
                        event.stopPropagation();
                        onToggle(task.id);
                      },
                    }),
                    h('span', { className: 'tb-prio', 'data-p': Math.max(0, Math.min(3, Number(task.priority) || 0)) }, PRIORITY_LABELS[Math.max(0, Math.min(3, Number(task.priority) || 0))]),
                    h('span', { className: 'tb-mini-title', title: task.title }, task.title),
                    h('span', { className: 'tb-mini-dur' }, formatDuration(task.estimateMin)),
                    h(
                      'span',
                      { className: 'tb-mini-actions', style: { opacity: 1 }, onClick: (event) => event.stopPropagation() },
                      h('button', { type: 'button', className: 'tb-tinybtn', title: '顺延到明天', 'aria-label': '顺延到明天', onClick: () => onCarry(task) }, h(IconTomorrow, { size: 14 })),
                      h('button', { type: 'button', className: 'tb-tinybtn is-danger', title: '删除', 'aria-label': '删除', onClick: () => onDelete(task) }, h(IconTrash, { size: 14 })),
                    ),
                  ),
                  editingId === task.id ? renderEditor(task) : null,
                ),
              ),
        )
      : null,
  );
}

function CompletedSection(props) {
  const { tasks, onToggle } = props;
  const [open, setOpen] = useState(false);
  const sorted = useMemo(
    () => tasks.slice().sort((a, b) => (parseLocalDateTime(b.doneAt)?.getTime() ?? 0) - (parseLocalDateTime(a.doneAt)?.getTime() ?? 0)),
    [tasks],
  );
  if (tasks.length === 0) return null;

  return h(
    'div',
    { className: 'tb-section' },
    h(
      'button',
      { type: 'button', className: 'tb-section-head', onClick: () => setOpen(!open), 'aria-expanded': open },
      h(IconChevron, { size: 13, direction: open ? 'up' : 'down' }),
      h('span', { className: 'tb-section-title' }, '已完成'),
      h('span', { className: 'tb-section-count' }, tasks.length + ' 件'),
      h('span', { className: 'tb-section-spacer' }),
      h('span', { className: 'tb-section-count' }, '点击勾选可撤销'),
    ),
    open
      ? h(
          'div',
          { className: 'tb-section-body' },
          sorted.map((task) => {
            const doneAt = parseLocalDateTime(task.doneAt);
            const actual = task.actualMin;
            const hasActual = actual !== null && actual !== undefined;
            const diff = hasActual ? actual - task.estimateMin : null;
            const color = diff !== null ? (diff < 0 ? 'var(--tb-ok)' : diff > 0 ? 'var(--tb-warn)' : undefined) : undefined;
            return h(
              'div',
              { key: task.id, className: 'tb-mini-row' },
              h('button', {
                type: 'button',
                className: 'tb-mini-check',
                style: { background: 'var(--tb-accent)', borderColor: 'var(--tb-accent)', color: '#fff' },
                title: '撤销完成',
                'aria-label': '撤销完成',
                onClick: () => onToggle(task.id),
              }, h(IconCheck, { size: 10 })),
              h('span', { className: 'tb-mini-title', style: { textDecoration: 'line-through', color: 'var(--tb-text3)' }, title: task.title }, task.title),
              h('span', { className: 'tb-mini-dur' }, doneAt ? fromMinutes(doneAt.getHours() * 60 + doneAt.getMinutes()) : ''),
              h(
                'span',
                { className: 'tb-mini-dur', style: { color }, title: '实际 ' + (hasActual ? formatDuration(actual) : '未填') + ' / 预计 ' + formatDuration(task.estimateMin) },
                hasActual ? '实 ' + formatDuration(actual) : '计 ' + formatDuration(task.estimateMin),
              ),
              diff !== null && diff !== 0
                ? h('span', { className: 'tb-mini-dur', style: { color } }, diff < 0 ? '提前 ' + formatDuration(-diff) : '超 ' + formatDuration(diff))
                : null,
            );
          }),
        )
      : null,
  );
}

/* ------------------------------------------------------------------ 页脚 */

function StatsFooter(props) {
  const { plan, isToday = true } = props;
  const stats = plan.stats;
  if (stats.taskCount === 0) {
    return h(
      'div',
      { className: 'tb-foot' },
      h('span', { className: 'tb-stat' }, (isToday ? '今天可用 ' : '全天可用 '), h('b', null, formatDuration(stats.availableMin))),
      h('span', { className: 'tb-foot-hint' }, '记下第一件事，回车就会自动排进上班时间'),
    );
  }
  const overload = stats.surplusMin < 0;
  const ratio = stats.availableMin > 0 ? Math.min(1, stats.scheduledMin / stats.availableMin) : 0;
  return h(
    'div',
    { className: 'tb-foot' },
    h('span', { className: 'tb-stat' }, '已排 ', h('b', null, stats.scheduledCount + '/' + stats.pendingCount)),
    h('span', { className: 'tb-stat' }, '需 ', h('b', null, formatDuration(stats.needMin))),
    h('span', { className: 'tb-stat' }, '可用 ', h('b', null, formatDuration(stats.availableMin))),
    h('span', { className: cx('tb-stat', overload ? 'is-over' : '') }, overload ? '超载 ' : '富余 ', h('b', null, formatDuration(Math.abs(stats.surplusMin)))),
    h('div', { className: cx('tb-progress', overload ? 'is-over' : ''), title: '已排时长 / 可用时长' }, h('span', { style: { width: Math.round(ratio * 100) + '%' } })),
    h('span', { className: 'tb-foot-hint' }, stats.unplacedCount > 0 ? stats.unplacedCount + ' 件没排上' : '自动排程 · 数据本地保存'),
  );
}

/* ------------------------------------------------------------------ 面板 */

function TaskboardPage() {
  const snap = useBoard();
  const now = useNowTick(15000);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [dockEnabled, setDockEnabled] = useState(() => readDockPrefs().enabled);
  const [selectedDate, setSelectedDate] = useState(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [virtualOpen, setVirtualOpen] = useState(false);

  const state = snap.state;
  const today = snap.today || todayKeyOf();
  const viewDate = selectedDate || today;
  const isToday = viewDate === today;
  const anchorMinute = useAnchorMinute(today);
  const planNow = useMemo(() => (isToday ? now : new Date(viewDate + 'T00:00')), [isToday, now, viewDate]);
  const plan = useMemo(
    () =>
      state
        ? schedule(state.tasks, state.settings, viewDate, {
            now: planNow,
            anchorMin: isToday ? anchorMinute ?? undefined : undefined,
          })
        : null,
    [state, viewDate, planNow, isToday, anchorMinute],
  );

  useEffect(() => {
    setSelectedDate((previous) => (!previous || previous < today ? today : previous));
  }, [today]);

  useEffect(() => {
    const onDockPrefs = () => setDockEnabled(readDockPrefs().enabled);
    window.addEventListener('dsh-taskboard:dock', onDockPrefs);
    return () => window.removeEventListener('dsh-taskboard:dock', onDockPrefs);
  }, []);

  useEffect(() => {
    if (!snap.error) return;
    showToast(snap.error, 'error');
  }, [snap.error]);

  const toggleDock = useCallback(() => {
    const prefs = setDockVisibility(!readDockPrefs().enabled);
    setDockEnabled(prefs.enabled);
    showToast(prefs.enabled ? '悬浮小窗已打开' : '悬浮小窗已关闭，可从同一按钮重新打开');
  }, []);

  const goBack = useCallback(() => {
    if (!returnToConversation()) showToast('没有可返回的对话', 'error');
  }, []);

  const reflowNow = useCallback(() => {
    const minute = minuteOfDay(new Date());
    writeAnchorMinute(today, minute);
    showToast('已从现在 ' + formatClock(minute) + ' 开始重排，前面的时段不再参与');
  }, [today]);

  const resetAnchor = useCallback(() => {
    clearAnchorMinute(today);
    showToast('已恢复全天计划');
  }, [today]);

  const openEditor = useCallback((id) => {
    setEditingId((current) => (current === id ? null : id));
  }, []);

  const toggleTask = useCallback((id) => {
    setEditingId(null);
    const task = state ? state.tasks.find((item) => item.id === id) : null;
    const entry = plan ? plan.placed.find((item) => item.task.id === id) : null;
    let actualMin;
    // 今天：按「计划开始 → 现在」估实际；未来日期：默认按预计耗时记。
    if (task && !task.done && (task.actualMin === null || task.actualMin === undefined)) {
      if (!isToday) {
        actualMin = task.estimateMin;
      } else if (entry) {
        const worked = workedMinutes(entry, minuteOfDay(now));
        actualMin = worked > 0 ? Math.max(1, Math.min(entry.durationMin, worked)) : task.estimateMin;
      } else {
        actualMin = task.estimateMin;
      }
    }
    runAction('toggleTask', { id, actualMin });
  }, [state, plan, now, isToday]);

  const carryTask = useCallback((task) => {
    setEditingId(null);
    runAction('carryToTomorrow', { id: task.id }).then((result) => {
      if (result) showToast('「' + task.title + '」已顺延到下一天');
    });
  }, []);

  const requestDelete = useCallback((task) => {
    setConfirm({
      title: '删除任务',
      message: '确定删除「' + task.title + '」？删除后不会进入历史。',
      confirmText: '删除',
      onConfirm: () => {
        setEditingId(null);
        runAction('deleteTask', { id: task.id }).then((result) => {
          if (result) showToast('已删除');
        });
      },
    });
  }, []);

  const onDrop = useCallback(
    (targetId) => {
      const source = dragId;
      setDragId(null);
      setDragOverId(null);
      if (!source || !targetId || source === targetId || !plan) return;
      const ids = plan.placed
        .map((item) => item.task.id)
        .concat(plan.unplaced.map((task) => task.id))
        .filter((id) => id !== source);
      const at = ids.indexOf(targetId);
      if (at < 0) return;
      ids.splice(at, 0, source);
      runAction('reorder', { ids });
    },
    [dragId, plan],
  );

  const renderEditor = useCallback(
    (task) => h(TaskEditor, {
      key: task.id,
      task,
      settings: state ? state.settings : undefined,
      today: viewDate,
      onClose: () => setEditingId(null),
      onRequestDelete: requestDelete,
    }),
    [requestDelete, state, viewDate],
  );

  if (!state) {
    return h(
      'div',
      { className: 'tb-root tb-page' },
      h('div', { className: 'tb-page-head' },
        h('button', { type: 'button', className: 'tb-back', title: '返回刚才的对话（不改变当前会话）', onClick: goBack },
          h(IconBack, { size: 15 }),
          h('span', { className: 'tb-back-label' }, '返回对话')),
        h('div', { className: 'tb-brand' },
          h('div', { className: 'tb-brand-mark' }, h(IconTaskboard, { size: 18 })),
          h('div', null,
            h('div', { className: 'tb-brand-title' }, '任务排程'),
            h('div', { className: 'tb-brand-sub' }, '把今天要做的事排进上班时间')))),
      snap.status === 'error'
        ? h(
            'div',
            { className: 'tb-loading' },
            h('div', { className: 'tb-error' },
              h('div', { style: { flex: 1 } },
                h('div', { style: { color: 'var(--tb-text)', marginBottom: 4 } }, '宿主半侧还没有响应'),
                h('div', null, '确认 dsh-taskboard 插件已启用，然后重试。'),
                h('code', null, snap.error || '')),
              h(PrimaryButton, { onClick: () => boardStore.refresh() }, '重试')),
          )
        : h('div', { className: 'tb-loading' },
            h('div', { className: 'tb-skel' }),
            h('div', { className: 'tb-skel', style: { width: '82%' } }),
            h('div', { className: 'tb-skel', style: { width: '64%' } })),
    );
  }

  const doneTasks = (state.tasks || []).filter((task) => task.done && task.date === viewDate);
  const pending = plan.stats.pendingCount;
  const overload = plan.stats.surplusMin < 0;

  return h(
    'div',
    { className: 'tb-root tb-page' },
    h(
      'div',
      { className: 'tb-page-head' },
      h('button', { type: 'button', className: 'tb-back', title: '返回刚才的对话（不改变当前会话）', onClick: goBack },
        h(IconBack, { size: 15 }),
        h('span', { className: 'tb-back-label' }, '返回对话')),
      h(
        'div',
        { className: 'tb-brand' },
        h('div', { className: 'tb-brand-mark' }, h(IconTaskboard, { size: 18 })),
        h(
          'div',
          null,
          h('div', { className: 'tb-brand-title' }, '任务排程'),
          h('div', { className: 'tb-brand-sub' }, dateLabel(viewDate, today) + ' ' + weekdayLabel(viewDate)),
        ),
      ),
      h(
        'div',
        { className: 'tb-head-mid' },
        plan.stats.taskCount === 0
          ? h('span', { className: 'tb-pill is-ok' }, h('span', { className: 'tb-dot' }), (isToday ? '今天可用 ' : '全天可用 ') + formatDuration(plan.stats.availableMin))
          : [
              h('span', { key: 'count', className: 'tb-pill' }, pending + ' 件待办 · 需 ' + formatDuration(plan.stats.needMin)),
              overload
                ? h('span', { key: 'load', className: 'tb-pill is-danger' }, h('span', { className: 'tb-dot' }), '超载 ' + formatDuration(Math.abs(plan.stats.surplusMin)))
                : h('span', { key: 'load', className: 'tb-pill is-ok' }, h('span', { className: 'tb-dot' }), '富余 ' + formatDuration(plan.stats.surplusMin)),
              plan.stats.overdueCount > 0 ? h('span', { key: 'overdue', className: 'tb-pill is-danger' }, '已过期 ' + plan.stats.overdueCount) : null,
              plan.stats.lateCount > 0 ? h('span', { key: 'late', className: 'tb-pill is-warn' }, '将晚于截止 ' + plan.stats.lateCount) : null,
              plan.stats.overrunCount > 0 ? h('span', { key: 'overrun', className: 'tb-pill is-warn' }, '超计划 ' + plan.stats.overrunCount) : null,
            ],
        snap.pending > 0 ? h('span', { className: 'tb-pill' }, '保存中…') : null,
      ),
      h(
        'div',
        { className: 'tb-head-right' },
        h(
          'button',
          {
            type: 'button',
            className: 'tb-btn',
            title: '打开虚拟时间轴：自由排一份草稿，再覆盖到选中的日期',
            onClick: () => setVirtualOpen(true),
          },
          h(IconLayers, { size: 15 }),
          h('span', { className: 'tb-virtual-label' }, '虚拟'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: cx('tb-btn', 'tb-calendar', !isToday ? 'is-on' : ''),
            title: '选择今天和未来 7 天；每天独立排程',
            onClick: () => setCalendarOpen(true),
          },
          h(IconCalendar, { size: 15 }),
          h('span', { className: 'tb-calendar-label' }, isToday ? '未来 7 天' : dateLabel(viewDate, today)),
        ),
        isToday
          ? h(
              'button',
              {
                type: 'button',
                className: cx('tb-btn', 'tb-reflow', anchorMinute !== null ? 'is-on' : ''),
                title: '把还没做的任务从当前时间重新排一遍；已打勾的任务不受影响',
                onClick: reflowNow,
              },
              h(IconRefresh, { size: 15 }),
              h('span', { className: 'tb-reflow-label' }, '从现在重排'),
            )
          : null,
        isToday && anchorMinute !== null
          ? h('button', {
              type: 'button',
              className: 'tb-linkbtn tb-restore',
              title: '恢复从上班时间开始的完整计划',
              onClick: resetAnchor,
            }, '恢复全天')
          : null,
        !dockEnabled
          ? h(
              'button',
              {
                type: 'button',
                className: 'tb-btn',
                title: '打开贴边悬浮小窗',
                onClick: toggleDock,
              },
              h(IconPanel, { size: 15 }),
              h('span', { className: 'tb-dock-toggle-label' }, '打开悬浮窗'),
            )
          : null,
        h(IconButton, { label: '历史记录', onClick: () => setHistoryOpen(true) }, h(IconHistory, { size: 17 })),
        h(IconButton, { label: '设置', onClick: () => setSettingsOpen(true) }, h(IconSettings, { size: 17 })),
      ),
    ),

    h(
      'div',
      { className: 'tb-page-body' },
      h(
        'div',
        { className: 'tb-side' },
        h(QuickAdd, { settings: state.settings, today: viewDate }),
        plan.stats.taskCount > 0 && plan.stats.unplacedCount > 0
          ? h(UnscheduledSection, {
              plan,
              editingId,
              onOpen: openEditor,
              onToggle: toggleTask,
              onCarry: carryTask,
              onDelete: requestDelete,
              renderEditor,
            })
          : null,
        plan.stats.taskCount > 0
          ? h('div', { className: cx('tb-note', plan.stats.unplacedCount > 0 ? 'is-warn' : ''), style: { margin: 0 } },
              h('div', { style: { flex: 1 } },
                h('div', { style: { color: 'var(--tb-text)' } }, plan.stats.unplacedCount > 0 ? '有 ' + plan.stats.unplacedCount + ' 件没排上' : '排程已完成'),
                h('div', null,
                  plan.stats.unplacedCount > 0
                    ? '可用 ' + formatDuration(plan.stats.availableMin) + '，任务共需 ' + formatDuration(plan.stats.needMin) + '。它们不会被自动删除或降级——顺延或删减由你决定。'
                    : '需要 ' + formatDuration(plan.stats.needMin) + '，可用 ' + formatDuration(plan.stats.availableMin) + '；剩下的 ' + formatDuration(Math.max(0, plan.stats.surplusMin)) + ' 会留空，不会被强行填满。')))
          : null,
        h(CompletedSection, { tasks: doneTasks, onToggle: toggleTask }),
      ),
      h(
        'div',
        { className: 'tb-main' },
        h(Timeline, {
          plan,
          today: viewDate,
          isToday,
          editingId,
          onOpen: openEditor,
          onToggle: toggleTask,
          dragId: dragOverId || dragId,
          onDragStart: setDragId,
          onDragEnd: () => {
            setDragId(null);
            setDragOverId(null);
          },
          onDragOver: setDragOverId,
          onDrop,
          renderEditor,
        }),
      ),
    ),

    h(StatsFooter, { plan, isToday }),

    settingsOpen ? h(SettingsDialog, { state, dataFile: snap.dataFile, onClose: () => setSettingsOpen(false) }) : null,
    historyOpen ? h(HistoryDialog, { state, onClose: () => setHistoryOpen(false) }) : null,
    calendarOpen
      ? h(CalendarDialog, {
          today,
          selected: viewDate,
          tasks: state.tasks || [],
          settings: state.settings,
          onSelect: (date) => {
            setSelectedDate(date);
            setCalendarOpen(false);
          },
          onClose: () => setCalendarOpen(false),
        })
      : null,
    virtualOpen
      ? h(VirtualDialog, {
          state,
          targetDate: viewDate,
          onClose: () => setVirtualOpen(false),
        })
      : null,
    confirm ? h(ConfirmDialog, { title: confirm.title, message: confirm.message, confirmText: confirm.confirmText, onConfirm: confirm.onConfirm, onClose: () => setConfirm(null) }) : null,
  );
}


/* ---- 30-dock.js ---- */
/* ==========================================================================
 * dsh-taskboard · 浏览器半侧：贴边悬浮小窗（shell.overlay）
 *
 * 形态对齐旧版桌面小窗：
 *   - 展开时是可拖动的便签卡片，松手吸附到左/右边缘；
 *   - 收起时只剩一条竖排细条，鼠标移过去自动滑出；
 *   - 内容与完整面板共用同一份数据，勾选/添加立即可见。
 * ========================================================================== */

function DockMiniItem(props) {
  const { item, next, onToggle, onOpen } = props;
  const task = item.task;
  const overdue = item.flags.overdue;
  return h(
    'div',
    {
      className: cx('tb-mini-item', next && !item.current ? 'is-next' : '', item.current ? 'is-now' : ''),
      'data-prio': task.priority,
      onClick: onOpen,
      title: task.title,
    },
    h('button', {
      type: 'button',
      className: cx('tb-check', task.done ? 'is-on' : ''),
      style: { width: 15, height: 15, borderRadius: 5, marginTop: 1 },
      'aria-label': '完成任务',
      onClick: (event) => {
        event.stopPropagation();
        onToggle(task.id);
      },
    }, task.done ? h(IconCheck, { size: 9 }) : null),
    h(
      'div',
      { className: 'tb-mini-item-main' },
      h('div', { className: 'tb-mini-item-title' }, task.title),
      h(
        'div',
        { className: 'tb-mini-item-meta' },
        h('span', null, PRIORITY_LABELS[task.priority] || 'P2'),
        h('span', null, formatDuration(item.durationMin)),
        h('span', null, entryTimeLabel(item)),
        item.current ? h('span', { className: 'tb-badge is-live' }, h('span', { className: 'tb-live-dot' }), '进行中') : null,
        overdue ? h('span', { style: { color: 'var(--tb-red)' } }, '已过期') : null,
      ),
    ),
  );
}

/** 当前选中的主面板 id；完整面板打开时把贴边小窗让出来。 */
function useActivePanelId() {
  let info = null;
  try {
    const layout = appContext && typeof appContext.get === 'function' ? appContext.get('layout') : null;
    info = layout && layout.panelInfo ? layout.panelInfo : null;
  } catch {
    info = null;
  }
  const subscribe = useCallback(
    (listener) => (info && typeof info.subscribe === 'function' ? info.subscribe(listener) : () => {}),
    [info],
  );
  const getSnapshot = useCallback(
    () => (info && typeof info.getSnapshot === 'function' ? info.getSnapshot() : null),
    [info],
  );
  const snapshot = useStoreSnapshot(subscribe, getSnapshot);
  return snapshot && snapshot.activePanelId ? snapshot.activePanelId : null;
}

function TaskboardDock() {
  const snap = useBoard();
  const now = useNowTick(15000);
  const activePanelId = useActivePanelId();
  const [prefs, setPrefs] = useState(readDockPrefs);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [layer, setLayer] = useState({ w: 0, h: 0 });
  const [, setTick] = useState(0);
  const [quick, setQuick] = useState('');
  const rootRef = useRef(null);
  const cardRef = useRef(null);
  const enterTimer = useRef(null);
  const leaveTimer = useRef(null);
  const dragRef = useRef(null);

  const updatePrefs = useCallback((patch) => {
    setPrefs((prev) => {
      const next = Object.assign({}, prev, patch);
      writeDockPrefs(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const reload = () => setPrefs(readDockPrefs());
    window.addEventListener('dsh-taskboard:dock', reload);
    return () => window.removeEventListener('dsh-taskboard:dock', reload);
  }, []);

  useEffect(() => {
    const layerEl = rootRef.current && rootRef.current.parentElement;
    if (!layerEl) return undefined;
    const measure = () => setLayer({ w: layerEl.clientWidth, h: layerEl.clientHeight });
    measure();
    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure);
      observer.observe(layerEl);
    }
    window.addEventListener('resize', measure);
    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  // 拖动：按住标题栏移动卡片，松手按中心落在哪边吸附。
  useEffect(() => {
    function onMove(event) {
      const drag = dragRef.current;
      if (!drag) return;
      drag.dx = event.clientX - drag.startX;
      drag.dy = event.clientY - drag.startY;
      drag.moved = drag.moved || Math.abs(drag.dx) + Math.abs(drag.dy) > 4;
      setTick((value) => value + 1);
    }
    function onUp() {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setTick((value) => value + 1);
      if (!drag.moved) return;
      const left = Math.max(4, Math.min(drag.layerW - drag.cardW - 4, drag.startLeft + drag.dx));
      const top = Math.max(4, Math.min(drag.layerH - drag.cardH - 4, drag.startTop + drag.dy));
      const side = left + drag.cardW / 2 < drag.layerW / 2 ? 'left' : 'right';
      updatePrefs({ side, top: Math.round(top) });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [updatePrefs]);

  const today = snap.today || todayKeyOf();
  const anchorMinute = useAnchorMinute(today);

  if (!prefs.enabled) return null;
  if (activePanelId === 'taskboard') return null;

  const state = snap.state;
  const plan = state ? schedule(state.tasks, state.settings, today, { now, anchorMin: anchorMinute ?? undefined }) : null;
  const expanded = prefs.open || hoverOpen;
  const layerW = layer.w || (typeof window !== 'undefined' ? window.innerWidth : 1200);
  const layerH = layer.h || (typeof window !== 'undefined' ? window.innerHeight : 800);
  const cardW = Math.max(280, Math.min(prefs.width || 348, layerW - 24));
  const contentRows = plan ? plan.placed.length + (plan.stats.unplacedCount > 0 ? 1 : 0) : 0;
  const desiredHeight = 264 + Math.min(contentRows, 7) * 36;
  const cardH = Math.max(340, Math.min(500, Math.min(desiredHeight, layerH - 120)));

  // 拖动中的实时位置
  const drag = dragRef.current;
  let left = prefs.side === 'left' ? 10 : layerW - cardW - 10;
  let top = Math.max(8, Math.min(layerH - cardH - 8, prefs.top || 92));
  if (drag && drag.moved) {
    left = Math.max(4, Math.min(layerW - cardW - 4, drag.startLeft + drag.dx));
    top = Math.max(4, Math.min(layerH - cardH - 4, drag.startTop + drag.dy));
  }

  const stripTop = Math.max(16, Math.min(layerH - 176, prefs.top || 92));

  function startDrag(event) {
    if (event.button !== 0) return;
    if (event.target && event.target.closest && event.target.closest('button')) return;
    const card = cardRef.current;
    const layerEl = rootRef.current && rootRef.current.parentElement;
    if (!card || !layerEl) return;
    const cardRect = card.getBoundingClientRect();
    const layerRect = layerEl.getBoundingClientRect();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: cardRect.left - layerRect.left,
      startTop: cardRect.top - layerRect.top,
      cardW: cardRect.width,
      cardH: cardRect.height,
      layerW: layerRect.width,
      layerH: layerRect.height,
      dx: 0,
      dy: 0,
      moved: false,
    };
    event.preventDefault();
    setTick((value) => value + 1);
  }

  function openFullPanel() {
    try {
      const layout = appContext && typeof appContext.get === 'function' ? appContext.get('layout') : null;
      if (layout && typeof layout.selectPanel === 'function') {
        layout.selectPanel('taskboard');
        setHoverOpen(false);
        return;
      }
    } catch {
      /* 降级到提示 */
    }
    showToast('请从左侧栏打开「任务排程」');
  }

  async function addFromDock() {
    const title = quick.trim();
    if (!title) return;
    setQuick('');
    const result = await runAction('addTask', { title, priority: 2 });
    if (!result) setQuick(title);
  }

  function scheduleHoverOpen() {
    if (prefs.open) return;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    if (enterTimer.current) clearTimeout(enterTimer.current);
    enterTimer.current = setTimeout(() => setHoverOpen(true), 170);
  }

  function scheduleHoverClose() {
    if (prefs.open) return;
    if (enterTimer.current) clearTimeout(enterTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      const card = cardRef.current;
      if (card && card.contains(document.activeElement)) return;
      setHoverOpen(false);
    }, 420);
  }

  function cancelHoverClose() {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }

  /* 收起态：一条竖排细条 */
  if (!expanded) {
    const pending = plan ? plan.stats.pendingCount : 0;
    const overdue = plan ? plan.stats.overdueCount : 0;
    const inset = 26;
    const hitStyle =
      prefs.side === 'left'
        ? { left: inset, top: Math.max(8, stripTop - 10), width: 60, height: 176 }
        : { right: inset, top: Math.max(8, stripTop - 10), width: 60, height: 176 };
    const railStyle =
      prefs.side === 'left'
        ? { left: 0, top: stripTop, width: inset, height: 156 }
        : { right: 0, top: stripTop, width: inset, height: 156 };
    return h(
      'div',
      { className: 'tb-root tb-dock', ref: rootRef },
      h('div', {
        className: 'tb-dock-rail',
        'data-side': prefs.side,
        style: railStyle,
        title: '任务排程',
        onPointerEnter: scheduleHoverOpen,
        onPointerLeave: scheduleHoverClose,
        onClick: () => updatePrefs({ open: true }),
      }),
      h(
        'div',
        {
          className: 'tb-dock-strip-hit',
          'data-side': prefs.side,
          style: hitStyle,
          role: 'button',
          tabIndex: 0,
          title: '任务排程：悬停展开，点击固定展开',
          onPointerEnter: scheduleHoverOpen,
          onPointerLeave: scheduleHoverClose,
          onClick: () => updatePrefs({ open: true }),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') updatePrefs({ open: true });
          },
        },
        h(
          'div',
          { className: 'tb-dock-strip', 'data-side': prefs.side },
          '任务排程',
          overdue > 0
            ? h('span', { className: 'tb-strip-badge' }, overdue)
            : pending > 0
              ? h('span', { className: 'tb-strip-badge', style: { background: 'var(--tb-accent)' } }, pending)
              : null,
        ),
      ),
    );
  }

  const placed = plan ? plan.placed : [];
  const nowMin = minuteOfDay(now);
  const nextItem = plan ? plan.current || plan.placed.find((item) => item.endMin > nowMin) || plan.placed[0] || null : null;

  return h(
    'div',
    { className: 'tb-root tb-dock', ref: rootRef },
    h(
      'div',
      {
        ref: cardRef,
        className: 'tb-dock-card',
        'data-dragging': drag && drag.moved ? 'true' : 'false',
        style: {
          left: Math.round(left),
          top: Math.round(top),
          width: Math.round(cardW),
          height: Math.round(cardH),
          transition: drag && drag.moved ? 'none' : 'left .18s ease, top .18s ease',
        },
        onPointerEnter: cancelHoverClose,
        onPointerLeave: scheduleHoverClose,
      },
      h(
        'div',
        {
          className: 'tb-dock-head',
          'data-dragging': drag && drag.moved ? 'true' : 'false',
          onPointerDown: startDrag,
          title: '按住拖动；松手吸附到左/右边缘',
        },
        h('span', { className: 'tb-dock-grip' }, h(Svg, { size: 13 }, h('path', { d: 'M9 6.5h.01M9 12h.01M9 17.5h.01M15 6.5h.01M15 12h.01M15 17.5h.01' }))),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'tb-dock-title' }, '任务排程'),
          h('div', { className: 'tb-dock-sub' }, dateLabel(today, today) + (plan ? ' · ' + plan.stats.pendingCount + ' 件待办' : ''))),
        h(
          'div',
          { className: 'tb-dock-head-actions' },
          h(IconButton, { label: '打开完整面板', onClick: openFullPanel, className: 'tb-iconbtn' }, h(IconPanel, { size: 15 })),
          h(IconButton, {
            label: '收起为细条',
            onClick: () => {
              updatePrefs({ open: false });
              showToast('已收起为细条，点击右侧细条可再展开；要彻底隐藏请到「任务排程」页');
            },
          }, h(IconClose, { size: 15 })),
        ),
      ),
      h(
        'div',
        { className: 'tb-dock-body' },
        h(
          'div',
          { className: 'tb-dock-quick' },
          h('input', {
            value: quick,
            placeholder: '记一件事…',
            'aria-label': '快速添加任务',
            maxLength: 500,
            onChange: (event) => setQuick(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addFromDock();
              } else if (event.key === 'Escape') {
                setQuick('');
              }
            },
          }),
          h('button', { type: 'button', className: 'tb-quick-add', style: { width: 32, height: 32 }, title: '添加', 'aria-label': '添加任务', onClick: addFromDock }, h(IconPlus, { size: 15 })),
        ),
        !state
          ? h('div', { className: 'tb-dock-empty' }, snap.status === 'error' ? '宿主未响应，打开完整面板重试。' : '正在读取本地数据…')
          : placed.length === 0
            ? h('div', { className: 'tb-dock-empty' },
                h('div', null, '今天还没排事情'),
                h('div', { style: { marginTop: 4, opacity: 0.75 } }, '在上面记一件，回车就会自动排好。'))
            : h(
                'div',
                { className: 'tb-dock-list' },
                placed.map((item) =>
                  h(DockMiniItem, {
                    key: item.task.id,
                    item,
                    next: nextItem && nextItem.task.id === item.task.id,
                    onToggle: (id) => runAction('toggleTask', { id }),
                    onOpen: () => {
                      openFullPanel();
                    },
                  }),
                ),
                plan && plan.stats.unplacedCount > 0
                  ? h('div', { className: 'tb-dock-empty', style: { flex: 'none', padding: '8px 6px', color: 'var(--tb-red)' } },
                      plan.stats.unplacedCount + ' 件没排上 · ' + formatDuration(plan.stats.unplacedMin))
                  : null,
              ),
      ),
      h(
        'div',
        { className: 'tb-dock-foot' },
        plan
          ? h(
              'div',
              { className: 'tb-dock-stats' },
              h('span', null, '需 ', h('b', null, formatDuration(plan.stats.needMin))),
              h('span', { className: plan.stats.surplusMin < 0 ? 'is-over' : '' },
                plan.stats.surplusMin < 0 ? '超 ' : '余 ',
                h('b', null, formatDuration(Math.abs(plan.stats.surplusMin)))),
            )
          : null,
        h('span', { style: { marginLeft: plan ? 0 : 'auto' } },
          plan && plan.stats.lateCount > 0 ? plan.stats.lateCount + ' 件将晚' : ''),
      ),
    ),
  );
}


/* ---- 40-reminders.js ---- */
/* ==========================================================================
 * dsh-taskboard · 浏览器半侧：到点提醒
 *
 * 只提醒「今天」的时间轴：
 *   - 任务的第一段开始时 → 「现在开始」
 *   - 下个任务的第一段在 N 分钟内开始 → 「N 分钟后开始」
 * 设置里可关闭，或关掉提示音。提醒去重记录存 localStorage，刷新不重复弹。
 * ========================================================================== */

const REMINDER_STORAGE_KEY = 'dsh-taskboard:reminders:v1';

const reminderLog = {
  date: '',
  keys: new Set(),
  loaded: false,
};

function loadReminderLog(today) {
  if (reminderLog.loaded && reminderLog.date === today) return;
  reminderLog.date = today;
  reminderLog.keys = new Set();
  try {
    const raw = localStorage.getItem(REMINDER_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.date === today && Array.isArray(parsed.keys)) {
      parsed.keys.forEach((key) => reminderLog.keys.add(key));
    }
  } catch {
    /* ignore */
  }
  reminderLog.loaded = true;
}

function saveReminderLog() {
  try {
    localStorage.setItem(
      REMINDER_STORAGE_KEY,
      JSON.stringify({ date: reminderLog.date, keys: Array.from(reminderLog.keys).slice(-200) }),
    );
  } catch {
    /* ignore */
  }
}

function reminderAlreadyShown(key) {
  return reminderLog.keys.has(key);
}

function markReminderShown(key) {
  reminderLog.keys.add(key);
  saveReminderLog();
}

function playReminderBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const audio = new Ctx();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, audio.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.28);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.3);
    setTimeout(() => audio.close().catch(() => {}), 600);
  } catch {
    /* 静音失败不影响提醒 */
  }
}

function ReminderCard(props) {
  const { reminder, pendingCount, onDone, onDismiss } = props;
  return h(
    'div',
    { className: 'tb-reminder', role: 'alertdialog', 'aria-label': reminder.kind === 'start' ? '任务开始提醒' : '下个任务提醒' },
    h(
      'div',
      { className: 'tb-reminder-icon' },
      h(IconBell, { size: 18 }),
    ),
    h(
      'div',
      { className: 'tb-reminder-main' },
      h(
        'div',
        { className: 'tb-reminder-kicker' },
        reminder.kind === 'start' ? '现在开始' : reminder.lead + ' 分钟后开始',
        pendingCount > 1 ? h('span', { className: 'tb-reminder-count' }, '还有 ' + pendingCount + ' 条提醒') : null,
      ),
      h('div', { className: 'tb-reminder-title' }, reminder.title),
      h(
        'div',
        { className: 'tb-reminder-meta' },
        h(PriorityBadge, { priority: reminder.priority }),
        h('span', null, reminder.timeLabel),
        h('span', null, reminder.kind === 'start' ? '到点啦，开始做吧' : '先准备一下，马上就到'),
      ),
    ),
    h(
      'div',
      { className: 'tb-reminder-actions' },
      h('button', { type: 'button', className: 'tb-btn is-primary', onClick: onDone }, '完成'),
      h('button', { type: 'button', className: 'tb-btn', onClick: onDismiss }, '知道了'),
    ),
  );
}

function TaskboardReminders() {
  const snap = useBoard();
  const now = useNowTick(10000);
  const today = snap.today || todayKeyOf();
  const anchorMinute = useAnchorMinute(today);
  const [queue, setQueue] = useState([]);
  const lastMinute = useRef(minuteOfDay(new Date()));
  const state = snap.state;

  const plan = useMemo(
    () =>
      state
        ? schedule(state.tasks, state.settings, today, {
            now,
            anchorMin: anchorMinute ?? undefined,
          })
        : null,
    [state, today, now, anchorMinute],
  );

  useEffect(() => {
    loadReminderLog(today);
    lastMinute.current = minuteOfDay(new Date());
  }, [today]);

  useEffect(() => {
    if (!plan || !state || state.settings.remindersOn === false) return;
    const nowMin = plan.nowMin;
    const previous = lastMinute.current;
    if (nowMin === previous) return;
    // 跨过午夜或时钟回拨时重新对表，不补发旧提醒。
    lastMinute.current = nowMin;
    if (nowMin < previous) return;

    const fresh = [];
    const lead = Number(state.settings.reminderLeadMin) || 5;

    // 1) 现在开始：只针对每个任务的第一段，避免分段续排重复提醒。
    for (const entry of plan.placed) {
      const first = entry.parts[0];
      if (!first || first.startMin <= previous || first.startMin > nowMin) continue;
      const key = 'start:' + today + ':' + entry.task.id + ':' + first.startMin;
      if (reminderAlreadyShown(key)) continue;
      markReminderShown(key);
      fresh.push({
        key,
        kind: 'start',
        taskId: entry.task.id,
        title: entry.task.title,
        priority: entry.task.priority,
        timeLabel: entryTimeLabel(entry),
      });
    }

    // 2) 下个任务提前提醒：只提醒最近的一个，不刷屏。
    const next = plan.placed.find((entry) => entry.parts[0] && entry.parts[0].startMin > nowMin);
    if (next) {
      const start = next.parts[0].startMin;
      if (start - nowMin <= lead) {
        const key = 'lead:' + today + ':' + next.task.id + ':' + start;
        if (!reminderAlreadyShown(key)) {
          markReminderShown(key);
          fresh.push({
            key,
            kind: 'lead',
            lead: start - nowMin,
            taskId: next.task.id,
            title: next.task.title,
            priority: next.task.priority,
            timeLabel: entryTimeLabel(next),
          });
        }
      }
    }

    if (fresh.length > 0) {
      setQueue((current) => [...current, ...fresh]);
      if (state.settings.reminderSound !== false) playReminderBeep();
    }
  }, [plan, state, today]);

  if (!state || state.settings.remindersOn === false || queue.length === 0) return null;
  const reminder = queue[0];

  function dismiss() {
    setQueue((current) => current.slice(1));
  }

  function complete() {
    const latest = boardStore.getSnapshot().state;
    const latestTask = latest ? (latest.tasks || []).find((item) => item.id === reminder.taskId) : null;
    // 提醒卡片可能是几秒前的；任务已被删除/完成时只关闭，不再反转完成状态。
    if (!latestTask || latestTask.done) {
      dismiss();
      return;
    }
    const entry = plan ? plan.placed.find((item) => item.task.id === reminder.taskId) : null;
    const nowMin = plan ? plan.nowMin : minuteOfDay(new Date());
    let actualMin;
    if (entry) {
      const worked = workedMinutes(entry, nowMin);
      actualMin = worked > 0 ? Math.max(1, Math.min(entry.durationMin, worked)) : entry.durationMin;
    }
    dismiss();
    runAction('toggleTask', { id: reminder.taskId, actualMin });
  }

  return h(ReminderCard, {
    reminder,
    pendingCount: queue.length,
    onDone: complete,
    onDismiss: dismiss,
  });
}


/* ---- 99-apply.js ---- */
/* ==========================================================================
 * dsh-taskboard · 浏览器半侧：注册进 DSH 插槽
 *
 * 三个席位：
 *   sidebar.panellist → 左侧栏「任务排程」图标；
 *   main              → 点图标后的完整面板（key 必须与 panellist 的 id 相同）；
 *   shell.overlay     → 贴边悬浮小窗，跨面板常驻。
 * ========================================================================== */

function TaskboardIcon(props) {
  const size = (props && props.size) || 16;
  const active = !!(props && props.active);
  return h(
    'span',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: active ? 'var(--dsw-alias-brand-primary,#5b7cfa)' : 'currentColor',
      },
    },
    h(IconTaskboard, { size }),
  );
}

function apply(ctx) {
  appContext = ctx;
  ensureBoardStyles();

  // 完整面板：侧边栏图标与 main 的 key 必须是同一个 id。
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: 'taskboard', locale: 'common' }, TaskboardPage),
  );

  // 左侧栏入口（order 与「自动化任务」相邻）。
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'taskboard',
        order: 12,
        label: () => '任务排程',
      },
      TaskboardIcon,
    ),
  );

  // 贴边小窗：跨面板常驻，可收起成细条。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'taskboard-dock', order: 80 }, TaskboardDock),
  );

  // 到点提醒：与视图无关，挂在 shell.overlay 上。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'taskboard-reminders', order: 70 }, TaskboardReminders),
  );
}

const moduleExports = { name: 'taskboard', inject: ['slots'], apply };

// 诊断/冒烟测试用：不参与 DSH 插槽，也不被界面引用。
moduleExports.__internals = {
  TaskboardPage,
  TaskboardDock,
  TaskEditor,
  SettingsDialog,
  HistoryDialog,
  CalendarDialog,
  VirtualDialog,
  TaskboardReminders,
  TaskboardIcon,
  QuickAdd,
  Timeline,
  boardStore,
  readDockPrefs,
  setDockVisibility,
  returnToConversation,
};

return moduleExports;

  },
});
