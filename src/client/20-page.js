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
          h('div', { className: 'tb-brand-title' }, '此刻'),
          h('div', { className: 'tb-brand-sub' }, '任务排程 · ' + dateLabel(viewDate, today) + ' ' + weekdayLabel(viewDate)),
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
