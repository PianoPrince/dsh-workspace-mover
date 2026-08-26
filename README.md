# dsh-workspace-mover

**_> Unofficial project, independently developed and maintained by community members._**

> **DSH | Workspace Mover | 在侧边栏把会话拖拽到其他工作区，真迁移原始档案而非复制**

Project URL:
https://github.com/PianoPrince/dsh-workspace-mover

---

## 这是什么

DeepSeek Harness 的侧边栏支持在工作区内部拖拽排序会话，但把会话拖到**另一个工作区**上会被静默忽略——官方 RPC 只暴露了单工作区内的 `insertSessionBefore`，没有跨工作区移动接口。

本插件补上这块：

- **拖拽交互**：在侧边栏把任意空闲会话行拖到目标工作区的标题行上，弹确认框，一键迁移；
- **真迁移（True Move）**：物理搬移原始 `session.jsonl.zstd` 档案、改写头部 `cwd`、更新工作区注册表。会话 id 与全部历史**原样保留**，不产生副本、不重新注入上下文、**零 token 消耗**；
- **孤儿会话救援（v0.3，设置页「会话救援」面板）**：扫描磁盘上全部会话档案，分类出——
  - **失联（orphaned）**：项目文件夹被移动/改名/删除导致 cwd 失效、历史从侧边栏"消失"的会话（官方讨论 #3012 的社区修复），可一键真迁移到任意现有工作区；
  - **未记账（unregistered）**：cwd 仍有效但从未被任何工作区记账的会话（bootstrap 只跑一次、agent 内部 fork 不注册等），可原地补挂账；
  - **幽灵记账（ghosts）**：注册表有账但磁盘档案已缺失的 id（只读提示）。
  - 全部走同一条备份+回滚管线。
- **移动历史与撤回（v0.4）**：记录最近 100 次跨工作区移动，在设置页确认后可将会话安全移回原分组；撤回本身也会生成备份并复用回滚保护。
- **会话标题显示**：确认框、会话修复列表和最近移动记录优先显示会话标题，找不到标题时显示“未命名会话”。

## 与同类插件的对比

社区里已有多个"会话迁移"类插件，机制分三派。本插件是**「真迁移 + 安全兜底」**路线：

| 插件 | 交互 | 机制 | 会话 ID | 原件命运 | 数据安全 |
| --- | --- | --- | --- | --- | --- |
| **dsh-workspace-mover（本插件）** | 拖拽 | **物理搬移原始档案** | **原样保留** | 就是原件本身 | 强制备份(滚动20份) + 任一步失败自动回滚 + 常驻会话写路径修复 |
| dsh-session-move | 拖拽/菜单 | 物理搬移原始档案 + 删除/AI改名/Agent工具 | 保留 | 搬走 | 迁移前停掉运行中会话 |
| dsh-session-mover | 拖拽 | 目标处克隆完整历史 + 归档原件 | **新 ID** | 归档隐藏 | 平台限制声明（无法原地迁移） |
| dsh-move-session | 菜单 | 复制日志为新会话 | 新 ID | 保留或归档 | — |
| dsh-plugin-bridge | `/bridge` | 跨预设五段式交接摘要 | 新 ID | 不动 | 可预览可编辑 |

**选型建议**：要整理工作区归属、且在意会话 id 不变（子代理谱系、外部引用、`@` 引用不悬空）→ 用本插件；要在迁移之外顺带删除/重命名 → 看 dsh-session-move；要"两边都有"或跨预设 → 用复制类方案。

### 本插件的技术差异点

1. **常驻会话一致性修复**：打开过的会话在宿主内存里有冻结头与持久化写入缓存。直接搬文件会导致它下次对话时把新事件**写回旧路径**造成历史分叉——本插件迁移后清理陈旧写入状态并刷新注册表索引，宿主自动从新位置重新接管（同类插件未见处理此问题）。
2. **安全兜底**：每次移动前强制字节级备份；改写、搬运、记账任一步失败自动回滚到移动前状态。
3. **Windows 加固**：目录内刚发生文件改名后立刻改目录名会瞬时 EPERM——指数退避重试，仍失败退化为复制+删除。
4. **主题自适应 UI**：确认框/Toast 全部使用官方 `--dsw-alias-*` 设计令牌，跟随设置里的外观即时切换。
5. **零依赖免构建**：host 半零 npm 依赖，client 半 source-as-product，无构建产物漂移风险。

## 安装

```bash
dsh plugin --profile web add "github:PianoPrince/dsh-workspace-mover"
# 重启 dsh web 一次
```

> **零构建授权**：本插件是纯 JavaScript 源码即产物（无 TypeScript、无构建步骤），从 GitHub 安装时**不需要** `allowBuilds` 构建授权——pnpm 不会执行任何安装期脚本。

也可以从 npm 安装（发布后）：

```bash
dsh plugin --profile web add dsh-workspace-mover
```

本地开发安装：

```bash
dsh plugin --profile web add "link:E:/path/to/dsh-workspace-mover"
```

## 使用

1. 重启后在侧边栏**分组视图**里，按住任意空闲会话行；
2. 拖到目标工作区的标题行（出现虚线高亮）松手；
3. 确认框显示目标工作区路径 → 点「移动」；
4. 完成 toast 提示；若宿主广播未触发自动刷新，手动刷新页面即可。

运行中的会话会被拒绝（宿主端校验），移动失败自动回滚并在 toast 中说明原因。

## 与 DSH 的集成方式

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

## 安全设计

- 移动前强制备份；attach 失败自动回滚（撤销预置记账 → 还原索引 → 还原字节 + 清理目标 + 重新挂回源工作区）；
- 仅拒绝回合进行中的会话；常驻空闲会话迁移后修复写路径归属，杜绝历史分叉；
- 注册表/持久化内部访问全部包在 try/catch 中，失败降级为功能可用 + 重启建议提示；
- 兼容性目标：Node ≥ 22，dsh 0.1.1-rc.2；核心纯函数与端到端沙箱测试见 `npm test`（18 用例，含回滚路径、救援扫描/修复和历史撤回）。

## 使用：会话救援面板

1. 重启后打开 **设置 → 会话救援**，面板自动完成首次扫描；
2. **失联**行：选目标工作区 → 点「迁移过去」（真迁移，ID 保留）；
3. **未记账**行：点「补挂账」原地挂到路径匹配的工作区；
4. 每次操作前后都有备份与回滚保护，结果即时反馈。

## Screenshots

### Drag a session to another workspace

![Dragging a session to another workspace](docs/media/drag_session_to_another_workspace.png)

### Move confirmation

![Cross-workspace move confirmation](docs/media/confirm_popup.png)

### Session repair settings

![Session repair settings](docs/media/setting_dialogue_repair.png)

## 已知限制（v0.4.x）

- 不支持把会话移入「Ungrouped」桶；
- 目标行 ↔ 工作区的映射基于渲染顺序与 `workspace.list` 对齐，若第三方插件重排侧边栏结构需先刷新再拖；
- 「扁平列表」视图无工作区标题行，本插件在该视图不激活；
- 若宿主升级改变了注册表缓存字段名或实体结构，相关步骤走降级路径（功能可用，归属刷新可能需重启）。

## License

MIT
