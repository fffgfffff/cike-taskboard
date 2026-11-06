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
