# DSH 兼容性实测报告：0.2.0-rc.2 · 2026-10-04

> 本插件的兼容性验收记录。每适配一个 DSH 版本新增一份带日期的报告；README 的 "DSH tested" 徽章链接到最新一份。
> 插件版本：**2.1.0**（npm + GitHub tag v2.1.0）· 运行环境：Windows 10.0.26200 x64 · Node ≥22

## 验证范围

| 场景 | DSH 版本 | 结论 |
| --- | --- | --- |
| **桌面客户端**（Electron 44 壳，`E:\DeepSeekHarness\desktop`） | 0.2 线（0.2.0-rc.2 内核） | ✅ 已实测通过 |
| **web profile** | 0.2.0-rc.2 | ⏳ 与桌面版同内核、同一代码路径，启动器已切换，回归待跑 |

## 桌面版实测项（2026-10-04）

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 数据家共享（`DSH_HOME` 指向既有 `data\`） | ✅ | 会话、工作区、投影缓存全部直接可见，无格式迁移（会话文件保持旧命名） |
| 桌面 profile 插件安装 | ✅ | 应用内「插件」页安装，profile 与 web 相互独立 |
| 拖拽跨工作区迁移 | ✅ | 会话行 → 工作区标题行，确认后真迁移 |
| 确认框渲染 | ✅ | 修复后为不透明卡片（0.2 主题的 `--dsw-specific-menu` 为半透明玻璃色） |
| 插件热重载后的移动 | ✅ | 修复了旧 fiber 失活导致的 `inactive context` 报错（connection 实例在 apply 时捕获） |
| agent 工具（dsh-tools 注册） | ✅ | dsh-base 在 web/桌面共享 `tools` 行；三个工具 + 审批门就绪 |
| `mover.status` 能力位 | ✅ | `agentTools` 标志如实汇报 |

## 已知事项（非本插件缺陷）

- **遗留 Agent 预设**：0.2 不再读取 `$DSH_HOME\.agent-presets\<id>\` 旧格式目录，旧会话恢复会报 `Unknown agent preset`。迁移步骤：[docs/dsh-0.2-preset-migration.md](../dsh-0.2-preset-migration.md)。
- **web profile 回归**：拖拽 / 面板 / agent 工具在 web 0.2 场景按同一代码路径适配，尚未单独实测；完成后本报告将更新。

## 测试基线

- `npm run check`（语法 + 105 用例 + pack dry-run）全绿；
- CI：ubuntu / windows / macos × Node 22/24 矩阵通过（v2.1.0 tag 构建）。

## 历史

| 日期 | DSH 版本 | 报告 |
| --- | --- | --- |
| 2026-10-04 | 0.2.0-rc.2（桌面） | 本文件 |
