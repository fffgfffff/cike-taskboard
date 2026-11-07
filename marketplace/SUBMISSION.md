# 此刻 · 任务排程 — 提交到 DSH 插件市场

## 现状

- **代码已上传公开仓库**：<https://github.com/fffgfffff/cike-taskboard>
- **市场条目已提交 PR**：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12912>
- PR 只新增 `data/plugins/fffgfffff__cike-taskboard.yml`，内容检查全部通过。
- 当前 CI 的 **Build** 步骤红：原因是上游 `data/screenshots.json` 还留着 `Ultronen/...` 改名前的两个 key（条目已改成 `Ultroncn/...`），与本插件条目无关；已在 PR 里留言请维护者修数据/重跑。
- 合并后市场会自动收录，通常一天内生效。

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

## 后续

PR 已提交（#12912）。等上游修掉 `screenshots.json` 的旧 key 或维护者重跑后，CI 转绿；合并后市场自动收录。若需要，我可以再开一个只改 `data/screenshots.json` 的小 PR 来解除这个上游阻塞。

