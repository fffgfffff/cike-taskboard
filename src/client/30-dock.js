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
        h(PriorityBadge, { priority: task.priority }),
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
      const top = Math.max(DOCK_SAFE_TOP, Math.min(drag.layerH - drag.cardH - 4, drag.startTop + drag.dy));
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
  let top = Math.max(DOCK_SAFE_TOP, Math.min(layerH - cardH - 8, prefs.top || 92));
  if (drag && drag.moved) {
    left = Math.max(4, Math.min(layerW - cardW - 4, drag.startLeft + drag.dx));
    top = Math.max(DOCK_SAFE_TOP, Math.min(layerH - cardH - 4, drag.startTop + drag.dy));
  }

  const stripTop = Math.max(DOCK_SAFE_TOP - 10, Math.min(layerH - 176, prefs.top || 92));

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
        ? { left: inset, top: Math.max(DOCK_SAFE_TOP - 12, stripTop - 10), width: 60, height: 176 }
        : { right: inset, top: Math.max(DOCK_SAFE_TOP - 12, stripTop - 10), width: 60, height: 176 };
    const railStyle =
      prefs.side === 'left'
        ? { left: 0, top: Math.max(DOCK_SAFE_TOP - 12, stripTop - 10), width: inset, height: 156 }
        : { right: 0, top: Math.max(DOCK_SAFE_TOP - 12, stripTop - 10), width: inset, height: 156 };
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
