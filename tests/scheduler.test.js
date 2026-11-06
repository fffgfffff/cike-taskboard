/* 排程内核单元测试：node --test tests/
 * 逐条对应《需求说明书》第 2.4 / 4 节与第 7 节边界情况。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SETTINGS,
  addDays,
  addWorkMinutes,
  formatDuration,
  fromMinutes,
  localDateKey,
  nextUp,
  nextWorkMinute,
  parseLocalDateTime,
  schedule,
  workMinutesBetween,
  workWindows,
} from '../src/scheduler.js';

const D = '2026-06-03';
const base = {
  workStart: '09:00',
  workEnd: '18:00',
  lunchStart: '12:00',
  lunchEnd: '13:00',
  lunchOn: true,
  autoCarry: true,
  defaultEstimateMin: 30,
};

let seq = 0;
function task(overrides = {}) {
  seq += 1;
  return Object.assign(
    {
      id: 'x' + seq,
      title: '任务' + seq,
      priority: 2,
      estimateMin: 30,
      dueAt: null,
      pinnedStart: null,
      date: D,
      done: false,
      order: seq,
      createdAt: D + 'T08:00',
    },
    overrides,
  );
}

const find = (plan, title) => plan.placed.find((item) => item.task.title === title);
const span = (item) => [fromMinutes(item.startMin), fromMinutes(item.endMin)];
const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

test('基础：可用 8 小时，9–12 / 13–18 两段，午休不被占用', () => {
  const plan = schedule([], base, D);
  assert.equal(plan.availMin, 480);
  assert.deepEqual(plan.segs, [[540, 720], [780, 1080]]);
  assert.equal(plan.availableMin, 480);
  assert.deepEqual(plan.lunch, { start: 720, end: 780 });
});

test('不切分：90 分钟任务放不进下班前 60 分钟碎片', () => {
  const plan = schedule(
    [
      task({ title: '长任务', estimateMin: 90, priority: 0, dueAt: D + 'T10:00', order: 1 }),
      task({ title: '垫时间', estimateMin: 420, priority: 3, dueAt: D + 'T23:59', order: 2 }),
    ],
    base,
    D,
  );
  const long = find(plan, '长任务');
  assert.ok(long);
  assert.equal(long.endMin - long.startMin, 90);
  assert.ok(!(long.startMin < 720 && long.endMin > 720), '不能跨午休');
});

test('长任务自动分段：先填满上午，剩余排到下午', () => {
  const plan = schedule(
    [
      task({ title: '大块', estimateMin: 300, priority: 3, dueAt: D + 'T23:59', order: 1 }),
      task({ title: '90分钟', estimateMin: 90, priority: 1, dueAt: D + 'T09:00', order: 2 }),
    ],
    base,
    D,
  );
  const big = find(plan, '大块');
  assert.ok(big);
  assert.equal(big.split, true);
  assert.deepEqual(
    big.parts.map((part) => [fromMinutes(part.startMin), fromMinutes(part.endMin)]),
    [
      ['10:30', '12:00'],
      ['13:00', '16:30'],
    ],
  );
  assert.equal(big.durationMin, 300);
  assert.equal(big.startMin, 630);
  assert.equal(big.endMin, 990);
  assert.ok(big.parts.every((part) => !(part.startMin < 720 && part.endMin > 720)));
});

test('一个 5 小时任务会占满上午，午休后再占下午，而不是整体躲到下午', () => {
  const plan = schedule([task({ title: '供应商对账', estimateMin: 300 })], base, D);
  const entry = find(plan, '供应商对账');
  assert.deepEqual(
    entry.parts.map((part) => [fromMinutes(part.startMin), fromMinutes(part.endMin)]),
    [
      ['09:00', '12:00'],
      ['13:00', '15:00'],
    ],
  );
  assert.equal(entry.durationMin, 300);
  assert.equal(plan.stats.scheduledMin, 300);
  assert.equal(plan.stats.unplacedCount, 0);
});

test('超载：放不下的进「没排上」，总需求减可用就是超载量', () => {
  const plan = schedule(
    [
      task({ title: '占满', estimateMin: 480, priority: 3, dueAt: D + 'T23:59', order: 1 }),
      task({ title: '塞不下', estimateMin: 60, priority: 0, dueAt: D + 'T08:00', order: 2 }),
    ],
    base,
    D,
  );
  assert.equal(find(plan, '塞不下').startMin, 540);
  assert.ok(plan.unplaced.some((item) => item.title === '占满'));
  assert.equal(plan.overloadMin, 60);
  assert.equal(plan.stats.overloadMin, 60);
  assert.equal(plan.stats.surplusMin, -60);
});

test('排序：截止近优先，同级看优先级，再看添加顺序', () => {
  const plan = schedule(
    [
      task({ title: 'P0但下周', priority: 0, dueAt: '2026-06-10T18:00', estimateMin: 60, order: 1 }),
      task({ title: 'P1但今天下午', priority: 1, dueAt: D + 'T17:00', estimateMin: 60, order: 2 }),
      task({ title: 'P2今天更早', priority: 2, dueAt: D + 'T11:00', estimateMin: 60, order: 3 }),
    ],
    base,
    D,
  );
  assert.equal(find(plan, 'P2今天更早').startMin, 540);
  assert.equal(find(plan, 'P1但今天下午').startMin, 600);
  assert.equal(find(plan, 'P0但下周').startMin, 660);
});

test('已过期任务排最前', () => {
  const plan = schedule(
    [
      task({ title: 'P0正常', priority: 0, dueAt: D + 'T18:00', estimateMin: 60, order: 1 }),
      task({ title: '过期小事', priority: 3, dueAt: '2026-06-01T10:00', estimateMin: 30, order: 2 }),
    ],
    base,
    D,
    { now: new Date(D + 'T09:00') },
  );
  assert.equal(find(plan, '过期小事').startMin, 540);
  assert.equal(find(plan, '过期小事').flags.overdue, true);
});

test('钉住任务：位置不动，自动任务避开', () => {
  const plan = schedule(
    [
      task({ title: '钉住', pinnedStart: D + 'T14:00', estimateMin: 60, priority: 2, order: 1 }),
      task({ title: '自动', estimateMin: 60, priority: 1, dueAt: D + 'T09:00', order: 2 }),
    ],
    base,
    D,
  );
  assert.equal(find(plan, '钉住').startMin, 840);
  assert.equal(find(plan, '自动').startMin, 540);
});

test('钉住撞午休：保留位置并标红', () => {
  const plan = schedule(
    [
      task({ title: '钉在午休', pinnedStart: D + 'T12:30', estimateMin: 60, priority: 2, order: 1 }),
      task({ title: '正常', estimateMin: 60, priority: 2, dueAt: D + 'T09:00', order: 2 }),
    ],
    base,
    D,
  );
  const pin = find(plan, '钉在午休');
  assert.equal(pin.startMin, 750);
  assert.equal(pin.flags.lunch, true);
  assert.equal(pin.conflict, true);
  assert.equal(find(plan, '正常').startMin, 540);
});

test('钉在另一天：标 outside，不占今天的时段', () => {
  const plan = schedule(
    [task({ title: '钉到明天', pinnedStart: '2026-06-04T10:00', estimateMin: 30, priority: 2 })],
    base,
    D,
  );
  const pin = find(plan, '钉到明天');
  assert.equal(pin.flags.outside, true);
  assert.equal(pin.conflict, true);
});

test('两个钉住互相重叠：两边都标红', () => {
  const plan = schedule(
    [
      task({ title: 'A钉10', pinnedStart: D + 'T10:00', estimateMin: 60, order: 1 }),
      task({ title: 'B钉10', pinnedStart: D + 'T10:30', estimateMin: 60, order: 2 }),
    ],
    base,
    D,
  );
  assert.equal(find(plan, 'A钉10').flags.overlap, true);
  assert.equal(find(plan, 'B钉10').flags.overlap, true);
  assert.equal(find(plan, 'A钉10').conflict, true);
  assert.equal(find(plan, 'B钉10').conflict, true);
});

test('晚于截止：结束时刻减截止时刻就是迟到分钟数', () => {
  const plan = schedule(
    [task({ title: '排太晚', priority: 3, dueAt: D + 'T09:30', estimateMin: 120, order: 1 })],
    base,
    D,
  );
  assert.equal(find(plan, '排太晚').flags.due, 90);
  assert.equal(find(plan, '排太晚').conflict, true);
});

test('午休关闭 / 只改今天 / 次日恢复', () => {
  const noLunch = Object.assign({}, base, { lunchOn: false });
  const plan = schedule([], noLunch, D);
  assert.equal(plan.availMin, 540);
  assert.equal(plan.segs.length, 1);

  const overtime = Object.assign({}, base, {
    todayOverride: { date: D, workEnd: '21:00' },
  });
  assert.equal(schedule([], overtime, D).availMin, 660);
  assert.equal(schedule([], overtime, '2026-06-04').availMin, 480);
});

test('没填耗时按默认 30 分钟；输出按开始时间升序；午休不排任务', () => {
  const single = schedule([task({ title: '没填', estimateMin: 0 })], base, D);
  assert.equal(single.placed[0].endMin - single.placed[0].startMin, 30);

  const many = [];
  for (let i = 0; i < 30; i += 1) many.push(task({ title: 'T' + i, estimateMin: 25, order: i }));
  const plan = schedule(many, base, D);
  assert.ok(plan.placed.every((item, index, list) => index === 0 || list[index - 1].startMin <= item.startMin));
  assert.ok(plan.placed.every((item) => !(item.startMin < 720 && item.endMin > 720)));
});

test('碎片回填 + 跨午休续排：大块占 10–12 与 13–15，小事填后面的空', () => {
  const plan = schedule(
    [
      task({ title: '早会', pinnedStart: D + 'T09:00', estimateMin: 60, priority: 1, order: 1 }),
      task({ title: '大块', estimateMin: 240, priority: 0, dueAt: D + 'T09:30', order: 2 }),
      task({ title: '小事A', estimateMin: 60, priority: 3, dueAt: D + 'T23:00', order: 3 }),
      task({ title: '小事B', estimateMin: 60, priority: 3, dueAt: D + 'T23:01', order: 4 }),
    ],
    base,
    D,
  );
  const big = find(plan, '大块');
  assert.deepEqual(
    big.parts.map((part) => [fromMinutes(part.startMin), fromMinutes(part.endMin)]),
    [
      ['10:00', '12:00'],
      ['13:00', '15:00'],
    ],
  );
  assert.deepEqual(span(find(plan, '小事A')), ['15:00', '16:00']);
  assert.deepEqual(span(find(plan, '小事B')), ['16:00', '17:00']);
  assert.equal(plan.placedMin, 420);
  assert.ok(plan.blocks.every(({ part }) => !(part.startMin < 720 && part.endMin > 720)));
});

test('长任务会绕开钉住任务继续填，而不是跳到更后面', () => {
  const plan = schedule(
    [
      task({ title: '站会', pinnedStart: D + 'T10:00', estimateMin: 60, order: 1 }),
      task({ title: '大块', estimateMin: 240, priority: 0, order: 2 }),
    ],
    base,
    D,
  );
  const big = find(plan, '大块');
  assert.deepEqual(
    big.parts.map((part) => [fromMinutes(part.startMin), fromMinutes(part.endMin)]),
    [
      ['09:00', '10:00'],
      ['11:00', '12:00'],
      ['13:00', '15:00'],
    ],
  );
  assert.equal(big.durationMin, 240);
});

test('钉住的长任务也会在午休处自动分段', () => {
  const plan = schedule(
    [task({ title: '钉住大块', pinnedStart: D + 'T10:00', estimateMin: 300, order: 1 })],
    base,
    D,
  );
  const entry = find(plan, '钉住大块');
  assert.deepEqual(
    entry.parts.map((part) => [fromMinutes(part.startMin), fromMinutes(part.endMin)]),
    [
      ['10:00', '12:00'],
      ['13:00', '16:00'],
    ],
  );
  assert.equal(entry.durationMin, 300);
  assert.equal(entry.pinned, true);
  assert.equal(entry.flags.lunch, false, '跨午休是分段，不算撞午休');
});

test('超过计划结束仍未完成：标出超计划分钟数', () => {
  const plan = schedule(
    [task({ title: '拖了', estimateMin: 60 })],
    base,
    D,
    { now: new Date(D + 'T10:30') },
  );
  const entry = find(plan, '拖了');
  assert.equal(entry.overPlan, true);
  assert.equal(entry.overrunMin, 30);
  assert.equal(plan.stats.overrunCount, 1);
});

test('从现在重排：只排当前时间之后的时段', () => {
  const plan = schedule(
    [task({ title: '接下来', estimateMin: 60 })],
    base,
    D,
    { now: new Date(D + 'T14:00'), anchorMin: 14 * 60 },
  );
  assert.equal(plan.anchorMin, 840);
  assert.deepEqual(plan.segs, [[840, 1080]]);
  assert.equal(plan.availableMin, 240);
  assert.equal(plan.placed[0].startMin, 840);
  assert.equal(plan.lunch, null, '已经过了午休就不再画午休');

  const lunchAnchor = schedule([], base, D, { now: new Date(D + 'T12:30'), anchorMin: 12 * 60 + 30 });
  assert.deepEqual(lunchAnchor.segs, [[780, 1080]], '落在午休里就从午休结束开始');
});

test('从现在重排时的钉住任务：已过去的归档，进行中的保留剩余段', () => {
  const anchor = 14 * 60 + 54;
  const plan = schedule(
    [
      task({ title: '早就结束了', pinnedStart: D + 'T13:00', estimateMin: 30 }),
      task({ title: '正在做', pinnedStart: D + 'T14:46', estimateMin: 30 }),
    ],
    base,
    D,
    { now: new Date(D + 'T14:54'), anchorMin: anchor },
  );
  const past = find(plan, '早就结束了');
  assert.equal(past.flags.past, true);
  assert.equal(past.flags.outside, true);
  const running = find(plan, '正在做');
  assert.equal(running.flags.outside, false);
  assert.equal(running.parts[0].startMin, anchor, '从锚点保留剩余段');
  assert.equal(running.parts[0].endMin, 14 * 60 + 46 + 30);
  assert.equal(running.current, true);
});

test('实时高亮：当前时刻落在哪一段，就标哪一段', () => {
  const plan = schedule(
    [
      task({ title: '上午活', estimateMin: 180, order: 1 }),
      task({ title: '下午活', estimateMin: 120, order: 2 }),
    ],
    base,
    D,
    { now: new Date(D + 'T14:30') },
  );
  assert.equal(plan.nowMin, 870);
  assert.ok(plan.current);
  assert.equal(plan.current.task.title, '下午活');
  assert.ok(plan.currentPart);
  assert.equal(plan.currentPart.current, true);
  // 上午那件已经结束，不应该再被标成“进行中”
  assert.equal(find(plan, '上午活').current, false);
});

test('时间段工具：范围取上班分钟、从某分钟起算结束、下班后原样返回', () => {
  assert.equal(workMinutesBetween(base, D, 9 * 60, 15 * 60), 5 * 60); // 9–12 + 13–15，午休不计
  assert.equal(workMinutesBetween(base, D, 12 * 60, 13 * 60), 0);
  assert.equal(addWorkMinutes(base, D, 11 * 60, 90), 13 * 60 + 30); // 11:00 + 90 分钟 → 13:30
  assert.equal(addWorkMinutes(base, D, 17 * 60, 120), 19 * 60); // 下班后继续加，返回 19:00
  assert.equal(nextWorkMinute(base, D, 12 * 60 + 30), 13 * 60);
  assert.equal(nextWorkMinute(base, D, 8 * 60), 9 * 60);
});

test('总可用时间不够 → 整件进没排上（不会只排一半）', () => {
  const plan = schedule(
    [
      task({ title: '早会', pinnedStart: D + 'T09:00', estimateMin: 60, order: 1 }),
      task({ title: '下午钉住', pinnedStart: D + 'T13:00', estimateMin: 240, order: 2 }),
      task({ title: '大块', estimateMin: 240, priority: 0, dueAt: D + 'T09:30', order: 3 }),
    ],
    base,
    D,
  );
  assert.ok(!find(plan, '大块'));
  assert.ok(plan.unplaced.some((item) => item.title === '大块'));
  assert.equal(plan.overloadMin, 60);
  assert.equal(plan.placed.length, 2);
});

test('150 分钟进上午，30 分钟小事回填 11:30 碎片', () => {
  const plan = schedule(
    [
      task({ title: '小块', estimateMin: 150, priority: 3, dueAt: D + 'T23:00', order: 1 }),
      task({ title: '小事', estimateMin: 30, priority: 3, dueAt: D + 'T23:01', order: 2 }),
    ],
    base,
    D,
  );
  assert.equal(find(plan, '小块').startMin, 540);
  assert.equal(find(plan, '小事').startMin, 690);
  assert.ok(plan.placed.every((item) => !(item.startMin < 720 && item.endMin > 720)));
});

test('统计：需 540 / 可用 480 / 超载 60 / 没排上 1 件', () => {
  const plan = schedule(
    [
      task({ title: 'a', estimateMin: 180, priority: 0, dueAt: D + 'T09:00', order: 1 }),
      task({ title: 'b', estimateMin: 180, priority: 1, dueAt: D + 'T09:01', order: 2 }),
      task({ title: 'c', estimateMin: 180, priority: 2, dueAt: D + 'T09:02', order: 3 }),
    ],
    base,
    D,
  );
  assert.equal(plan.needMin, 540);
  assert.equal(plan.availMin, 480);
  assert.equal(plan.overloadMin, 60);
  assert.equal(plan.placed.length, 2);
  assert.equal(plan.unplaced.length, 1);
  assert.equal(plan.unplaced[0].title, 'c');
  assert.equal(plan.placedMin, 360);
  assert.equal(plan.freeMin, 120);
});

test('已完成任务不进排程，但计入当天任务数', () => {
  const plan = schedule(
    [
      task({ title: '做完的', done: true, estimateMin: 60, order: 1 }),
      task({ title: '要做的', estimateMin: 60, order: 2 }),
    ],
    base,
    D,
  );
  assert.equal(plan.placed.length, 1);
  assert.equal(plan.placed[0].task.title, '要做的');
  assert.equal(plan.stats.doneCount, 1);
  assert.equal(plan.stats.taskCount, 2);
  assert.equal(plan.needMin, 60);
});

test('空工作日：可用 0 时所有任务都进没排上', () => {
  const plan = schedule([task({ title: '没处放', estimateMin: 30 })], { ...base, workEnd: '09:00' }, D);
  assert.equal(plan.availableMin, 0);
  assert.equal(plan.placed.length, 0);
  assert.equal(plan.unplaced.length, 1);
});

test('时间工具：格式化、日期加减、下一件', () => {
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(90), '1h30m');
  assert.equal(formatDuration(120), '2h');
  assert.equal(formatDuration(-60), '-1h');
  assert.equal(addDays('2026-06-03', 1), '2026-06-04');
  assert.equal(localDateKey(parseLocalDateTime('2026-06-03T23:10')), '2026-06-03');
  assert.equal(parseLocalDateTime('2026-06-03T25:00'), null);

  const plan = schedule(
    [
      task({ title: '上午', estimateMin: 60, order: 1 }),
      task({ title: '下午', estimateMin: 60, order: 2 }),
    ],
    base,
    D,
  );
  assert.equal(nextUp(plan, at('08:30')).task.title, '上午');
  assert.equal(nextUp(plan, at('10:30')).task.title, '下午');
  assert.equal(workWindows(DEFAULT_SETTINGS, D).availableMin, 480);
});

test('今天富余按实时到下班，未来日期按全天', () => {
  const today = localDateKey();
  const at15 = new Date(today + 'T15:00:00');
  const todayPlan = schedule([task({ date: today, estimateMin: 30 })], base, today, { now: at15 });
  assert.equal(todayPlan.stats.availableMin, 180);
  assert.equal(todayPlan.stats.surplusMin, 150);

  const future = addDays(today, 1);
  const futurePlan = schedule([task({ date: future, estimateMin: 30 })], base, future, { now: at15 });
  assert.equal(futurePlan.stats.availableMin, 480);
  assert.equal(futurePlan.stats.surplusMin, 450);
});
