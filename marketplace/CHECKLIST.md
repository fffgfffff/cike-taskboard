# 市场提交检查清单

- [ ] 公开 GitHub 仓库已创建，且创建满 1 天
- [ ] 仓库含 `package.json` 的 `dsh.bundle.patch`，文件存在
- [ ] `cordis.patch.yml` 的 `name` 与包名一致
- [ ] 添加 topic `dsh-plugin`
- [ ] `data/plugins/<owner>__<repo>.yml` 的 URL 与仓库完全一致
- [ ] `category` 使用有效分类（本插件建议 `tools`）
- [ ] `description.en` 只有功能描述、没有营销词
- [ ] 描述里的功能都能在代码里找到（提醒、未来 7 天、虚拟时间轴、当前时间排程）
- [ ] `icon` 是 GitHub 托管的 PNG（本仓库 `docs/icon-180.png`）
- [ ] PR 只新增一个条目文件，不改 README、不改其他条目
- [ ] 仓库里没有本机数据、密钥、个人任务内容
- [ ] CI 通过，等待维护者 review
