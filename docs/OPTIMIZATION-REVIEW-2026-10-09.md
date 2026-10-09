# dsh-workspace-mover 优化评估报告

日期：2026-10-09
评估对象：`dsh-workspace-mover` v2.1.1（工作区 `E:\DeepSeekHarness\dsh-workspace-mover`）
评估方式：通读 `lib/index.js`（2679 行）与 `client/client.js`（2002 行）全部源码、`test/`（1962 行 e2e + 108 个用例）、`cordis.patch.yml`、README/ARCHITECTURE/CHANGELOG；对照官方 DSH 文档（slots / workspace / persistence / approval / client-modules / cookbook）；核对 `dshmarket@1.45.1` 与 awesome-dsh-plugin 的收录规则；横向比对同类插件。

结论先行：**核心迁移管线（备份先行 → 改写 → 原子搬运 → 回读校验 → 失败回滚）设计扎实，测试覆盖密度在社区里属于上游水平，不需要推翻重写。**真正值得投入的优化集中在四块：**私有宿主耦合的收敛**、**客户端没有 teardown**、**少选/误选路径的静默错配**、**生态元数据与文档漂移**。

> **实施状态（2026-10-09 同日完成）**：本报告的绝大部分已在 v2.2.0 落地。测试从 108 → 138，`npm run check` 全绿。逐条对照与实际取舍见文末[第十五节](#十五实施结果2026-10-09v220)。其中**第五章 5.1 的风险评估被实测修正**——详见该节与第十五节。

---

## 一、先确认做对了的地方（不要"优化"掉）

1. **字节级备份先行 + 失败零副作用**：`stashBackup` 在任何记账/索引/目标路径改动之前执行（`lib/index.js:656-664`），备份失败直接 `backup-failed` 中止。这是整个插件的安全基石。
2. **同卷 rename，跨卷 copy+delete，非空目标拒绝覆盖**：`moveDir`（`lib/index.js:331-359`）从不误删外来目录，复制失败只清理本次创建的目标目录，重试幂等。
3. **迁移后回读校验**：`verifyRelocatedArtifact`（`lib/index.js:365-374`）做 id + cwd 双确认，静默截断无法蒙混过关。
4. **try-acquire 锁、占用即 busy 不排队**（`lib/index.js:532-545`），批内先去重（`lib/index.js:1083-1089`）。
5. **ARIA 语义定位行而非 CSS-module 哈希类名**（`client/client.js:392-393`）——这是客户端最正确的决策，也是插件能扛住宿主改版的原因。
6. **只拦截跨组 drop**，官方同组排序确实不受影响（`client/client.js:1751-1755`）。
7. **错误码优先于文案正则**：`mapError` 让客户端按稳定 code 决定交互（`lib/index.js:548-564`，`client/client.js:676-685`）。
8. **全部宿主依赖访问 fail-soft**：`peekService`、`resolveViewStore`、`reconcileWorkspaceProjection`、代理工具注册，任一缺失都降级而不是抛进宿主。
9. **`wsm-*` 私有命名空间** + 官方 `--dsw-alias-*` 设计令牌（`client/client.js:331-379`），不写死配色、不需要监听主题变化。

---

## 二、P0：私有宿主耦合（最高价值的结构性优化）

插件有一处自觉的架构选择：不满足于官方 `Workspace` 接口，而是直接使用实体的私有成员与注册表的内存索引。这份自觉写在了注释里（`lib/index.js:18-33`），但**官方文档确认这些都不是契约**。

官方 `Workspace` 接口只有：`id` / `path` / `title` / `createdAt` / `updatedAt` / `sessionIds` / `setTitle()` / `attachSession()` / `insertSessionBefore()` / `detachSession()` / `status()`。插件用到而文档没有的：

| 用法 | 位置 | 性质 |
| --- | --- | --- |
| `entity.record.sessionIds`（看未过滤的"幽灵"记账） | `lib/index.js:850, 946, 977, 1401, 1579, 1636, 1702, 1786, 1870` | 私有记录，绕过官方 `sessionIds` getter 的 cwd 过滤 |
| `entity.mutate(...)`（换 path 的统一写入通道） | `lib/index.js:1620-1629` | **未文档化**；`setTitle()` 才是公开的改名 API |
| `registry.headers` / `registry.sessionPaths` / `registry.invalidSessionPaths` 三张内存索引的读写 | `lib/index.js:742-746, 780-784, 1612-1614, 1644-1646, 1886-1889` | 三张索引均**不在**文档化的 `WorkspaceRegistry` 顶层方法列表中 |
| `registry.enqueueOperation` / `requireState` / `setState` | `lib/index.js:1465-1471, 1844-1851` | 包装得比较好（有 `typeof` 守卫 + 降级），风险相对低 |
| `persistence.root` | `lib/index.js:645, 903, 1586, 1781, 2043` | `SessionPersistence` 接口只有 `create/open/stat/list` + `flush`，**`root` 未文档化** |
| 自复刻存储布局编码 `projectKey` / `encodeSegment` / `sessionDir` | `lib/index.js:73-110` | 注释自承是 `dsh-session-persistence-jsonl` 语义的"最小移植" |

**为什么这是 P0：** 回滚网在"记账/索引"层做得很厚（`lib/index.js:777-802`），但在**存储布局**层没有任何兜底——一旦宿主改变目录编码规则或迁移到 v4 存储格式，`sessionDir()` 会指向不存在的路径，插件就无法定位档案。

**建议（按投入产出排序）：**

- **P0-a 把布局不确定变成显式前置检查。** 在 `apply()` 里用持久化服务自证一次布局：取一个已知会话，用 `persistence.list()` 拿到的 header 反推 `sessionDir(root, header.cwd, header.id)`，`existsSync` 不通就置 `degradedFeatures.push('storage-layout')`，`mover.status` 与 `doctor` 如实上报。**成本极小，能把"某天突然全部搬不动"变成"启动即提示"。** 这是本报告里性价比最高的一条。
- **P0-b `mutate` → 优先 `setTitle()`。** 搬家向导里同步标题的部分（`lib/index.js:1623-1628`）完全可以用公开的 `entity.setTitle(basename(targetCanon))` 表达；`mutate` 只保留"换 path"这一真正没有公开替代的用途。
- **P0-c 把 `record.sessionIds` 的用法收敛成单一函数。** 现在 9 处直接读私有字段。抽一个 `rawRecordIds(entity)`（内部保留 try/catch + 注释），未来官方若公开"未过滤记账"或改变结构，只改一处。

---

## 三、P0：回收站不覆盖备份，且备份无会话级 GC

`cleanupOldData`（`lib/index.js:1278-1312`）里回收站清理与备份清理是两个独立判定，但它按"时间"清理。而 **`deleteSessionToTrash` 只移动会话档案，不移动/不删除该会话的备份**（`lib/index.js:1912-1968`，`stashBackup` 的 20 份上限也只在**再次备份同一会话时**触发裁剪，`lib/index.js:389-390`）。

后果：用户彻底删除（purge）一个会话后，它每次迁移留下的最多 20 份备份字节**永久留在磁盘上**，没有任何 UI 能按会话清掉（`mover.backups.list` 会列出它们，但会话已不在侧边栏，用户很难意识到该删）。对长期用户这是无上限的空间泄漏。

**建议：**
1. `mover.trash.purge` 与 `mover.session.delete` 增加可选参数 `purgeBackups: true`，一并清掉该会话的备份；
2. `mover.backups.list` 标注"会话已不存在"的孤儿备份组，并提供"清理全部孤儿备份"；
3. `doctor` 增加一项：孤儿备份组数 + 占用字节。

---

## 四、P1：客户端没有 teardown（热重载后会叠加实例）

`client/client.js` 注册了 **7 个 document 级监听器**（`:1615, :1668, :1719, :1729, :1746, :1863, :1915`）和 **1 个 `document.body` 子树 MutationObserver**（`:1963-1982`），并挂了 `window.__wsmDebug`（`:1984-1994`）。**没有任何 `removeEventListener` / `disconnect()` / `ctx.effect()` 清理路径。**

这不是理论风险：项目自己的 CHANGELOG 2.1.0 就记录了"桌面版热重载后旧 fiber 被废弃"，并为此专门在 `apply` 时提前捕获 `connection` 实例（`client/client.js:1444-1458`）。如果 bundle 被重新执行，每个监听器都会注册第二份，且旧闭包连同 `pickedRows` / `dragging` / `wsCache` / `scanCache` 永远不会回收。

两个实例同时存在时会真的打架：`refreshPickVisuals` 用全局选择器清理高亮（`:1511-1512`），两份闭包会互相擦掉对方的选中态；drop 路径会弹两次确认框、发两次 RPC。

**建议：** 用一个收集器统一登记所有监听器与 observer，在客户端插件的 dispose/effect 清理钩子里统一释放；并加一个模块级 `applied` 标志，防止同一 bundle 被重复 `apply`。**顺带**：`menuObserver.observe(document.body, {subtree:true})` 是常驻全页监听，而它只在点过「⋯」后 1 秒内有意义（`:1921`）——改成"点击时 connect、注入或超时后 disconnect"是几乎零成本的改进。

---

## 五、P1：少选/误选的静默错配（会搬错会话）

这是**数据正确性**而非体验问题，值得优先修。

**5.1 多选 id 解析的兜底会猜错（`client/client.js:1572-1593`）**

> ⚠️ **实测修正**：实施阶段用夹具反复尝试构造"错配 id 进入移动清单"的场景，**都没能成功**——因为拖起行的权威 id 总是最后 `push`，而 `seen` 去重会让更早入表的错配 id 全部落空（`push` 对重复 key 直接 return）。也就是说，即使整体错位一格，错配 id 也会被去重吞掉，**不会**被移动。本节原先的风险定级（Critical、"会搬错会话"）过高；真实性质是**隐式保护 + 不可观测**：保护来自 push 顺序这个容易被后续改动破坏的巧合，且用户完全不知道有行被跳过。v2.2.0 因此把它改为显式契约（`mapGroupRows` 返回 `unresolved`、变更路径不猜、UI 如实说明），测试也相应改为守卫式断言"错配 id 绝不能出现"。

```js
if (hit < 0) hit = 0;              // :1587
const id = remaining.splice(hit, 1)[0];
```

权威通道 `rowSessionId`（走 React fiber 取 `node.id`，`:1551-1564`）失败时，退化为"两指针顺序 + 标题子串匹配"，而**匹配失败就直接取顺序里的下一个 id**。官方侧边栏会隐藏空白/归档行，此时组内每一行都会错位一格，批量拖拽会移动**一组错误的会话**；而且错配的往往是另一个**合法**的 session id，宿主端无法察觉（`lib/index.js:2534-2546` 只校验非空字符串）。更麻烦的是失败是静默的：`rowSessionId` 的守卫要求 `node.blank !== undefined || node.updatedAt !== undefined`（`:1557-1558`），官方改个字段名就会让**所有行**都走兜底路径而不报任何错。

**建议：** 在**变更路径**上禁止猜测——`rowSessionId` 返回 null 时跳过该行并汇总提示"N 行无法识别，已跳过"；把"使用了兜底映射"变成 `console.warn` + 一条用户可见提示。多选移动宁可不做，不能做错。

**5.2 工作区解析的位置兜底没有校验（`client/client.js:1700-1715`）**

```js
const idx = headerIndex(rowEl);
const byIndex = idx >= 0 && idx < list.length ? list[idx] : null;   // :1712-1713
```

按 DOM 顺序取注册表第 i 项，但两侧的集合口径**不一致**：`visibleWorkspaceHeaders()` 过滤掉未分组与 `offsetParent === null` 的行（`:1691-1693`），而 `items` 来自 `registry.list()`，**包含目录已失效的工作区**（插件自己就为这类写了一个搬家向导）。侧边栏少显示一项，索引就整体偏移，drop 会落到相邻分组。

**建议：** 位置兜底必须自证——要求 `headerText(rowEl)` 命中该项的 title 或 path，否则返回 null 并提示 `staleList`（该文案已存在但从未被使用，`:32/:179`）。同时把 `resolveWorkspace` 里重复的 `normalizeHeaderText`/`toLocaleLowerCase` 按事件缓存一次。

**5.3 `fetchWorkspaces` 的 3 秒缓存让目标可能过期（`client/client.js:1469-1475`）**

`wsCache` 只在校验失败时清空（`:1779-1786`），**解析成功但解析错了**不会失效。drag 过程中分组被增删改，drop 就可能提交到错误的 `targetWorkspaceId`。确认框里显示的 `title（path）`（`:543`）是唯一防线，而批量场景用户容易直接确认。

**建议：** drop 前强制绕过缓存重解析一次，`workspaceId` 与 dragover 阶段不一致就中止并提示 `staleList`。

---

## 六、P1：官方已有公开 API，插件却自行实现

| 能力 | 插件当前做法 | 官方公开 API |
| --- | --- | --- |
| 取消归档 | 自写 `enqueueOperation` + `setState` 改归档集（`lib/index.js:1456-1482`） | `registry.unarchiveSession(sessionId)`（文档化；"归档从不摘记账槽，取消后自动回到原位置"与插件的理解一致） |
| 归档前置检查 | 自判 `agents.get(id).status === 'running'` | `archiveSession` 的 `workspace/session-activity` waterfall，`{stopActivity:true}` 可按与停止按钮相同的路径停掉运行中的工作 |
| 工作区改名 | `entity.mutate` 手改 path + 顺手同步 title | `entity.setTitle(title)` |
| 路径唯一性判定 | 自写 `samePath`（realpath，失败退化为大小写不敏感字符串比较，`lib/index.js:55-61`） | `registry.resolveByPath(path)`——官方唯一性口径就是 canonical 路径字符串相等 |
| 会话在组内排序 | 不涉及（`attachSession` 前插符合官方语义） | `entity.insertSessionBefore()` |

**建议：** `unarchiveSession` 换成官方调用（可去掉一整段状态写通道兼容代码，风险同时下降）；`auditWorkspaces` 里 `directoryPicker` 相关能力可顺带探测。

**另外**：`mover_move_session` 只在会话所在工作区内做锁，跨工作区移动依赖调用方，官方 `insertSessionBefore`/`attachSession` 都自带持久化序列化——可以考虑把"工作区级排序/移动"改为官方 API 组合，进一步减少私有耦合。

---

## 七、P2：客户端 UI 与可达性

1. **自定义弹窗没有焦点管理（`client/client.js:517, 535-554`）**：`role="dialog" aria-modal="true"` 但没有 `aria-labelledby`、打开时不 focus 任何元素、Tab 可以跑出弹窗。而 `confirmGroupMove` / `pickRestoreTarget` 却做了 `select.focus()`（`:587, :623`），不一致会让问题更明显。建议：打开时 focus 主按钮，补 `aria-labelledby`，做 Tab 循环。
2. **HelpDot 只给 `title`**（`:654`）——键盘和触屏都读不到解释文案，而插件把重要语义都放在这些说明里。建议加 `tabIndex=0` + `aria-label`。
3. **全组迁移入口靠 MutationObserver 扫描 host 菜单（`:1915-1982`）**：点击「⋯」后 1 秒内扫 `document.body` 找菜单 portal，然后**克隆官方菜单项的 `className`** 来注入自己的两项。这与插件"不碰 CSS-module 哈希类名"的原则是矛盾的——这里恰恰克隆了哈希类名。官方文档明确说明 `sidebar.workspaces.session.menu.item` 是**声明式的 list 槽位**，"pin / rename / fork / archive 本身就是按插件同样的方式注册进去的，插件动作落在 `order` 决定的位置"。建议改为标准槽位注册，可整体删除 observer、`menuHeaderRow` 计时启发式和合成 Escape/PointerEvent 关闭菜单的手法（`:1939-1940`）。
4. **i18n 走 `navigator.language`**（`:314`）而非官方 locale 服务：用户把 DSH 界面语言切成英文（或未来的俄语等）时插件不会跟随。官方槽位注册支持 `locale: '<namespace>'`，由框架注入 `t`。建议迁移到 locale 命名空间。
5. **未使用的 i18n 字符串**：`pickEscHint`（`:94/:241`）、`ungroupedUnsupported`（`:31/:178`）、`staleList`（`:32/:179`）全代码零引用。其中 `pickEscHint` 的内容还与实现**矛盾**——它说"输入框聚焦时无效"，但 `:1668-1671` 是无条件清空多选，没有检查 `document.activeElement`。要么补上焦点判断，要么改文案。
6. **中文界面里漏出的英文硬编码**：`"unrecognized drag payload: empty"`（`:1769`）与 `` `too many sessions in one batch (max 50, got ${n})` ``（`:1812`）。
7. **`dragover` 每次都 `querySelectorAll` + 强制布局**（`:1729-1734` 的 `clearHints`、`:1691-1694` 的 `visibleWorkspaceHeaders` 读 `offsetParent`），在 60–120Hz 下是不必要开销。建议保存 `lastHinted` 元素引用，并每个事件只计算一次行/标题列表。

---

## 八、P2：迁移任务与归档的小问题

1. **`listArchivedSessions` 受 scan 截断影响**（`lib/index.js:1424-1448`）：它复用 `scanSessions`，而后者只解析按 mtime 排序的前 `SCAN_MAX_ITEMS = 400` 个档案（`:934`）。**归档会话通常很旧**，在超过 400 个会话的库上会直接从"已归档会话"列表里消失，而面板不会说明原因。建议归档列表走独立的、按归档 id 定向读取的路径（或至少把 `truncated` 展示出来——现在返回值里有这个字段但 UI 是否提示需要确认）。
2. **批量历史与单条历史的 undone 语义**：`undoBatchMove` 部分失败时把失败项保留在记录里（`:499-505`）——这个设计是对的，但 `history.json` 没有记录"这条历史被部分撤回了几次"，用户可能反复点撤回。建议在记录里加 `undoAttempts`/`lastUndoAt` 并在 UI 显示。
3. **`mover.tasks.forget`** 的 `all` 分支会清空全部任务记录（`lib/index.js:1266-1272`），但客户端只暴露了"清除记录"（单条）。如果是有意为之，建议把 `all` 参数从 RPC 表里去掉或加显式确认，避免未来被误用。

---

## 九、P2：生态对接（这是与同类插件差距最明显的地方）

对照 [awesome-dsh-plugin 的贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 与同类插件 [hkkz9522/dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager)，插件在**代码质量上不落后，在生态元数据上落后**。

1. **完全没有 `peerDependencies`。** 指南专门用警告框说明了两个后果：
   - 官方 `@deepseek-ai/*` 包应声明为 **peerDependencies 而非 dependencies**；
   - **不带显式预发布分支的 peer 范围会静默排除 harness 的所有预发布构建**——`>=0.1.5-rc.1` 这类写法看着宽，但在 `0.1.6-rc.1` 上会因为 tuple 上没有带预发布标签的比较符而被排除，用户 `npm install` 会撞上 `ERESOLVE` 手工解决。指南给的正确形态是 `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`。
   - 插件实际用到的宿主包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-ui-slots`）应逐条声明，不适用的在 `peerDependenciesMeta` 标 optional（`dshmarket` 就是这么做的）。这同时会让 dsh-market 的"宿主要求"从"未知"变成可核对的声明。

2. **没有 `screenshots.json`。** 官方约定：在 `package.json` 同级放 `screenshots.json`，列出 1–8 张仓库内相对路径图片，市场详情页会以 App Store 风格展示。插件已有 8 张截图在 `docs/media/`，**不声明就只能靠市场从 README 里抓**——控制不了顺序与选片。这是全文成本最低、收益最直观的一条（约 10 行 JSON）。

3. **README 已有的"已知限制"不够醒目。** 同类插件把版本兼容矩阵放在 README 顶部级别的显著位置；本插件的矩阵在 `README.md:218-232`，且与 `docs/ARCHITECTURE.md:119-128`（仍只写 "Verified: `0.1.5-rc.1`"）不一致——**这个不一致会被 dsh-market 直接读 `engines.dsh` 后放大**：README 徽章宣称 "DSH tested 0.2.0-rc.2"，manifest 却只声明下限 `>=0.1.5-rc.1`。

4. **没有插件 Config。** 硬编码策略（备份保留 20 份、历史 100 条、单批 50、每工作区 200、扫描 400、清理 30 天）全都不可调。官方模式是 schemastery schema + `Volatile<T>` 字段导出 `Config`，由 dsh-market/设置页渲染。建议至少把**备份保留份数**与**清理天数**开放出来——这两个直接关系磁盘占用。

5. **仓库缺少 `dsh-plugin` topic**（指南明确要求）。这条无法从代码判断，需要确认。

---

## 十、P3：文档与注释漂移

| 位置 | 问题 |
| --- | --- |
| `README.md:64` / `README_EN.md` | 写"`mover_list_sessions` / `mover_move_session` / `mover_repair_sessions` 三个模型可调用工具"，实际 `createAgentTools` 注册了 **4 个**（`lib/index.js:2363-2373` 多了 `mover_doctor`） |
| `docs/ARCHITECTURE.md:58` | "registers three plain tool definitions" + 表格只有 3 行，同样漏了 `mover_doctor` |
| `docs/ARCHITECTURE.md:145` | "95 cases at v2.0.1"——CHANGELOG 2.1.1 明确写了 "Tests 105 → 108" |
| `lib/index.js:2288-2293` | 注释"构造三个 agent 工具"，实际 4 个 |
| `README.md:20` / `:271` | `dsh.so` 风险徽章指向 `https://www.dsh.so/artifact/dsh-workspace-mover/`（README_EN 是 `dsh.so`）——两个 README 的 URL 形态不一致，建议统一并确认可访问 |

**建议：** 把"插件能力清单"（工具表、RPC 表、测试数）收敛到一个地方生成或至少加一条检查。工具的 name/description 现在同时存在于 `lib/index.js` 与两份 README + ARCHITECTURE，漂移是必然的。

---

## 十一、测试：补客户端

`npm test` 跑 4 个文件、108 个用例，**全部是宿主侧**。我（以及并行的客户端评审）在整个 `test/` 目录里搜 `client` / `document.` / `jsdom` / `treeitem` / `drag` / `MutationObserver`——**零命中**。`check:syntax` 只做 `node --check`，即只证明能解析。

也就是说：**上表中所有客户端缺陷（第五章的误选、第四章的 teardown）都没有任何回归网。**

**建议（按性价比排序）：**
1. `test/client-dom.test.mjs`，手写约 150 行 DOM stub（不引入依赖，保持零 devDependencies 与 CI 的 `node --test` 不变）。该模块只 `require("react")`，需要 fake 的 API 很少。重点断言：`resolveWorkspace` 的**位置兜底**必须拒绝不匹配的标题（第五章 5.2 的回归测试）、`mapGroupRows` 错位时不得猜 id（5.1）、drop 路径最终传给 `mover.move` 的 `sessionId` + `targetWorkspaceId` 是否正确。
2. **重复 `apply` 的监听器计数断言**——一次就锁死第四章的泄漏。
3. 注意：`package.json:23` 是**显式枚举**测试文件的，新增文件必须同步加进去，否则在 CI 里静默不跑。

---

## 十二、与同类插件的定位

最直接的竞争者是 **[hkkz9522/dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager)**（"drag-and-drop sessions between workspaces … auto backup/rollback, official workspaceRegistry sync"）。它的能力更宽（删除/归档/移动/预设迁移 + 收藏/待读/标签/备注/搜索/筛选/排序/优先级/批量），并且有两处工程做法值得借鉴：

- **冷重写保留档案原有格式（V1/V2/V3/V4 都可读，从不强制升级）**，且拒绝损坏/截断的 Zstd 或末行不完整的 JSONL，而不是发布不完整历史。相比之下，本插件把 `CURRENT_GENERATION` 固定为 3（`lib/index.js:50`）并对同一目录里的混合压缩编码直接抛 `unsupported`（`:150-165`）。**建议核实**：在一个 v4 或混合编码的宿主上，插件的读取（`findHighestArtifact` 能认任意 vN，这部分没问题）与拒绝策略是否会把宿主本身能正常处理的会话判成不可用。
- **删除有明确的目录边界/符号链接/联接点防护**，并有 per-session 串行化与 64 KiB 请求体上限。本插件的 `moveDir` 在覆盖策略上更保守（拒绝非空目标），这点更好；但 `openInFileManager(path)` 的路径来自 `entity.path`（已注册工作区，`:1524-1526`），边界是够的。

**差异化优势（值得在 README 里讲清楚）：** 本插件有**回收站**（可还原而非直接删）、**失联/未记账/挂错分组的三态救援**、**文件夹改名后的工作区搬家向导**、**任务中心与失败重试**、**mover_doctor 自检**、以及**完整的字节级备份 + 回滚账本**。同类插件的删除是不可逆的。这是本插件真正的产品护城河，建议在对比表里明确出来。

---

## 十三、建议的动手顺序

| 优先级 | 事项 | 预估 | 理由 |
| --- | --- | --- | --- |
| 1 | 补 `screenshots.json`（`docs/media/` 的 8 张图） | 10 分钟 | 生态收益最直观，零风险 |
| 2 | 修文档漂移（工具数量 ×3 处、测试数、ARCHITECTURE 的 Verified 版本） | 1 小时 | 会被 dsh-market 放大，且描述不实是收录被打回的主因 |
| 3 | 布局自证前置检查 + `status`/`doctor` 上报（P0-a） | 半天 | 把"突然全搬不动"变成"启动即提示"，性价比最高 |
| 4 | 声明 `peerDependencies`（带显式预发布 `\|\|` 分支）+ `peerDependenciesMeta` | 1 小时 | 直接影响安装成功率与市场卡片 |
| 5 | 客户端 teardown + 防重复 apply（第四章） | 半天 | 已知会发生（项目自己的 CHANGELOG 记录过），且会引发双弹窗/双 RPC |
| 6 | 禁止多选路径猜 id + 位置兜底自证（第五章 5.1/5.2） | 1 天 | 5.1 实测风险被高估（见该节修正），5.2 是**实测可复现**的活跃缺陷；两项都已改为显式契约 |
| 7 | 补 `test/client-dom.test.mjs`（先测 6 的两个回归） | 1 天 | 锁死第 6 条，否则会再退化 |
| 8 | 回收站/备份的会话级 GC（第三章） | 半天 | 无上限磁盘泄漏 |
| 9 | 全组迁移入口改标准槽位 `sidebar.workspaces.session.menu.item` | 1 天 | 去掉 observer 与哈希类名克隆，同时修可达性 |
| 10 | `unarchiveSession` 换官方 API；`mutate` → `setTitle` | 1 天 | 减少私有耦合，删代码 |
| 11 | locale 服务迁移 + 清理死文案 + 补英文硬编码 | 半天 | 体验一致性 |
| 12 | 开放 Config（备份份数 / 清理天数） | 半天 | 磁盘占用可控 |

---

## 十四、补充：生态细节（第二轮调研新增）

1. **市场卡片的空"插件配置"页。** dsh 0.1.7+ 起，宿主**从插件自己的 Config schema 派生设置页**，不再提供插件自行注册的设置命名空间。插件目前没有导出 `Config`，所以在市场上它的"Plugin configuration"是空的。这与第九章第 4 条是同一件事，但严重性更高：不是"少了个可调项"，而是"市场里这一页是空的"。

2. **可以给自己的市场卡片挂自检结果。** 官方文档化的扩展点是 `plugins.detail.section`（也有 `.actions` / `.badge`），subject 对自身 bundle 是 `{ kind: 'bundle', pkg }`。可以把 `mover_doctor` 的 pass/warn/fail 结果渲染到卡片上——今天 doctor 只能在插件运行后从面板里看到，挂到卡片上则安装前/安装时就能看到宿主服务缺失情况。返回 null 表示对该 subject 无内容。

3. **`connection` 的作用域处理是正确的，建议固化为不变量。** `connection` 只存在于 web 平面；若把它放进宿主侧顶层 `inject`，在 headless/tui profile 上整个插件会永久 `inactive`。宿主侧现在是 `inject = ['workspaceRegistry','sessionPersistence','tools','approval']`（`lib/index.js:45`），`connection` 走 `ctx.inject(['connection','webServer'], …)` 的 scoped 子 fiber（`lib/index.js:2670-2674`）——**做法正确**。建议在注释里写明这是刻意的不变量，并让 `mover.status` 显式汇报 RPC 注册状态（如 `rpcEndpoint: { registered: true }`）。附带一个实测事实：**客户端半改动走 HMR（约 1 秒生效，无需刷新或重启），宿主半改动需要重启**——这直接影响第十二章里"改客户端"任务的验证方式。

4. **同类插件比本插件多的地方**（用于定位差异化，不建议照抄全部）：`dsh-archive-manager` 的 peerDependency 卫生（每条 DSH 预发布一条显式 `||` 分支 + `peerDependenciesMeta.optional` + `./locale/*.json` 导出 + `test:matrix` / `test:compat` / `release:preflight` 脚本集）是本插件可以直接照抄的最佳参考；`dsh-session-manager` 的删除有目录边界/符号链接/联接点防护与 per-session 串行化。

5. **npm 发布的两个实际影响**：预构建安装可跳过 `allowBuilds` 构建授权；市场可展示并按下载量排序。收录本身不依赖它。注意已发布包的 `repository` 字段必须指回被收录的仓库，映射才会自动建立（不能在 yml 里手写 `npm:` 键，会被校验拒绝——当前 yml 没有这个键，正确）。

6. **一个需要留意的信号**：`dsh-market` 自身的市场数据来源就是 `awesome-dsh-plugin/plugins.json`，而插件的市场卡片"宿主要求未知"正是因为 `engines.dsh`/peer 声明无法被推导。修好第九章第 1 条后，这张卡片会从"未知"变成可核对的声明。

---

## 十五、实施结果（2026-10-09，v2.2.0）

**质量门禁**：`npm run check`（语法 + 测试 + `npm pack --dry-run`）全绿；用例 **108 → 141**。`npm pack` 已确认 `screenshots.json` 按设计不进 npm 包、`test/client-dom.test.mjs` 与 `test/policy.test.mjs` 进包。

**离线性验证**：拿 `E:\DeepSeekHarness\data\sessions` 的**真实**会话数据核对存储布局假设——30 个会话全部能被 `projectKey` / `encodeSegment` 精确重算为磁盘上的实际路径，0 处不符。这是本次改动里唯一能离线证伪的核心假设，因此 `data-layout` 上线后应报 `ok`。

### 已落地

| 计划项 | 结果 | 关键证据 |
|--------|------|----------|
| P1.1 `screenshots.json` | ✅ 7 张，路径全部校验存在且合规 | 仓库根新增；不在 `files` 内 |
| P1.2 文档漂移 | ✅ 工具数量 4 处、兼容矩阵日期化、测试数改为由运行报告 | README / README_EN / ARCHITECTURE / lib 注释 |
| P1.3 `peerDependencies` | ✅ 8 条，全部带显式预发布 `\|\|` 分支 + `peerDependenciesMeta` optional | 自检断言"每条范围都带预发布标签" |
| P2 多选不猜 id | ✅ `mapGroupRows` 返回 `{map, unresolved}`；变更路径遵守"宁可不做" | 用例：错配 id 绝不能进入 payload；全部无法识别则不发 RPC |
| P3.1 分组解析自证 | ✅ 删除无条件位置回退 | 用例复现旧行为把会话搬进"目录已失效的分组"，现已中止 |
| P3.2 存储布局自检 | ✅ `verifyStorageLayout` + `status.capabilities.storageLayout` + `doctor` 的 `data-layout` | 3 个用例覆盖 ok / degraded / empty |
| P4 客户端测试网 | ✅ `test/client-dom.test.mjs`，手写 DOM stub（含迷你 HTML 解析器，因为弹窗走 `innerHTML`） | 10 个用例；**react 无法从插件目录解析，故内置 React shim，保持零 devDependencies** |
| P5.1 teardown | ✅ `listen()` 统一登记 + 单个 `ctx.effect` 释放 + `applied` 防重复装载 | 用例断言"卸载再装载监听器净增长为 0"与"未卸载重复 apply 不叠加" |
| P5.2 弹窗可达性 | ✅ `aria-labelledby` 关联真实标题、先 append 再 focus、Tab 循环 | 用例在弹窗打开期间断言，而不是关闭后 |
| P5.3/P5.4 文案 | ✅ 删 `ungroupedUnsupported`/`pickEscHint`，启用 `staleList`，补 `dragPayloadBad`/`batchTooMany`，Esc 尊重输入框 | 新增中英词条对账告警，防再次漂移 |
| P6 备份会话级 GC | ✅ `listBackups` 标 `orphan` + `orphanGroups/orphanBytes`；`delete`/`purge` 支持 `purgeBackups`；doctor 汇总 | 用例断言默认保留、`purgeBackups` 清理、相邻前缀 id 不误删 |
| P7 归档截断可见 | ✅ `scanSessions` 增 `scannedParsed`；`listArchivedSessions` 透传四项计数；客户端提示 | 用例构造落在扫描窗口外的归档会话 |
| P8 官方 API | ✅ `unarchiveSession` 优先官方（保留回退）；标题同步改 `entity.setTitle` 且与 path 解耦；`record.sessionIds` 15 处读取收敛为 `rawRecordSessionIds()` | 双路径用例 + "setTitle 失败不影响 path 重定向"用例 |
| P9 策略可配置 | ✅ 6 项策略走 `resolvePolicy`（使用点读取、非法值回退默认）；`lib/config.js` 守卫式 `buildConfig`/`attachConfig` | `test/policy.test.mjs` 10 个用例 |

### 实施中被实测修正的两处（重要）

1. **P2 的风险定级过高**（见第五章 5.1 的修正块）。原报告称兜底猜 id 会搬错会话；实测被现有 `seen` 去重完全兜住，构造不出真实错配。改动仍然做了，但理由从"修活跃缺陷"改为"把隐式巧合变成显式契约 + 让用户可见"。
2. **P9 过程中发现一个真实的潜伏缺陷**：`cleanupOldData` 的签名是 `{ days = 30 }`，解构默认值会把"未传值"变成 `30`，使 `Number(days) || cleanupDays()` 这条策略回退**永远看不到 undefined**——策略配置被默认值静默遮蔽。这是"环境变量调了没用"的典型表现。已修（改为 `{ days }` + 显式判断），并由 `test/policy.test.mjs` 第 5 例锁定。这个缺陷在原报告里没有出现，是实施阶段顺带查出的。

### 有意未做（附理由）

- **P5.5 locale 命名空间迁移**：官方路径是槽位注册声明 `locale: '<namespace>'`，由框架注入 `t`。但 `@deepseek-ai/dsh-client-locale` 在本环境**不可解析**（`createRequire` 从 `lib/` 与插件根均失败），我无法验证注册形态与 `t` 的注入契约。按本次实施的一致原则（"不写验证不了的代码"），**不落地半成品**：现有 i18n 按 `navigator.language` 工作正常，新增了中英对账告警。待能对照真实宿主验证后再迁移。README 已把"没有图形化设置页"列入已知限制。
- **`mover.doctor` 的市场卡片自注解（`plugins.detail.section`）**：同样属于无法本地验证的官方槽位 API，未做。
- **`scanSessions` 改为归档定向读取**（P7 的架构级方案）：按计划只做可见性，不重构。
- **把 `moveDir` 的复制兜底加上 `preserveTimestamps`**：收益不明、回归风险不划算。
- **`CURRENT_GENERATION = 3` 与混合压缩编码的 `unsupported` 判定**：同类插件声称支持 V1–V4 且"从不强制升级"，但需要真实 v4/混合编码宿主才能验证；**未盲改**，仅记录为待验证项（见第十二节）。
- **`samePath` 替换为 `registry.resolveByPath`**：Windows 大小写别名语义有差异，需逐点验证，收益低于已完成的 P8.1/P8.2。

### 需要你手工确认的一项

本机无 `gh` CLI，**无法验证仓库是否带 `dsh-plugin` GitHub topic**（awesome-dsh-plugin 的收录要求之一）。请手工确认：

```powershell
gh api repos/PianoPrince/dsh-workspace-mover --jq .topics
```

### 下一步建议（按价值排序）

1. 在真实 v4 / 混合压缩编码的宿主上验证读取与拒绝策略（第十二节唯一的未决技术风险）。
2. 用官方 locale 槽位替换 `navigator.language`（需先能对照真实宿主）。
3. 若宿主未来提供文档化的 schema 接缝，把 `lib/config.js` 的 `buildConfig` 接上，即可获得官方设置页。
4. 把 `mover.doctor` 结果渲染到市场卡片（`plugins.detail.section`）。

## 附：清单文件

评估时（v2.1.1）：

- `lib/index.js`（2679 行，宿主侧）
- `client/client.js`（2002 行，客户端）
- `test/e2e-sandbox.test.mjs`（1962 行 / 108 用例，**仅宿主侧**）
- `cordis.patch.yml`、`package.json`
- `README.md` / `README_EN.md` / `docs/ARCHITECTURE.md` / `CHANGELOG.md`

实施后（v2.2.0）新增与改动：

- `lib/config.js`（新增，守卫式 Config 构造）
- `screenshots.json`（新增，仓库根）
- `test/client-dom.test.mjs`（新增，客户端 DOM stub + 10 用例）
- `test/policy.test.mjs`（新增，策略 + Config 10 用例）
- `lib/index.js`、`client/client.js`、`package.json`、`CHANGELOG.md`、两份 README、`docs/ARCHITECTURE.md` 均有改动

官方参考（本次核对来源）：
- [Web Client Slots](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots)
- [Workspaces](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/workspace)
- [Session Persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence)
- [User Approval](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval)
- [Client Modules](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/client-modules)
- [Cookbook: live configuration forms](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-settings-card)
- [dsh-client-ui-workspace README](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/ui-workspace/README.md)
- [awesome-dsh-plugin contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
- [dsh-market](https://github.com/dsh-market/dsh-market)
- [hkkz9522/dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager)
