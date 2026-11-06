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

export const DEFAULT_ESTIMATE_MIN = 30;

export const DEFAULT_SETTINGS = Object.freeze({
  workStart: '09:00',
  workEnd: '18:00',
  lunchStart: '12:00',
  lunchEnd: '13:00',
  lunchOn: true,
  autoCarry: true,
  defaultEstimateMin: DEFAULT_ESTIMATE_MIN,
});

export const PRIORITY_LABELS = Object.freeze(['P0', 'P1', 'P2', 'P3']);

/* ---------------------------------------------------------------- 时间工具 */

export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function fromMinutes(value) {
  const v = Math.max(0, Math.min(1440, Math.round(Number(value) || 0)));
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

export function localDateKey(value) {
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
export function parseLocalDateTime(value) {
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
export function normalizeDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = parseLocalDateTime(value);
  if (!d) return null;
  return (
    localDateKey(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  );
}

export function addDays(dateKey, days) {
  const d = parseLocalDateTime(dateKey + 'T00:00');
  if (!d) return dateKey;
  d.setDate(d.getDate() + Number(days || 0));
  return localDateKey(d);
}

/** `90` → `1h30m`；`45` → `45m`；负数原样带符号。 */
export function formatDuration(minutes) {
  const n = Math.round(Number(minutes) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return sign + m + 'm';
  if (m === 0) return sign + h + 'h';
  return sign + h + 'h' + String(m).padStart(2, '0') + 'm';
}

export function formatClock(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '--:--';
  return fromMinutes(n);
}

export function weekdayLabel(dateKey) {
  const d = parseLocalDateTime(dateKey + 'T00:00');
  if (!d) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '';
}

export function dateLabel(dateKey, todayKey) {
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
export function effectiveSettings(settings, dateKey) {
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
export function workWindows(settings, dateKey) {
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

export function estimateOf(task, settings) {
  const raw = Number(task && task.estimateMin);
  if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.round(raw));
  const dflt = Number(settings && settings.defaultEstimateMin);
  return Number.isFinite(dflt) && dflt > 0 ? Math.max(1, Math.round(dflt)) : DEFAULT_ESTIMATE_MIN;
}

export function isOverdue(task, now) {
  const due = parseLocalDateTime(task && task.dueAt);
  if (!due) return false;
  return due.getTime() < (now instanceof Date ? now.getTime() : Number(now) || Date.now());
}

export function priorityOf(task) {
  const p = Math.round(Number(task && task.priority));
  return Number.isFinite(p) ? Math.max(0, Math.min(3, p)) : 2;
}

/** 自动分段时，单个碎片小于这个分钟数就不切开，留给下一件小事。 */
export const MIN_SPLIT_PART_MIN = 10;

/** 一个时间范围内真正落在上班时间里的分钟数（午休不计）。 */
export function workMinutesBetween(settings, dateKey, startMin, endMin) {
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
export function nextWorkMinute(settings, dateKey, atMin) {
  const { segments } = workWindows(settings, dateKey);
  for (const segment of segments) {
    if (atMin < segment.start) return segment.start;
    if (atMin >= segment.start && atMin < segment.end) return atMin;
  }
  return atMin;
}

/** 从 `startMin` 起做 `minutes` 分钟工作后的结束时刻（跨午休顺延，不含午休）。 */
export function addWorkMinutes(settings, dateKey, startMin, minutes) {
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
export function schedule(tasks, settings, dateKey, options = {}) {
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
export function nextUp(plan, nowMinutes) {
  if (!plan || !plan.placed || plan.placed.length === 0) return null;
  const now = Number(nowMinutes);
  const candidates = plan.placed.filter((item) => !Number.isFinite(now) || item.endMin > now);
  return candidates[0] || plan.placed[0] || null;
}

/** 排序后的待办集合：把钉住任务与被排上的任务都算进去，供列表使用。 */
export function orderedPending(plan) {
  if (!plan) return [];
  const pinned = plan.placed.filter((item) => item.pinned).sort((a, b) => a.startMin - b.startMin);
  const auto = plan.placed.filter((item) => !item.pinned);
  const seen = new Set(plan.placed.map((item) => item.task.id));
  const unplaced = plan.unplaced.filter((task) => !seen.has(task.id));
  return [...pinned, ...auto, ...unplaced.map((task) => ({ task, unplaced: true }))];
}
