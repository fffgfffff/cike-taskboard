# 此刻 · 任务排程 — 提交到 DSH 插件市场

## 现状

- **代码已上传公开仓库**：<https://github.com/fffgfffff/cike-taskboard>
- **市场条目尚未提交**：仓库创建于 2026-11-06，`awesome-dsh-plugin` 要求仓库创建满 **1 天**，明天才能过 CI。
- 提交模板已填好真实 URL：`marketplace/entry.template.yml`。
- 提交路径：Fork `awesome-dsh-plugin/awesome-dsh-plugin`，添加
  `data/plugins/fffgfffff__cike-taskboard.yml`，提 PR。

仓库已加 topics：`dsh-plugin`、`dsh`、`taskboard`、`todo`、`productivity`。

---

## 上架步骤

### 1. 仓库（已完成）

- 公开仓库：https://github.com/fffgfffff/cike-taskboard
- `package.json` 已声明 `dsh.bundle.patch` + `dsh.client`
- `cordis.patch.yml` 已包含
- 仓库满 1 天后提交（创建于 2026-11-06）

### 2. 添加条目文件

在 awesome-dsh-plugin fork 中添加：

```text
data/plugins/fffgfffff__cike-taskboard.yml
```

内容直接复制 [entry.template.yml](entry.template.yml)。

### 3. 提 PR

- 只添加这一个 YAML 文件；
- 不要手工改 README（由脚本生成）；
- 标题和正文见 [PR_BODY.md](PR_BODY.md)；
- CI 通过后维护者会读源码，合并后市场自动收录。

### 4. 可选：发 npm

`dsh-taskboard` 在 npm 上已被其他包占用（0.9.11），不要覆盖。可发布为 `dsh-cike` 或 `@<scope>/dsh-taskboard`；发布前把 `package.json` 的 `name` 和 `cordis.patch.yml` 的 `name` 一起改掉。

---

## 为什么不能现在直接提 PR

`awesome-dsh-plugin` 的 CI 会检查目标仓库创建时间 ≥ 1 天；本仓库是刚创建的，现在提会直接被 CI 拒绝。等满 1 天后复制条目文件提交即可。

