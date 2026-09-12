---
feature: docs-readme-restructure
status: designed
updated: 2026-09-12
branch: docs/readme-restructure
commits: # filled at delivery
---

# Docs: README restructure + ARCHITECTURE

## Report

## [S1] Problem

中文 `README.md` 与英文 `README_EN.md` 同时服务使用者、怀疑者和贡献者，功能区与安全区夹带宿主内部实现（RPC 列表、迁移算法、live header / 索引、ARIA、`$DSH_HOME` 路径、完整 changelog），读起来像实现说明书。完整 changelog 与 `CHANGELOG.md` 重复；clones 徽章只展示累计次数，缺少 uniques。

## [S2] Design

### 文档分层

- `docs/ARCHITECTURE.md`：**唯一**技术事实来源（英文）。中英文 README 均链接到该文件，不维护第二套架构译文。
- README（中/英）：面向安装者的产品页。结构固定为：
  1. 产品定位与核心功能
  2. 安装
  3. 截图
  4. 使用
  5. 如何接入 DSH（简述，4 条原则）
  6. 与其他插件共存
  7. 兼容性与卸载
  8. 安全承诺
  9. 已知限制
  10. 最近版本（仅 v2.0.1）
  11. 链接到 CHANGELOG.md 与 docs/ARCHITECTURE.md

### README 必须保留的信息

- 核心卖点不可删减：工作区搬家、会话救援、回收站/备份、批量迁移、真迁移/零 token、分组合并。
- 兼容性：精确版本（DSH `0.1.5-rc.1`、dsh-market `1.45.1`、Node `≥ 22`）、「宿主要求未知」解释、卸载可逆。
- 安全承诺（可验证，用户语言）：移动前自动备份；失败恢复到移动前状态；删除先进回收站；无法自动回滚时明确标人工处理；近期打开且驻留内存的会话需重启后再删。总结句用「失败路径优先保数据，不静默丢会话」，**不得**承诺「任何错误都能自动恢复」。
- 公开指标徽章：GitHub clones observed（含 uniques）、Release downloads 占位、CI / stars / MIT / Node / npm-deps-0 / Awesome。功能徽章收敛到 3–4 个：真迁移、零 token、备份回滚。
- clones 徽章：从第一排指标行保留；功能徽章减少后，clones 与 release-downloads 仍在指标区。

### 从 README 下沉到 ARCHITECTURE（不从仓库删除）

- 完整 RPC 端点列表
- 8 步移动算法与内部 API（`attachSession` / `detachSession` / live header / 索引 / `mutate`）
- `$DSH_HOME/workspace-mover/` 路径与数据目录
- ARIA / React props / CSS-module 选择器细节
- `session.v3.jsonl(.zstd)` 命名与压缩规则
- Windows EPERM、`--dsw-alias-*`、host/client 分层、测试用例清单
- 「官方讨论 #3012」成因解释可留在 ARCHITECTURE；README 功能区只写用户可见现象与一键找回

### Clones uniques 徽章

- 修改 `.github/scripts/traffic-badge-core.mjs` 的 `buildBadgeFiles`，在 `wsm-clones-total.json` 的 `message` 中追加 14 日窗口 uniques。
- 格式：`${cumulativeClones} since ${observedSince} · ${uniques} unique`。
- label 保持 `GitHub clones observed`。
- 不重新引入 `wsm-clones-14d.json` 文件（测试仍断言其不存在）。
- 更新 `test/traffic-badge.test.mjs` 对 message 的断言。
- 中英文 README 徽章 HTML 不需改 URL（仍指向 `wsm-clones-total.json`）；若 alt 文案可顺带标明 unique。

### 版本与发布边界

- 基于 `origin/main` @ `b5faf10`。
- 纯文档 + badge 脚本/测试修订；**不**修改插件运行时代码（`lib/`、`client/`、`cordis.patch.yml`）。
- **不**重打 `v2.0.1` tag，不重复发布功能版本。
- 本地原 main 工作区仍为 ahead1/behind2，由收尾阶段提示用户合并，不在本分支处理。

## [S3] Out of Scope

- 英文版 ARCHITECTURE 翻译 / 中文架构文档
- CHANGELOG.md 内容改写
- 插件功能、RPC 行为、版本号变更
- 删除或重命名历史 tag
- 本地 main 工作区的 merge/rebase（收尾提示用户）

## Tasks

- [ ] T1: 写入本 feature spec — acceptance: 文件存在且 status=designed (covers: S2)
- [ ] T2: 新建 `docs/ARCHITECTURE.md`，包含挂载方式、Host/Client 职责、RPC 表、档案命名、迁移/备份/回滚/并发顺序、数据目录、兼容边界、测试与发布约束 — acceptance: 文件存在；README 中集成细节段落不再需要 (covers: S2; depends: T1)
- [ ] T3: 重写 `README.md` 为 S2 结构，功能卖点/兼容/安全承诺保留，内部 API 词下沉 — acceptance: 目录与章节匹配 S2；无完整 RPC 清单与 8 步算法 (covers: S2; depends: T2)
- [ ] T4: 重写 `README_EN.md` 与中文结构一一对应 — acceptance: 章节顺序与关键承诺中英对等；链接指向同一 ARCHITECTURE/CHANGELOG (covers: S2; depends: T3)
- [ ] T5: `buildBadgeFiles` 输出 uniques；更新 traffic-badge 测试 — acceptance: `npm test` 中 traffic 用例通过；message 含 `unique` (covers: S2; depends: T1)
- [ ] T6: 全量验证 — acceptance: `npm test` PASS；README 内相对链接文件存在；中英章节一一对应 (covers: S2; depends: T3,T4,T5)
- [ ] T7: 在 `docs/readme-restructure` 提交文档修订 — acceptance: 分支相对 origin/main 有 docs 提交，无 lib/client 功能改动 (covers: S2; depends: T6)
