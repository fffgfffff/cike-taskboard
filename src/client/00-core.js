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
/** 给 DSH 标题栏/窗口按钮留出的安全区，避免小窗吸附到右上角时压住最小化/关闭。 */
const DOCK_SAFE_TOP = 64;
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
      top: Number.isFinite(parsed.top) ? Math.max(DOCK_SAFE_TOP, Math.min(4000, parsed.top)) : fallback.top,
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
    const safe = Object.assign({}, prefs);
    safe.top = Math.max(DOCK_SAFE_TOP, Math.min(4000, Number(safe.top) || 92));
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(safe));
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
