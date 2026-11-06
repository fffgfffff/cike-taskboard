# PR 文案（替换 OWNER/REPO 后直接提交）

## Title

Add 此刻 · 任务排程 (OWNER/REPO)

## Body

This PR adds one entry for **此刻 · 任务排程**, a local-first task scheduler for DSH.

- Repo: https://github.com/OWNER/REPO
- Category: `tools`
- What it does: schedules today's tasks from the current time; splits long tasks around lunch; highlights the current task; shows in-app reminders at task start and before the next task; adds a 7-day calendar and an exportable/importable virtual timeline.
- Data stays local (`~/.dsh/dsh-taskboard/state.json`); no network calls.
- `package.json` declares `dsh.bundle.patch` + `dsh.client`; `cordis.patch.yml` is included.
- Repo has the `dsh-plugin` topic and is more than one day old.

Entry file: `data/plugins/OWNER__REPO.yml`

```yaml
url: https://github.com/OWNER/REPO
name: OWNER/REPO
category: tools
description:
  en: 'Local-first task scheduler for DSH. Schedules today''s tasks from the current time, splits long tasks around lunch, highlights the current task live, reminds at task start and before the next task, and adds a 7-day calendar plus an exportable virtual timeline.'
  zh: 'DSH 本地任务排程：今天的自动任务从当前时间开始排，长任务自动绕午休分段，实时高亮当前任务；任务开始和下个任务前弹窗提醒；支持未来 7 天日历与可导出/导入的虚拟时间轴。'
icon: https://raw.githubusercontent.com/OWNER/REPO/main/docs/icon-180.png
```

No README edits; only the one YAML file.
