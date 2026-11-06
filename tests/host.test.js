/* 宿主半侧测试：本地 JSON、跨天归档/顺延、HTTP 路由、旧数据迁移。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TaskStore,
  createHandler,
  normalizeState,
  normalizeTask,
  rollover,
} from '../src/host.js';
import { addDays, localDateKey } from '../src/scheduler.js';

const TODAY = localDateKey();
const YESTERDAY = addDays(TODAY, -1);

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-test-'));
  return { dir, store: new TaskStore(dir) };
}

function taskAt(date, overrides = {}) {
  return normalizeTask(
    Object.assign(
      {
        id: 't_' + Math.random().toString(36).slice(2),
        title: '任务',
        priority: 2,
        estimateMin: 30,
        date,
        order: 1,
        createdAt: date + 'T08:00',
      },
      overrides,
    ),
    date,
  );
}

test('首次读取会创建本地 state.json，增删改都落盘', () => {
  const { dir, store } = tempStore();
  try {
    const first = store.snapshot();
    assert.equal(first.state.tasks.length, 0);
    assert.ok(readFileSync(join(dir, 'state.json'), 'utf8').includes('"version": 1'));

    let snap = store.dispatch('addTask', { title: '  写周报  ', priority: 0, estimateMin: 45, dueAt: TODAY + 'T18:00' });
    assert.equal(snap.state.tasks.length, 1);
    assert.equal(snap.state.tasks[0].title, '写周报');
    assert.equal(snap.state.tasks[0].dueAt, TODAY + 'T18:00');

    const id = snap.state.tasks[0].id;
    snap = store.dispatch('updateTask', { id, title: '写月报', priority: 1 });
    assert.equal(snap.state.tasks[0].title, '写月报');
    assert.equal(snap.state.tasks[0].priority, 1);

    snap = store.dispatch('toggleTask', { id });
    assert.equal(snap.state.tasks[0].done, true);
    assert.ok(snap.state.tasks[0].doneAt);

    snap = store.dispatch('deleteTask', { id });
    assert.equal(snap.state.tasks.length, 0);

    const disk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(disk.tasks.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('跨天：先归档，再把未完成顺延到今天并标 carried', () => {
  const { dir, store } = tempStore();
  try {
    const state = store.read();
    state.tasks = [
      taskAt(YESTERDAY, { id: 'u1', title: '昨天没做完', order: 1 }),
      taskAt(YESTERDAY, { id: 'd1', title: '昨天做完了', done: true, doneAt: YESTERDAY + 'T17:00', order: 2 }),
    ];
    state.meta.lastRolloverDate = YESTERDAY;
    store.persist();

    const next = store.read();
    assert.equal(next.tasks.filter((task) => task.date === TODAY).length, 1, '只顺延未完成的一件');
    assert.equal(next.tasks[0].title, '昨天没做完');
    assert.equal(next.tasks[0].carried, true);

    assert.ok(next.history[YESTERDAY], '顺延前先归档');
    assert.equal(next.history[YESTERDAY].tasks.length, 2);
    assert.equal(next.history[YESTERDAY].stats.total, 2);
    assert.equal(next.history[YESTERDAY].stats.done, 1);
    assert.equal(next.meta.lastRolloverDate, TODAY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autoCarry 关闭：归档但不搬运', () => {
  const { dir, store } = tempStore();
  try {
    const state = store.read();
    state.settings.autoCarry = false;
    state.tasks = [taskAt(YESTERDAY, { title: '留在昨天' })];
    state.meta.lastRolloverDate = YESTERDAY;
    store.persist();

    const next = store.read();
    assert.equal(next.tasks.length, 0);
    assert.ok(next.history[YESTERDAY]);
    assert.equal(next.history[YESTERDAY].tasks[0].title, '留在昨天');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('首次运行不搬运更早的遗留任务，只归档', () => {
  const { dir, store } = tempStore();
  try {
    const state = store.read();
    state.tasks = [taskAt(addDays(TODAY, -5), { title: '很久以前' })];
    state.meta.lastRolloverDate = null;
    state.meta.firstRunDate = null;
    store.persist();

    const next = store.read();
    assert.equal(next.tasks.length, 0);
    assert.ok(next.history[addDays(TODAY, -5)]);
    assert.equal(next.meta.lastRolloverDate, TODAY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只改今天：当天的保留，过夜的清掉', () => {
  const keep = normalizeState({ settings: { workEnd: '18:00' } }, TODAY);
  keep.settings.todayOverride = { date: TODAY, workEnd: '21:00' };
  keep.meta.lastRolloverDate = YESTERDAY;
  rollover(keep, TODAY);
  assert.equal(keep.settings.todayOverride.workEnd, '21:00');

  const stale = normalizeState({ settings: { workEnd: '18:00' } }, TODAY);
  stale.settings.todayOverride = { date: YESTERDAY, workEnd: '21:00' };
  stale.meta.lastRolloverDate = YESTERDAY;
  rollover(stale, TODAY);
  assert.equal(stale.settings.todayOverride, null);
});

test('导入旧版 v1 state：设置保留，旧任务搬进今天，已完成进历史', () => {
  const { dir, store } = tempStore();
  try {
    const legacy = {
      v: 1,
      tasks: [
        {
          id: 'old1',
          title: '旧版没做完',
          priority: 0,
          estimateMin: 45,
          dueAt: YESTERDAY + 'T18:00',
          date: YESTERDAY,
          done: false,
          order: 1,
        },
        {
          id: 'old2',
          title: '旧版做完了',
          priority: 2,
          estimateMin: 30,
          date: YESTERDAY,
          done: true,
          order: 2,
        },
      ],
      history: {},
      settings: {
        workStart: '08:30',
        workEnd: '21:00',
        lunchStart: '12:00',
        lunchEnd: '13:00',
        lunchOn: true,
        autoCarry: true,
        lastCarry: YESTERDAY,
      },
    };
    const snap = store.dispatch('importState', { data: legacy });
    assert.equal(snap.state.settings.workStart, '08:30');
    assert.equal(snap.state.settings.workEnd, '21:00');
    assert.equal(snap.state.tasks.length, 1);
    assert.equal(snap.state.tasks[0].title, '旧版没做完');
    assert.equal(snap.state.tasks[0].date, TODAY);
    assert.equal(snap.state.tasks[0].carried, true);
    assert.equal(snap.state.tasks[0].dueAt, YESTERDAY + 'T18:00', '顺延保留原截止时间');
    const archived = Object.values(snap.state.history).flatMap((entry) => entry.tasks);
    assert.ok(archived.some((task) => task.title === '旧版做完了'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP：GET state / POST action / GET export / 404', async () => {
  const { dir, store } = tempStore();
  const server = http.createServer(createHandler(store));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const stateRes = await fetch(base + '/dsh-taskboard/state');
    assert.equal(stateRes.status, 200);
    const stateBody = await stateRes.json();
    assert.equal(stateBody.ok, true);
    assert.equal(stateBody.today, TODAY);
    assert.ok(stateBody.dataFile.endsWith('state.json'));

    const addRes = await fetch(base + '/dsh-taskboard/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-taskboard': '1' },
      body: JSON.stringify({ action: 'addTask', payload: { title: 'HTTP 任务', priority: 1 } }),
    });
    assert.equal(addRes.status, 200);
    const added = await addRes.json();
    assert.equal(added.state.tasks[0].title, 'HTTP 任务');

    const badRes = await fetch(base + '/dsh-taskboard/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-taskboard': '1' },
      body: JSON.stringify({ action: 'nope' }),
    });
    assert.equal(badRes.status, 400);

    const noHeader = await fetch(base + '/dsh-taskboard/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'virtualClear' }),
    });
    assert.equal(noHeader.status, 403, '缺少动作头时拒绝，防跨站表单');
    const wrongType = await fetch(base + '/dsh-taskboard/action', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-dsh-taskboard': '1' },
      body: JSON.stringify({ action: 'virtualClear' }),
    });
    assert.equal(wrongType.status, 415, '只接受 application/json');
    const crossOrigin = await fetch(base + '/dsh-taskboard/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-taskboard': '1', origin: 'http://evil.example' },
      body: JSON.stringify({ action: 'virtualClear' }),
    });
    assert.equal(crossOrigin.status, 403, '跨站 Origin 拒绝');
    const preflight = await fetch(base + '/dsh-taskboard/action', { method: 'OPTIONS' });
    assert.equal(preflight.status, 405, '不返回 CORS 放行');
    assert.equal(addRes.headers.get('x-content-type-options'), 'nosniff');

    const exportRes = await fetch(base + '/dsh-taskboard/export');
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get('content-disposition') || '', /taskboard-\d{4}-\d{2}-\d{2}\.json/);
    assert.equal((await exportRes.json()).tasks[0].title, 'HTTP 任务');

    const missing = await fetch(base + '/dsh-taskboard/nope');
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('完成任务时可一并记录实际耗时', () => {
  const { dir, store } = tempStore();
  try {
    let snap = store.dispatch('addTask', { title: '计时任务', estimateMin: 30 });
    const id = snap.state.tasks[0].id;
    snap = store.dispatch('toggleTask', { id, actualMin: 42 });
    assert.equal(snap.state.tasks[0].done, true);
    assert.equal(snap.state.tasks[0].actualMin, 42);

    snap = store.dispatch('toggleTask', { id });
    snap = store.dispatch('toggleTask', { id, actualMin: 10 });
    assert.equal(snap.state.tasks[0].actualMin, 42, '已有实际值不覆盖');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未来日期任务与虚拟时间轴', () => {
  const { dir, store } = tempStore();
  try {
    const tomorrow = addDays(TODAY, 1);
    let snap = store.dispatch('addTask', { title: '明天的任务', date: tomorrow, estimateMin: 45 });
    assert.equal(snap.state.tasks[0].date, tomorrow);

    snap = store.dispatch('virtualAdd', { title: '虚拟A', estimateMin: 60, priority: 0, pinnedTime: '10:00' });
    snap = store.dispatch('virtualAdd', { title: '虚拟B', estimateMin: 30, priority: 2 });
    assert.equal(snap.state.virtual.tasks.length, 2);

    snap = store.dispatch('virtualApply', { date: tomorrow });
    const tomorrowTasks = snap.state.tasks.filter((task) => task.date === tomorrow);
    assert.equal(tomorrowTasks.length, 2, '覆盖到明天，连同原来的明天任务一起替换');
    assert.equal(tomorrowTasks[0].title, '虚拟A');
    assert.equal(tomorrowTasks[0].pinnedStart, tomorrow + 'T10:00');

    snap = store.dispatch('virtualImport', { tasks: [{ title: '导入的虚拟任务', estimateMin: 20 }] });
    assert.equal(snap.state.virtual.tasks.length, 1);
    assert.equal(snap.state.virtual.tasks[0].title, '导入的虚拟任务');

    snap = store.dispatch('saveSettings', { settings: { remindersOn: false, reminderLeadMin: 8 } });
    assert.equal(snap.state.settings.remindersOn, false);
    assert.equal(snap.state.settings.reminderLeadMin, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('动作：顺延到明天 / 重排 / 保存设置 / 只改今天', () => {
  const { dir, store } = tempStore();
  try {
    let snap = store.dispatch('addTask', { title: 'A', priority: 0, estimateMin: 30 });
    snap = store.dispatch('addTask', { title: 'B', priority: 1, estimateMin: 45 });
    const a = snap.state.tasks.find((task) => task.title === 'A');
    const b = snap.state.tasks.find((task) => task.title === 'B');

    snap = store.dispatch('reorder', { ids: [b.id, a.id] });
    assert.equal(snap.state.tasks.find((task) => task.id === b.id).order, 0);
    assert.equal(snap.state.tasks.find((task) => task.id === a.id).order, 1);

    snap = store.dispatch('carryToTomorrow', { id: a.id });
    const carried = snap.state.tasks.find((task) => task.id === a.id);
    assert.equal(carried.date, addDays(TODAY, 1));
    assert.equal(carried.carried, true);

    snap = store.dispatch('saveSettings', { settings: { workStart: '08:30', defaultEstimateMin: 45 } });
    assert.equal(snap.state.settings.workStart, '08:30');
    assert.equal(snap.state.settings.defaultEstimateMin, 45);

    snap = store.dispatch('setTodayOverride', { workEnd: '21:00', lunchOn: true });
    assert.equal(snap.state.settings.todayOverride.date, TODAY);
    assert.equal(snap.state.settings.todayOverride.workEnd, '21:00');

    snap = store.dispatch('setTodayOverride', { clear: true });
    assert.equal(snap.state.settings.todayOverride, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏的 state.json 会保留副本并恢复空状态', () => {
  const { dir, store } = tempStore();
  try {
    store.read();
    writeFileSync(join(dir, 'state.json'), '{ 这不是 JSON', 'utf8');
    const next = store.read();
    assert.equal(next.tasks.length, 0);
    const files = readdirSync(dir);
    assert.ok(files.some((name) => name.startsWith('state.json.corrupt-')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
