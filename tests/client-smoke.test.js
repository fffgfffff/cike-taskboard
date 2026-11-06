/* 浏览器半侧冒烟测试：不启浏览器，用极小的 React 运行时递归渲染每个组件。
 * 目的不是像素级验证，而是抓 ReferenceError / hooks 顺序 / 空值崩溃这类
 * 一装进 DSH 就会白屏的问题。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { addDays, localDateKey } from '../src/scheduler.js';

const TODAY = localDateKey();

/* ------------------------------------------------------- 迷你 React 运行时 */

const Fragment = Symbol('fragment');
let hookStack = [];
let hookCursor = 0;

function createElement(type, props, ...children) {
  const merged = Object.assign({}, props);
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type, props: merged };
}

function readSlot(init) {
  const index = hookCursor;
  hookCursor += 1;
  if (!(index in hookStack)) hookStack[index] = typeof init === 'function' ? init() : init;
  return hookStack[index];
}

const fakeReact = {
  Fragment,
  createElement,
  useState(init) {
    const value = readSlot(init);
    return [value, () => {}];
  },
  useEffect() {
    hookCursor += 1;
  },
  useMemo(fn) {
    return fn();
  },
  useCallback(fn) {
    return fn;
  },
  useRef(init) {
    const index = hookCursor;
    hookCursor += 1;
    if (!(index in hookStack)) hookStack[index] = { current: init };
    return hookStack[index];
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    try {
      subscribe(() => {});
    } catch {
      /* store.start 里的 fetch 由下面的假 fetch 接住 */
    }
    return getSnapshot();
  },
};

function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(renderNode).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  if (node.type === Fragment) return renderNode(node.props && node.props.children);
  if (typeof node.type === 'function') {
    const savedStack = hookStack;
    const savedCursor = hookCursor;
    hookStack = [];
    hookCursor = 0;
    try {
      return renderNode(node.type(node.props || {}));
    } finally {
      hookStack = savedStack;
      hookCursor = savedCursor;
    }
  }
  return renderNode(node.props && node.props.children);
}

/* ------------------------------------------------------------- 假浏览器环境 */

function makeSandbox(state) {
  const storage = new Map();
  const styleNodes = [];
  const document = {
    visibilityState: 'visible',
    activeElement: null,
    head: { appendChild() {} },
    body: { appendChild() {} },
    getElementById() {
      return null;
    },
    createElement(tag) {
      return { tagName: tag, dataset: {}, style: {}, textContent: '', appendChild() {}, remove() {}, classList: { add() {}, remove() {} } };
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
  };
  const windowObject = {
    innerWidth: 1440,
    innerHeight: 900,
    document,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    __ModuleLoader__: null,
  };
  const responses = { state };
  const sandbox = {
    console,
    window: windowObject,
    document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    fetch: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => responses.state,
      text: async () => JSON.stringify(responses.state),
    }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    queueMicrotask,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    ResizeObserver: undefined,
    navigator: { language: 'zh-CN' },
    module: { exports: {} },
    exports: {},
    require(name) {
      if (name === 'react') return fakeReact;
      throw new Error('unexpected require: ' + name);
    },
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

function sampleState() {
  return {
    ok: true,
    today: TODAY,
    dataFile: 'C:/Users/test/.dsh/dsh-taskboard/state.json',
    state: {
      version: 1,
      settings: {
        workStart: '09:00',
        workEnd: '18:00',
        lunchStart: '12:00',
        lunchEnd: '13:00',
        lunchOn: true,
        autoCarry: true,
        defaultEstimateMin: 30,
        todayOverride: null,
      },
      tasks: [
        {
          id: 't1',
          title: '写周报',
          priority: 0,
          estimateMin: 45,
          dueAt: TODAY + 'T14:00',
          pinnedStart: null,
          date: TODAY,
          done: false,
          carried: false,
          actualMin: null,
          order: 1,
          createdAt: TODAY + 'T08:00',
        },
        {
          id: 't2',
          title: '开长会',
          priority: 1,
          estimateMin: 420,
          dueAt: null,
          pinnedStart: TODAY + 'T10:00',
          date: TODAY,
          done: false,
          carried: true,
          actualMin: null,
          order: 2,
          createdAt: TODAY + 'T08:05',
        },
        {
          id: 't3',
          title: '回邮件',
          priority: 2,
          estimateMin: 30,
          dueAt: TODAY + 'T09:00',
          pinnedStart: null,
          date: TODAY,
          done: true,
          carried: false,
          actualMin: 25,
          order: 3,
          createdAt: TODAY + 'T08:10',
          doneAt: TODAY + 'T08:40',
        },
      ],
      history: {
        [addDays(TODAY, -1)]: {
          date: addDays(TODAY, -1),
          archivedAt: TODAY + 'T00:00',
          tasks: [
            {
              id: 'h1',
              title: '昨天的事',
              priority: 2,
              estimateMin: 30,
              date: addDays(TODAY, -1),
              done: true,
              order: 1,
              createdAt: addDays(TODAY, -1) + 'T08:00',
            },
          ],
          stats: { total: 1, done: 1, undone: 0, estimateMin: 30, doneMin: 30 },
        },
      },
      meta: {
        firstRunDate: TODAY,
        lastRolloverDate: TODAY,
        createdAt: TODAY + 'T08:00',
        updatedAt: TODAY + 'T08:00',
      },
    },
  };
}

async function loadClient() {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const sandbox = makeSandbox(sampleState());
  let captured = null;
  sandbox.window.__ModuleLoader__ = {
    load(info) {
      captured = info;
    },
  };
  vm.runInNewContext(bundle, sandbox, { filename: 'lib/client.js' });
  assert.ok(captured, 'bundle 必须调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-taskboard');

  const moduleExports = captured.factory(sandbox.require);
  assert.equal(moduleExports.name, 'taskboard');
  assert.equal(moduleExports.inject.length, 1);
  assert.equal(moduleExports.inject[0], 'slots');

  const registrations = new Map();
  const ctx = {
    slots: {
      inject(name, callback) {
        const result = callback();
        return result;
      },
      register(meta, component) {
        registrations.set(meta.name + ':' + (meta.key || meta.id), { meta, component });
        return { dispose() {} };
      },
    },
    get() {
      return { selectPanel() {} };
    },
  };
  moduleExports.apply(ctx);
  return { registrations, sandbox, moduleExports };
}

/* ------------------------------------------------------------------ 用例 */

test('客户端 bundle 能注册三个席位', async () => {
  const { registrations } = await loadClient();
  assert.ok(registrations.has('main:taskboard'));
  assert.ok(registrations.has('sidebar.panellist:taskboard'));
  assert.ok(registrations.has('shell.overlay:taskboard-dock'));
});

test('完整面板：空态 + 有数据 + 没排上/已完成都能渲染', async () => {
  const { registrations, sandbox } = await loadClient();
  const page = registrations.get('main:taskboard').component;
  renderNode(createElement(page, {}));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const html = renderNode(createElement(page, {}));
  assert.match(html, /任务排程/);
  assert.match(html, /返回对话/);
  assert.match(html, /写周报/);
  assert.match(html, /排程已完成|没排上/);
  assert.match(html, /已完成/);
  assert.match(html, /超载|富余/);
  assert.ok(sandbox.document, 'sandbox 可用');
});

test('旧版「×」关闭状态会迁移成细条，不会彻底消失', async () => {
  const { moduleExports, sandbox } = await loadClient();
  const internals = moduleExports.__internals;
  sandbox.localStorage.setItem(
    'dsh-taskboard:dock:v2',
    JSON.stringify({ enabled: false, open: false, side: 'right', top: 92, width: 348, height: 0 }),
  );
  const migrated = internals.readDockPrefs();
  assert.equal(migrated.enabled, true, '迁移后恢复显示');
  assert.equal(migrated.open, false, '迁移后只保留细条');
  assert.equal(migrated.migrated, true);

  const hidden = internals.setDockVisibility(false);
  assert.equal(hidden.enabled, false);
  assert.equal(internals.readDockPrefs().enabled, false, '迁移只做一次，之后真正隐藏仍然生效');

  const shown = internals.setDockVisibility(true);
  assert.equal(shown.enabled, true);
  assert.equal(internals.readDockPrefs().open, true, '重新打开时恢复卡片');
});

test('完整面板提供返回对话的入口', async () => {
  const { moduleExports } = await loadClient();
  const internals = moduleExports.__internals;
  assert.equal(typeof internals.returnToConversation, 'function');
  assert.equal(internals.returnToConversation(), true, '有 layout 服务时应能切回会话面板');
});

test('设置弹层、历史弹层、行内编辑器、悬浮小窗都能渲染', async () => {
  const { moduleExports, sandbox } = await loadClient();
  const internals = moduleExports.__internals;
  assert.ok(internals, '导出内部组件供冒烟测试');

  const state = sampleState().state;
  const settingsHtml = renderNode(createElement(internals.SettingsDialog, { state, dataFile: 'C:/state.json', onClose() {} }));
  assert.match(settingsHtml, /上班时间/);
  assert.match(settingsHtml, /只改今天/);
  assert.match(settingsHtml, /导出备份/);

  const historyHtml = renderNode(createElement(internals.HistoryDialog, { state, onClose() {} }));
  assert.match(historyHtml, /历史记录/);
  assert.match(historyHtml, /昨天的事/);

  const editorHtml = renderNode(createElement(internals.TaskEditor, {
    task: state.tasks[0],
    onClose() {},
    onRequestDelete() {},
  }));
  assert.match(editorHtml, /固定开始/);
  assert.match(editorHtml, /删除/);

  const quickHtml = renderNode(createElement(internals.QuickAdd, { settings: state.settings, today: TODAY }));
  assert.match(quickHtml, /P0/);
  assert.match(quickHtml, /到下班/);
  assert.match(quickHtml, /固定时间/);

  const iconHtml = renderNode(createElement(internals.TaskboardIcon, { size: 16, active: true }));
  assert.equal(iconHtml, '');

  // 悬浮小窗：默认展开；改成收起后只剩竖排细条。
  renderNode(createElement(internals.TaskboardDock, {}));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const dockHtml = renderNode(createElement(internals.TaskboardDock, {}));
  assert.match(dockHtml, /任务排程/);
  assert.match(dockHtml, /写周报/);

  sandbox.localStorage.setItem('dsh-taskboard:dock:v2', JSON.stringify({ enabled: true, open: false, side: 'right', top: 92 }));
  const stripHtml = renderNode(createElement(internals.TaskboardDock, {}));
  assert.match(stripHtml, /任务排程/);
  assert.ok(!stripHtml.includes('写周报'), '收起态不应该渲染任务列表');

  const calendarHtml = renderNode(createElement(internals.CalendarDialog, {
    today: TODAY,
    selected: TODAY,
    tasks: state.tasks,
    settings: state.settings,
    onSelect() {},
    onClose() {},
  }));
  assert.match(calendarHtml, /选择日期/);
  assert.match(calendarHtml, /今天/);
  assert.match(calendarHtml, /未来 7 天/);

  const virtualState = {
    ...state,
    virtual: {
      tasks: [{ id: 'v1', title: '虚拟任务A', priority: 0, estimateMin: 60, pinnedTime: '10:00', order: 0 }],
    },
  };
  const virtualHtml = renderNode(createElement(internals.VirtualDialog, {
    state: virtualState,
    targetDate: TODAY,
    onClose() {},
  }));
  assert.match(virtualHtml, /虚拟时间轴/);
  assert.match(virtualHtml, /虚拟任务A/);
  assert.match(virtualHtml, /10:00–11:00/);
  assert.match(virtualHtml, /覆盖到/);
});
