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
