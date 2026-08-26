# 发布全流程（dsh-workspace-mover）

> 对齐三份规范：
> ① 官方《打包与安装插件》（docs/user/develop/basic/publish.zh.md）
> ② 官方 Show Your Plugins 版规（discussion #2004）
> ③ 市场识别层 STANDARD（discussion #2269，各市场据此自动收录）

## 本插件的合规现状（已就绪 ✓）

| 要求 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle.patch` → `./cordis.patch.yml` | ✓ |
| patch 行按**包名**引用（`name: 'dsh-workspace-mover'`），非相对路径 | ✓ |
| `files` 数组包含 `cordis.patch.yml`（缺失 = 层不生效，官方文档点名的头号坑） | ✓ |
| `main` / `exports` / `type:module` / `version` | ✓ |
| `keywords` 含 `dsh-plugin` + `deepseek-harness`（目录爬虫依据） | ✓ |
| `description` / `license`(MIT) / `repository` | ✓（repository 待填用户名） |
| 纯 JS 源码即产物，**无 prepare/build 脚本** → GitHub 安装免 `allowBuilds` 授权 | ✓ |
| 根目录无 install.ps1/install.sh（防被市场误判为脚本型） | ✓ |
| 客户端导出 `{inject, apply}`；宿主导出 `{name, inject, apply}` | ✓ |
| GitHub Actions 跨平台测试（.github/workflows/test.yml，Node 22/24 × Win/Linux） | ✓ |

---

## 第 0 步：仓库准备（一次性）

1. 确认以下文件使用正确的 GitHub 用户名 `PianoPrince`：
   - `package.json`（repository.url）
   - `README.md`（安装命令、项目地址）
   - `PUBLISH.md`（本文件）
2. `LICENSE` 里 `dsh-workspace-mover contributors` 可改成你的名字。
3. 截图已放入 `docs/media/` 并已在 README 引用；如有条件可再补充 GIF：
   - 拖拽会话行 → 目标标题行虚线高亮 → 确认框 → 成功 toast
   - 设置 → 会话修复 面板操作一段
   - 深色模式各来一张（展示主题自适应）
   - 工具推荐：ScreenToGif（Win）/ Kap（mac），宽 ≤ 800px

## 第 1 步：创建 GitHub 仓库并推送

```bash
cd E:\DeepSeekHarness\dsh-workspace-mover
git init
git add -A
git commit -m "dsh-workspace-mover v0.4.0: true move, session repair, and undo history"
# 在 GitHub 网页创建空仓库 dsh-workspace-mover（不要初始化 README）
git remote add origin https://github.com/PianoPrince/dsh-workspace-mover.git
git push -u origin main
```

**打 topic（关键！各市场每 2 小时按它自动收录）**：

仓库页 → About ⚙ → Topics 添加：

```
dsh-plugin   deepseek-harness   cordis   dsh   session-manager
```

**打版本 tag**（市场更新检测靠它）：

```bash
git tag v0.4.0
git push origin v0.4.0
```

## 第 2 步：验证 GitHub 渠道安装

找台干净环境（或先 `dsh plugin --profile web remove dsh-workspace-mover`）：

```bash
dsh plugin --profile web add "github:PianoPrince/dsh-workspace-mover"
# 预期：无需 allowBuilds 授权，直接装好
# 重启 dsh web → 拖拽迁移 + 设置页「会话修复」都可用
```

## 第 3 步（可选但推荐）：发布到 npm

npm 渠道用户安装零授权、零网络意外，且多一个被发现的入口：

```bash
# 没有 npm 账号先去 npmjs.com 注册，然后本地登录
npm login
# 包名 dsh-workspace-mover 未被占用即可直接发（files 数组已控制发布内容）
npm publish
```

发布后用户：`dsh plugin --profile web add dsh-workspace-mover`

## 第 4 步：发官方讨论帖（Show Your Plugins 版块）

版规（#2004）：一个帖子一个项目；标题格式 `DSH｜项目名｜一句话说明`；正文含项目地址、简介、截图、集成方式；显著注明非官方。

**标题**：

```
DSH | dsh-workspace-mover | 侧边栏拖拽跨工作区真迁移会话：保 ID、零副本、自动备份回滚，附会话修复面板
```

**正文**（直接复制，填上用户名和图）：

---

**_> 非官方项目，由社区成员独立开发和维护。_**

**项目地址**：https://github.com/PianoPrince/dsh-workspace-mover

**项目介绍**：

在侧边栏把任意空闲会话**拖到另一个工作区的标题行**即完成迁移——物理搬移原始档案、改写头部 cwd、更新注册表。与克隆类方案不同，这是**真迁移**：会话 ID 与全部历史原样保留，不产生副本、零 token 消耗，子代理谱系与外部引用不悬空。

- **会话修复面板**（设置 → 会话修复）：一键找回因文件夹移动/改名而在侧边栏"消失"的会话（#3012），以及从未归组的历史会话
- 每次操作前自动字节级备份（滚动 20 份），任一步失败**自动回滚**
- 打开过但已空闲的会话也能安全迁移（修复了常驻会话写路径分叉问题）
- 界面用官方设计令牌，浅色/深色即时跟随
- 零 npm 依赖、免构建：GitHub 安装无需 allowBuilds 授权；18 个测试通过

**与同类插件的关系**：dsh-session-mover（克隆+归档，ID 会变）、dsh-session-move（真迁移+删除/AI改名工具集）、dsh-move-session（复制为新会话）。本项目专注做**最小而可靠的原地迁移 + 数据修复**，选型对比表见 README。

**如何与 DSH 集成**：标准双面插件——host 半经 `cordis.patch.yml` 挂载，`connection.rpc.handle('/workspace-mover')` 注册 RPC，进程内调用 workspaceRegistry 公开方法完成记账；client 半免构建注入，仅依赖 ARIA 语义属性定位行元素，不干扰官方同组排序。

**截图**：（贴 GIF）

---

## 第 5 步：确认 dsh-market 收录

`dsh-market` 不接受直接上传插件条目。它读取精选仓库 [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的数据；需要向该仓库提交一个 PR，合并后市场自动更新。

### 创建市场收录 PR

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`。
2. 新建分支，例如 `add-dsh-workspace-mover`。
3. 新增文件：

```text
data/plugins/PianoPrince__dsh-workspace-mover.yml
```

内容：

```yaml
url: https://github.com/PianoPrince/dsh-workspace-mover
name: PianoPrince/dsh-workspace-mover
category: session
description:
  en: Safely move DSH sessions between workspaces while preserving session IDs and history.
  zh: 在 DSH 工作区之间安全迁移会话，保留会话 ID 和完整历史。
```

4. 确认插件仓库满足收录条件：
   - `package.json` 声明 `dsh.bundle`；
   - 仓库公开且至少创建 1 天；
   - 至少 10 个提交；
   - GitHub 仓库设置了 `dsh-plugin` topic；
   - 描述只写事实，不使用夸张宣传语。
5. 提交 PR。该仓库要求一个插件只新增一个 YAML 文件，不要手工修改生成的 README。

市场会从插件仓库根目录的 `screenshots.json` 读取截图。当前项目已配置三张图片，路径均为仓库内相对路径。

### 收录后验证

合并后等待市场网站或 CI 更新，通常不需要再次修改插件仓库。验证：

- 在 dsh-market 搜索 `dsh-workspace-mover`；
- 打开详情页，确认三张截图显示；
- 确认安装源指向 GitHub 仓库；
- 从市场安装后重启 DSH，验证拖拽、会话修复和撤回。

| 市场 | 验证方式 |
| --- | --- |
| DSH-Plugins-Marketplace（bradeGithub） | 在其目录站搜 "workspace-mover" |
| dsh-market | 搜索 `dsh-workspace-mover`；若未出现，检查 topic、公开仓库、package.json 的 `dsh` 字段和 tag |
| dsh-plugin.shop / dsh-plugin-hub 等 | 同上；若某家没收录，去其仓库 issue 提交 |
| awesome-dsh-plugin | 可提 PR 收录 |

## 日常发版纪律（市场更新检测依赖）

1. 改代码 → `package.json` **必须 bump version**（否则各市场更新检测失效）
2. `git tag v0.x.y && git push origin v0.x.y`
3. 若发了 npm：`npm version patch && npm publish`
4. 不要在根目录新增 install.ps1/install.sh（会被市场误判为脚本型插件）
5. 不要改包名（撞名会被目录隐藏）

## 反模式自查（来自 STANDARD.md 真实排障案例）

- [ ] 根目录没有 install 脚本 ✓
- [ ] cordis.patch.yml 在 files 数组里 ✓
- [ ] patch 行 name 与 package.json name 完全一致 ✓
- [ ] 插件不自带 cordis 补丁去改官方行（避免双加载）✓
- [ ] 简介里避免与功能无关的宣传词（影响市场分类）✓
