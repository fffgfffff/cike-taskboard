/* ==========================================================================
 * dsh-taskboard · 浏览器半侧：注册进 DSH 插槽
 *
 * 三个席位：
 *   sidebar.panellist → 左侧栏「任务排程」图标；
 *   main              → 点图标后的完整面板（key 必须与 panellist 的 id 相同）；
 *   shell.overlay     → 贴边悬浮小窗，跨面板常驻。
 * ========================================================================== */

function TaskboardIcon(props) {
  const size = (props && props.size) || 16;
  const active = !!(props && props.active);
  return h(
    'span',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: active ? 'var(--dsw-alias-brand-primary,#5b7cfa)' : 'currentColor',
      },
    },
    h(IconTaskboard, { size }),
  );
}

function apply(ctx) {
  appContext = ctx;
  ensureBoardStyles();

  // 完整面板：侧边栏图标与 main 的 key 必须是同一个 id。
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: 'taskboard', locale: 'common' }, TaskboardPage),
  );

  // 左侧栏入口（order 与「自动化任务」相邻）。
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'taskboard',
        order: 12,
        label: () => '此刻 · 任务排程',
      },
      TaskboardIcon,
    ),
  );

  // 贴边小窗：跨面板常驻，可收起成细条。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'taskboard-dock', order: 80 }, TaskboardDock),
  );

  // 到点提醒：与视图无关，挂在 shell.overlay 上。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'taskboard-reminders', order: 70 }, TaskboardReminders),
  );
}

const moduleExports = { name: 'taskboard', inject: ['slots'], apply };

// 诊断/冒烟测试用：不参与 DSH 插槽，也不被界面引用。
moduleExports.__internals = {
  TaskboardPage,
  TaskboardDock,
  TaskEditor,
  SettingsDialog,
  HistoryDialog,
  CalendarDialog,
  VirtualDialog,
  TaskboardReminders,
  TaskboardIcon,
  QuickAdd,
  Timeline,
  boardStore,
  readDockPrefs,
  setDockVisibility,
  returnToConversation,
};

return moduleExports;
