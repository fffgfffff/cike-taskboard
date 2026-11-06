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
    setQueue([]);
  }, [today]);

  useEffect(() => {
    if (state && state.settings.remindersOn === false) setQueue([]);
  }, [state]);

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
