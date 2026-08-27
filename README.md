# dsh-workspace-mover

**_> 非官方项目，由社区成员独立开发和维护。_**

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">在侧边栏把会话拖到另一个工作区——真迁移原始档案，而不是复制</b><br /><br />
  <a href="https://github.com/PianoPrince/dsh-workspace-mover/actions/workflows/test.yml"><img alt="CI" src="https://github.com/PianoPrince/dsh-workspace-mover/actions/workflows/test.yml/badge.svg" /></a>
  <a href="https://github.com/PianoPrince/dsh-workspace-mover/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/PianoPrince/dsh-workspace-mover" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522-339933" />
  <img alt="npm 依赖：0" src="https://img.shields.io/badge/npm%20%E4%BE%9D%E8%B5%96-0-4d6bfe" /><br /><br />
  <img alt="真迁移" src="https://img.shields.io/badge/-真迁移-4d6bfe" /> <img alt="零 token 消耗" src="https://img.shields.io/badge/-零%20token%20消耗-4d6bfe" /> <img alt="备份回滚" src="https://img.shields.io/badge/-备份回滚-4d6bfe" /> <img alt="孤儿会话救援" src="https://img.shields.io/badge/-孤儿会话救援-4d6bfe" /> <img alt="一键撤回" src="https://img.shields.io/badge/-一键撤回-4d6bfe" /> <img alt="主题自适应" src="https://img.shields.io/badge/-主题自适应-4d6bfe" />
</div>

<div align="center">
  <img alt="把一个会话拖到另一个工作区完成迁移" src="docs/media/drag_session_to_another_workspace.png" width="100%" />
</div>

## 📑 目录

- [✨ 功能一览](#-功能一览)
- [🔬 技术要点](#-技术要点)
- [🚀 安装](#-安装)
- [🖼️ 特性巡礼](#️-特性巡礼)
- [⌨️ 使用](#️-使用)
- [🔌 与 DSH 的集成方式](#-与-dsh-的集成方式)
- [🆕 最近更新](#-最近更新)
- [🔐 安全设计](#-安全设计) · [⚠️ 已知限制](#️-已知限制)

---

## ✨ 功能一览

DeepSeek Harness 的侧边栏支持工作区内拖拽排序会话，但把会话拖到**另一个工作区**上会被静默忽略——官方 RPC 只暴露了单工作区内的 `insertSessionBefore`，没有跨工作区移动接口。本插件补上这块：

- **🖱️ 拖拽交互**：把任意空闲会话行拖到目标工作区的标题行，确认框亮出目标路径，一键迁移
- **🚚 真迁移**：物理搬移原始 `session.jsonl.zstd` 档案、改写头部 `cwd`、更新工作区注册表——会话 id 与全部历史**原样保留**，不产生副本、不重新注入上下文、**零 token 消耗**
- **🛟 孤儿会话救援**（设置页「会话救援」面板）：扫描磁盘上全部会话档案并分类处理——
  - **失联（orphaned）**：项目文件夹被移动/改名/删除导致 cwd 失效、从侧边栏"消失"的会话（官方讨论 #3012 的社区修复），可一键真迁移到任意现有工作区
  - **未记账（unregistered）**：cwd 仍有效但从未被任何工作区记账的会话（bootstrap 只跑一次、agent 内部 fork 不注册等），可原地补挂账
  - **幽灵记账（ghosts）**：注册表有账但磁盘档案已缺失的 id（只读提示）
  - 三类全部走同一条备份+回滚管线
- **⏪ 移动历史与撤回**：记录最近 100 次跨工作区移动，设置页一键移回原分组，撤回本身同样生成备份并复用回滚保护
- **🏷️ 会话标题优先**：确认框、救援列表和最近移动记录都先显示会话标题，找不到标题时显示「未命名会话」

## 🔬 技术要点

1. **常驻会话一致性修复**：打开过的会话在宿主内存里有冻结头与持久化写入缓存。直接搬文件会导致它下次对话时把新事件**写回旧路径**造成历史分叉——本插件迁移后清理陈旧写入状态并刷新注册表索引，宿主自动从新位置重新接管。
2. **安全兜底**：每次移动前强制字节级备份；改写、搬运、记账任一步失败自动回滚到移动前状态。
3. **Windows 加固**：目录内刚发生文件改名后立刻改目录名会瞬时 EPERM——指数退避重试，仍失败退化为复制+删除。
4. **主题自适应 UI**：确认框/Toast 全部使用官方 `--dsw-alias-*` 设计令牌，跟随设置里的外观即时切换。
5. **零依赖免构建**：host 半零 npm 依赖，client 半 source-as-product，无构建产物漂移风险。

## 🚀 安装

```bash
dsh plugin --profile web add "github:PianoPrince/dsh-workspace-mover"
# 重启 dsh web 一次
```

> **零构建授权**：本插件是纯 JavaScript 源码即产物（无 TypeScript、无构建步骤），从 GitHub 安装时**不需要** `allowBuilds` 构建授权——pnpm 不会执行任何安装期脚本。

<details>
<summary><b>npm 渠道</b></summary>

```bash
dsh plugin --profile web add dsh-workspace-mover
```

</details>

<details>
<summary><b>本地开发安装</b></summary>

```bash
dsh plugin --profile web add "link:E:/path/to/dsh-workspace-mover"
```

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 拖了但没反应 | 只在「分组视图」把会话行投到**工作区标题行**上才会触发；「扁平列表」视图没有标题行，本插件在该视图不激活 |
| 提示会话正在运行中 | 宿主端校验回合状态；等该会话回合结束再拖即可 |
| 移动失败的 toast | 每次操作前都有字节级备份、失败自动回滚；按 toast 说明处理后重试，详细原因见宿主日志中的 `MOVE FAILED` 条目 |
| 移动成功但侧边栏没归位 | 插件迁移后会主动重拉一次工作区基线；偶发未生效时手动刷新页面 |
| 有些会话从侧边栏不见了 | 打开 **设置 → 会话救援** 自动扫描，「失联」「未记账」两类都能一键找回 |

</details>

## 🖼️ 特性巡礼

> 以下均为真实界面实拍（点击可放大）。

| | |
|---|---|
| **把空闲会话行拖到目标工作区标题行，出现虚线高亮** | **确认框亮出目标工作区路径，一键移动** |
| ![把一个会话拖到另一个工作区](docs/media/drag_session_to_another_workspace.png) | ![跨工作区移动确认框](docs/media/confirm_popup.png) |
| **设置 → 会话救援：一键找回失联与未记账的会话** | |
| ![会话救援设置面板](docs/media/setting_dialogue_repair.png) | |

## ⌨️ 使用

### 拖拽跨工作区迁移

1. 重启后在侧边栏**分组视图**里，按住任意空闲会话行；
2. 拖到目标工作区的标题行（出现虚线高亮）松手；
3. 确认框显示目标工作区路径 → 点「移动」；
4. 完成 toast 提示；若宿主广播未触发自动刷新，手动刷新页面即可。

运行中的会话会被拒绝（宿主端校验），移动失败自动回滚并在 toast 中说明原因。

### 会话救援面板

1. 重启后打开 **设置 → 会话救援**，面板自动完成首次扫描；
2. **失联**行：选目标工作区 → 点「迁移过去」（真迁移，ID 保留）；
3. **未记账**行：点「补挂账」原地挂到路径匹配的工作区；
4. 每次操作前后都有备份与回滚保护，结果即时反馈。

## 🔌 与 DSH 的集成方式

- **Host 半**（`lib/index.js`，零 npm 依赖）：经 `cordis.patch.yml` 以标准 `insert` 行挂载；通过 `ctx.connection.rpc.handle('/workspace-mover', …)` 注册逻辑通道，端点 `mover.status / mover.workspaces / mover.move / mover.scan / mover.repair / mover.history / mover.undo`，失败详情写入宿主日志（`MOVE FAILED`）。
- **移动算法**：
  1. 运行状态检查：仅拒绝回合进行中的会话（`agents.get(id)?.status === 'running'`，与宿主 UI"进行中"徽标同款判据）；常驻内存但空闲的会话允许迁移；
  2. 从磁盘读取权威会话头，校验目标 ≠ 源；
  3. 原始字节备份到 `$DSH_HOME/workspace-mover/backups/`（每会话保留最近 20 份）；
  4. 仅重写首帧（头部 cwd），其余帧字节级保留；临时文件 + 原子改名发布；
  5. 会话目录整体搬移（Windows 目录改名怪癖：指数退避重试，仍失败退化为复制+删除）；
  6. 内存一致性收尾：失效注册表三张索引；常驻会话额外清理持久化协调器的陈旧写入状态、刷新索引并预置目标记账（绕开冻结头的旧 cwd 校验）；
  7. 调用目标实体 `attachSession` 持久化记账，源实体已先行 `detachSession`；
  8. 任一步失败自动回滚：撤销预置 → 还原索引快照 → 原件放回源目录 → 重新挂回源工作区。
- **Client 半**（`client/client.js`，免构建 source-as-product）：仅依赖 ARIA 语义属性定位行元素（会话行 `[aria-selected]` / 工作区标题行 `[aria-expanded]`），不碰 CSS-module 哈希类名；只拦截「跨组投放」场景，官方同组排序不受影响。迁移成功后主动重拉一次工作区基线（公开 API），侧边栏分组即时归位。
- **救援面板**：经官方 `settings.section` 插槽注册设置页分栏，RPC 端点 `mover.scan`（分类扫描）与 `mover.repair`（批量 attach/relink，relink 复用同一条迁移管线）。
- **迁移历史**：保存于 `$DSH_HOME/workspace-mover/history.json`，最多保留最近 100 条；原工作区仍存在时可直接撤回，原工作区已删除时会明确要求重新选择目标分组。

## 🆕 最近更新

### v0.4.0 · 2026-08-26

- 移动历史与一键撤回：保存最近 100 条跨工作区移动记录（`mover.history` / `mover.undo` 端点），设置页确认后移回原分组，撤回同样受备份与回滚保护
- 确认框、救援列表与移动记录优先显示会话标题

### v0.3.2

- 孤儿会话救援：磁盘全量扫描、失联会话真迁移、未记账会话补挂账，全程回滚保护

## 🔐 安全设计

- 移动前强制备份；attach 失败自动回滚（撤销预置记账 → 还原索引 → 还原字节 + 清理目标 + 重新挂回源工作区）；
- 仅拒绝回合进行中的会话；常驻空闲会话迁移后修复写路径归属，杜绝历史分叉；
- 注册表/持久化内部访问全部包在 try/catch 中，失败降级为功能可用 + 重启建议提示；
- 兼容性目标：Node ≥ 22，dsh 0.1.1-rc.2；核心纯函数与端到端沙箱测试见 `npm test`（18 用例，含回滚路径、救援扫描/修复和历史撤回）。

## ⚠️ 已知限制

- 不支持把会话移入「Ungrouped」桶；
- 目标行 ↔ 工作区的映射基于渲染顺序与 `workspace.list` 对齐，若第三方插件重排侧边栏结构需先刷新再拖；
- 「扁平列表」视图无工作区标题行，本插件在该视图不激活；
- 若宿主升级改变了注册表缓存字段名或实体结构，相关步骤走降级路径（功能可用，归属刷新可能需重启）。

## License

MIT
