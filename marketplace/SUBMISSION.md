# 此刻 · 任务排程 — 提交到 DSH 插件市场

## 现状

**尚未真正上架。** 这不是代码问题，而是市场机制 + 本机凭证：

- DSH 插件市场（`dsh-market`）本身**不接收上传**；
- 它的列表来自 [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的 `data/plugins/*.yml`；
- 上架 = **一个公开 GitHub 仓库 + 一个 PR**；
- 当前机器：没有 `gh`、没有 GitHub Token、`npm whoami` 未登录、没有远端 git 仓库。
  因此无法代替你创建公开仓库或提 PR。

代码、教程、图标、提交模板已经准备好，只差一个公开仓库和一次 PR。

---

## 已经准备好的东西

| 文件 | 用途 |
|---|---|
| `使用教程.md` | 用户教程 |
| `docs/icon-180.png` | 市场卡片图标（180×180 PNG） |
| `marketplace/entry.template.yml` | awesome-dsh-plugin 条目模板 |
| `package.json` | 已声明 `dsh.bundle` + `dsh.client`，可安装 |
| `lib/` | 预构建产物，安装免构建 |
| `使用教程.md` / `README.md` / `SECURITY.md` / `CHANGELOG.md` | 商店详情素材 |

---

## 上架步骤（需要你提供公开仓库）

### 1. 建公开仓库

建议仓库名：`cike-taskboard`（或 `dsh-cike`）。  
把本目录推到 `https://github.com/<你的账号>/cike-taskboard`，然后：

- 仓库 **创建满 1 天**（市场 CI 硬性检查）；
- 添加 topic：`dsh-plugin`；
- 确认 `package.json` 的 `dsh.bundle.patch` 和 `cordis.patch.yml` 存在（已满足）。

### 2. 改提交模板

把 `marketplace/entry.template.yml` 复制为：

```text
data/plugins/<owner>__<repo>.yml
```

并替换 `OWNER/REPO` 为真实仓库；描述保持属实，不要加营销词。

### 3. Fork + PR

```text
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
```

- Fork；
- 只添加**一个** YAML 文件（不要改 README，README 由脚本生成）；
- 提 PR，标题例：`Add 此刻 · 任务排程 (cike-taskboard)`；
- CI 通过后维护者会读源码；合并后站点和市场自动收录，通常一天内生效。

### 4. 可选：发 npm（安装更快）

`dsh-taskboard` 这个名字在 npm 上已被其他包占用（0.9.11），**不要覆盖**。  
可发布为：

- `dsh-cike`（本机检查时可用），或
- `@<你的scope>/dsh-taskboard`。

发布前把 `package.json` 的 `name` 改成发布名，并同步 `cordis.patch.yml` 的 `name`；然后用：

```powershell
npm login
npm publish --access public
```

如果暂不发 npm，用 GitHub 源码安装也可以：

```powershell
dsh plugin --profile desktop add github:<owner>/<repo>
```

---

## 需要你提供

1. 一个公开 GitHub 仓库地址（或允许我创建仓库的 Token）；
2. 如果要发 npm：npm Token（不要发在聊天里，登录本机即可）；
3. 仓库 owner/repo 名称，我就能把 YAML 填成最终版并给出可直接提交的 PR 内容。

> 市场收录不等于安全审计。提交前请确认仓库里没有本机数据、密钥、个人任务内容。
