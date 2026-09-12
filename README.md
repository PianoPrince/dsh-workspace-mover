# dsh-workspace-mover

**_> 非官方项目，由社区成员独立开发和维护。_**

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">在侧边栏把会话拖到另一个工作区——真迁移原始档案，而不是复制</b><br /><br />
  <p style="font-size: 0; line-height: 1;">
    <a href="https://github.com/PianoPrince/dsh-workspace-mover/actions/workflows/test.yml"><img alt="CI" src="https://github.com/PianoPrince/dsh-workspace-mover/actions/workflows/test.yml/badge.svg" style="height:20px; margin:0 2px;" /></a>
    <a href="https://github.com/PianoPrince/dsh-workspace-mover/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/PianoPrince/dsh-workspace-mover" style="height:20px; margin:0 2px;" /></a>
    <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" style="height:20px; margin:0 2px;" /></a>
    <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522-339933" style="height:20px; margin:0 2px;" />
    <img alt="npm 依赖：0" src="https://img.shields.io/badge/npm%20%E4%BE%9D%E8%B5%96-0-4d6bfe" style="height:20px; margin:0 2px;" />
    <a href="https://awesome-dsh-plugin.com"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg" style="height:20px; margin:0 2px;" /></a>
  </p>
  <p style="font-size: 0; line-height: 1;">
    <img alt="真迁移" src="https://img.shields.io/badge/-真迁移-4d6bfe" style="height:20px; margin:0 2px;" />
    <img alt="零 token 消耗" src="https://img.shields.io/badge/-零%20token%20消耗-4d6bfe" style="height:20px; margin:0 2px;" />
    <img alt="备份回滚" src="https://img.shields.io/badge/-备份回滚-4d6bfe" style="height:20px; margin:0 2px;" />
    <img alt="GitHub clones observed（含 unique）" src="https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2FPianoPrince%2Fc14345658550a4a308570acfbaf9d170%2Fraw%2Fwsm-clones-total.json" style="height:20px; margin:0 2px;" />
    <!-- release-downloads-badge:start --><!-- release-downloads-badge:end -->
  </p>
</div>

<div align="center">
  🌏 中文 · <a href="./README_EN.md">English</a>
</div>

## 📑 目录

- [✨ 功能](#-功能)
- [🚀 安装](#-安装)
- [🖼️ 特性巡礼](#️-特性巡礼)
- [⌨️ 使用](#️-使用)
- [🔌 如何接入 DSH](#-如何接入-dsh)
- [🤝 与其他插件共存](#-与其他插件共存)
- [🧩 兼容性与卸载](#-兼容性与卸载)
- [🔐 安全承诺](#-安全承诺)
- [⚠️ 已知限制](#️-已知限制)
- [🆕 最近版本](#-最近版本)

---

## ✨ 功能

DeepSeek Harness 侧边栏可以拖拽排序**同一工作区**内的会话，但拖到**另一个工作区**上会被静默忽略。本插件补上跨工作区迁移：

- **🖱️ 拖拽迁移**：把空闲会话行拖到目标工作区标题行，确认后完成移动
- **📦 批量迁移 / 分组合并**：Ctrl/Shift 多选后整批拖移，或用组标题「⋯」菜单「整组迁移…」；源分组清空后可一键删除，两条命令完成合并（单批至多 50 个，失败互不牵连）
- **🚚 真迁移 · 零 token**：会话 ID 与完整历史原样保留，不复制副本、不重新注入上下文
- **🏠 工作区搬家向导**：项目文件夹被移动/改名后，一键把失效分组原地重定向到新位置；id、标题、排序、归档位保持，名下会话连同旧路径散件一起迁移
- **🛟 会话救援**（设置 → 会话救援）：一键找回「失联」「未记账」「挂错分组」的会话；已归档会话可恢复；支持一键修复与筛选
- **🗑️ 回收站与备份**：删除先进回收站，可还原到原位置或任意分组；迁移自动生成备份，可按会话恢复或清理
- **⏪ 移动历史与撤回**：记录最近 100 次跨工作区移动，批量聚合为一条，整批可一键撤回
- **📂 空分组清理 / 打开文件夹**：只列出真正零成员的工作区；组菜单可直达系统文件管理器

## 🚀 安装

```bash
dsh plugin --profile web add "github:PianoPrince/dsh-workspace-mover"
# 重启 dsh web 一次
```

> **零构建授权**：纯 JavaScript 源码即产物（无 TypeScript、无构建步骤）。从 GitHub 安装时**不需要** `allowBuilds` 构建授权。

<details>
<summary><b>npm 渠道</b></summary>

```bash
dsh plugin --profile web add dsh-workspace-mover
```

</details>

<details>
<summary><b>本地开发安装</b></summary>

```bash
dsh plugin --profile web add "link:C:/path/to/dsh-workspace-mover"
```

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 拖了但没反应 | 请在**分组视图**把会话行拖到**工作区标题行**；「扁平列表」视图没有标题行，本插件在该视图不激活 |
| 提示会话正在运行中 | 等该会话回合结束再拖即可 |
| 移动失败的 toast | 操作前有自动备份、失败会回滚；按提示处理后重试。详细原因见宿主日志中的 `MOVE FAILED` |
| 移动成功但侧边栏没归位 | 刷新页面即可 |
| 有些会话从侧边栏不见了 | 打开 **设置 → 会话救援** 自动扫描并找回 |

</details>

## 🖼️ 特性巡礼

> 以下均为真实界面实拍（点击可放大）。

### 拖拽跨工作区迁移

| | |
|---|---|
| **把空闲会话行拖到目标工作区标题行，出现虚线高亮** | **确认框亮出目标工作区路径，一键移动** |
| ![把一个会话拖到另一个工作区](docs/media/drag_session_to_another_workspace.png) | ![跨工作区移动确认框](docs/media/confirm_popup.png) |
| **设置 → 会话救援：一键找回失联与未记账的会话** | |
| ![会话救援设置面板](docs/media/setting_dialogue_repair.png) | |

### 批量迁移 · 多选拖拽

| |
|---|
| **Ctrl+点击选中多个会话（当前打开的会话自动带上），左下角亮出计数徽章；拖到目标工作区标题行即整批移动，Esc 清空** |
| ![批量移动选中时：三个会话高亮，左下角显示已选计数徽章](docs/media/batch_move_selection.png) |
| **组标题「⋯」菜单里的「整组迁移…」：整组搬移，迁入后可删除已空的源分组（分组合并）** |
| ![组标题菜单中的整组迁移入口](docs/media/workspace_move.png) |

### 工作区搬家向导 · 实测全程

以下为一次真实搬家的完整记录：把 `Test1` 文件夹改名为 `Test2` 后，用向导原地修复工作区。

| | |
|---|---|
| **改名前：`Test1` 分组正常工作** | **改名后侧边栏仍显示旧分组（磁盘上文件夹已不在）** |
| ![改名前的工作区](docs/media/original_workspace.png) | ![改名后的工作区](docs/media/workspace_after_rename.png) |
| **打开设置 → 会话修复：「工作区体检」把分组标为「路径失效」，填入新路径** | **确认框亮出起讫路径与将要迁移的会话数** |
| ![工作区体检面板](docs/media/workspace_examination.png) | ![搬家确认弹窗](docs/media/remove_popup.png) |
| **搬家完成：分组原地更名为 Test2，会话与历史原样保留** | |
| ![搬家后的工作区](docs/media/workspace_after_move.png) | |

## ⌨️ 使用

### 拖拽跨工作区迁移

1. 重启后在侧边栏**分组视图**里，按住任意空闲会话行；
2. 拖到目标工作区的标题行（出现虚线高亮）松手；
3. 确认框显示目标工作区路径 → 点「移动」；
4. 完成 toast 提示；若侧边栏未自动刷新，手动刷新页面即可。

运行中的会话会被拒绝；移动失败会自动回滚并在 toast 中说明原因。

### 会话救援面板

1. 重启后打开 **设置 → 会话救援**，面板自动完成首次扫描；
2. **失联**行：选目标工作区 → 点「迁移过去」；
3. **未记账**行：点「补挂账」原地挂到路径匹配的工作区；
4. **挂错分组**行：点「归位」或「全部归位」；
5. **一键修复**：自动跑完可修复项，失败项隔离；
6. 支持按标题 / 会话 ID / 路径 / 分组筛选；
7. **已归档 / 回收站 / 备份**：归档可恢复；删除进回收站，可还原或确认后彻底删除；迁移备份可恢复或清理。

### 批量迁移

1. **Ctrl/Cmd+点击**加入多选，**Shift+点击**组内范围选择，**Esc** 清空；
2. 拖任一选中行到目标工作区标题行 →「全部移动」；
3. 或用 **「⋯」菜单 →「整组迁移…」**；源分组清空时可确认后删除（分组合并）。

### 工作区搬家向导

1. 文件夹被移动/改名后，**工作区体检**会把对应分组标为「路径失效」；
2. 填入文件夹现在的完整路径，点「搬家」；
3. 确认起讫路径与会话数量后执行；运行中的会话本次跳过，结束后可续跑剩余部分。

## 🔌 如何接入 DSH

本插件面向使用者只承诺以下接入原则（实现细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）：

1. 使用 DSH **官方扩展点**挂载，不修改 DSH 或 dsh-market 的安装文件；
2. 会话归属变更走宿主提供的**正式接口**，不伪造持久化数据；
3. 插件自有数据（历史、备份、回收站）写在**独立数据目录**，与会话档案分开；
4. 与官方侧边栏同组排序**互不干扰**，只处理跨工作区场景。

## 🤝 与其他插件共存

设计上按「与生态共生」标准实现，冲突面很小：通信与样式使用独立命名空间；不改写官方安装文件；会话归属写入使用宿主正式接口。

| 同装插件类目 | 兼容性 | 说明 |
| --- | --- | --- |
| 侧边栏增强 / better-sidebar / 终端 / 费用统计 / 记忆 / 导出分享 | ✅ 无冲突 | 面板与数据面完全不同 |
| 归档管理类插件 | ✅ 兼容 | 双方都使用官方归档数据，数据层一致（面板功能可能有些重复） |
| 排序 / 置顶类插件 | ⚠️ 基本兼容 | 移动后会精确重排「最近更新」；与置顶/排序插件并存通常无碍，仅各自面板展示顺序可能不完全一致 |
| 重画侧边栏的插件（自绘工作区树） | ⚠️ 降级共存 | 对方若替换官方侧边栏结构，本插件可能暂时无法识别会话行——表现为功能不触发，**不会损坏数据** |
| 其他会话移动器 | ❌ 建议二选一 | 同类插件可能重复处理同一次拖拽；本插件已覆盖移动 / 批量 / 合并 / 归位 / 归档恢复 |

## 🧩 兼容性与卸载

- **已验证组合**：DeepSeek Harness `0.1.5-rc.1`、dsh-market `1.45.1`、Node.js `≥ 22`。不修改 DSH 源码，仅通过官方扩展点接入。
- **市场卡片的「宿主要求未知」**：GitHub-only 插件没有 npm 发布清单时，dsh-market 可能无法从远端元数据推导宿主版本；显示「未知」**不代表**运行时不兼容。仓库 `package.json` 已声明 `engines.dsh` ≥ `0.1.5-rc.1`。
- **卸载可逆**：移除插件不会删除会话档案、工作区或官方记账。插件自己的历史、任务、备份和回收站数据仍保留在插件数据目录（见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）；移除后刷新或重启 DSH 即可清理注入的界面。
- **共存建议**：不要与另一个跨工作区拖拽移动器同时启用；其他类型插件可按上表共存。

部分高级操作依赖较新的 DSH 能力；不支持时界面会明确提示，而不是静默失败。

## 🔐 安全承诺

- **移动前自动备份**；搬运落地后再核对会话身份与路径，不符则整体回退；
- **失败时恢复到移动前状态**（文件与记账一并恢复）；
- **删除先进回收站**，可还原到原位置或任意分组；彻底删除需二次确认；
- **无法自动恢复时**，会在救援面板明确标出，需要人工确认；会话文件与备份始终保留，**绝不静默丢弃**；
- **近期打开过、仍驻留在 Harness 内存中的会话**不能直接删除，需重启 Harness 后再删（界面会给出明确提示）。

> 失败路径优先保数据，不静默丢会话。  
> 并非「任何错误都能自动恢复」：极端情况下会要求人工处理，但数据会留在原处。

## ⚠️ 已知限制

- 不支持把会话移入「Ungrouped」桶；
- 常驻内存的会话（近期打开过）不能直接删除，请重启 Harness 后再删；
- 若第三方插件整页重绘侧边栏，本插件可能暂时无法识别会话行（功能不触发，**不损坏数据**）；
- 「扁平列表」视图无工作区标题行，本插件在该视图不激活；
- 宿主大版本升级若改变内部结构，相关能力可能降级或需重启后生效；搬家向导在无法安全写入时会在改动任何文件之前中止并提示。

## 🆕 最近版本

### v2.0.1 · 2026-09-12

- 适配 DeepSeek Harness 0.1.5 会话档案命名与压缩格式（`.jsonl` / `.jsonl.zstd`，混用会明确拒绝）
- 修复 0.1.5 启动阶段的插件挂载问题，并加强并发保护
- 工作区迁移、回收站、任务中心、备份恢复等功能保持可用
- Release 提供 `.tgz` 安装资产

完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。  
实现与架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## License

MIT
