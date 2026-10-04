# DSH 0.2 遗留 Agent 预设迁移指南

> 面向从 DSH 0.1.x 升级到 0.2（含桌面版）的用户。本仓库作者实测踩坑并按官方迁移指引解决，记录于此供同样遇到的人参考。

## 症状

升级到 DSH 0.2 后，**旧会话**切换模型 / 恢复会话时报错，**新建会话一切正常**：

```
模型操作失败：gateway/internal: resume failed for session "session-xxxx":
RemoteError: Unknown agent preset: <你的预设 id>
```

## 根因

0.1.x 时代，用户自定义 Agent 预设存放在：

```
$DSH_HOME/.agent-presets/<预设 id>/
├── preset.yml          # 展示信息：name / description / order
└── agent.cordis.yml    # 插件组合（Cordis entry list）
```

0.1.5 的运行时会扫描该目录，所以当时一切正常。**0.2 起官方不再读取该目录**——官方文档原文（`packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md`，"Migrate a legacy preset" 一节）：

> Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` … and `agent.cordis.yml` …. **Nothing reads that directory any more.**

0.2 中预设是组合配置里的**声明行**（`@deepseek-ai/dsh-agent-preset` 插件行，按 `config.id` 注册）。旧会话在自己的状态里钉住了预设 id（例如 `private-v1`），恢复时在当前组合里查不到定义，于是报 `Unknown agent preset`。新会话用的是内置预设（standard / minimal / ptc / cordis），不受影响。

## 判定你是否受影响

1. 存在 `$DSH_HOME/.agent-presets/` 目录（Windows 默认即 `%USERPROFILE%\.dsh\.agent-presets\`，自定义过 `DSH_HOME` 的在对应数据目录下）；
2. 里面有旧预设的子目录；
3. 有在 0.1.x 里创建、并切换到过这些预设的旧会话。

三条全中就会复现。

## 迁移步骤（官方指引 + 实测）

### ① 定位旧预设

每个子目录就是一个预设：`preset.yml` 给出展示名与描述，`agent.cordis.yml` 是完整的插件组合清单。

### ② 写入声明行

编辑**宿主级用户补丁** `$DSH_HOME/cordis.patch.yml`（该层作用于所有 profile，且不会被应用改写 profile 配置时冲掉；也可以放在单个 profile 的 `cordis.patch.yml` 里）。把每个旧预设翻译成一个声明行：

```yaml
- insert:
    - id: preset-<预设 id>
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: <预设 id>
        name: <preset.yml 里的 name>
        description: <preset.yml 里的 description>
        plugins:
          # 把 agent.cordis.yml 的内容逐行原样粘贴到这里（整体缩进 +10 空格）
          - id: persona
            name: '@deepseek-ai/dsh-persona'
          # ……其余插件行……
```

要点：

- `plugins:` 的内容就是 `agent.cordis.yml` **逐字照抄**（含注释和 `!!js` 表达式，补丁方言支持 `!!js`）；
- Loader 行 `id` 惯例是 `preset-<预设 id>`；
- 官方提醒：**对照检查每个插件包名**——预设写就之后被改名的包会在激活时报错。

### ③ 重启

桌面版需**完全退出**（含托盘）再启动；web 重启 dsh web。

### ④ 验证

- 设置里的 Agent 预设名单应出现迁移过来的预设；
- 出错的旧会话切换模型不再报错。

### ⑤ 清理

确认正常后，按官方指引删除 `.agent-presets/` 旧目录。

## 常见坑

| 坑 | 说明 |
| --- | --- |
| 激活失败但预设出现在名单上 | 属预期失败模式（fail-soft）：某插件行改名/配置字段变更导致激活失败，名单会带诊断信息且该预设无法组合会话——不影响其他会话，修好插件行再重启即可 |
| `!!js` 表达式 | 补丁方言支持（如 `!!js process.env.DSH_CWD ?? process.cwd()`），标准 YAML 解析器会拒绝它，属正常 |
| 补丁层的选择 | 宿主级 `$DSH_HOME/cordis.patch.yml` 作用于所有 profile；只想给单个 profile 用就写进该 profile 的 `cordis.patch.yml` |
| web / 桌面 profile 预设隔离 | 预设声明来自组合配置，两个 profile 各自加载——想让两边都有就都声明（用宿主级补丁可以只写一份） |

## 实测记录（本仓库作者）

- 受影响预设：`private-v1`（私人模式 V1，9 个插件行）、`minimal-v3`（极简 V3，4 个插件行）；
- 迁移方式：上述步骤 ②，写入 `$DSH_HOME/cordis.patch.yml`（作者自定义了 `DSH_HOME` 指向数据目录）；
- 全部插件包名在 0.2.0-rc.2 运行时下均为现役名称，激活即成功；
- 验证：重启桌面版后，此前报错的旧会话恢复与切换模型正常，预设名单出现两个迁移项。

## 参考

- 官方迁移指引：deepseek-harness 仓库 `packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md`（"Migrate a legacy preset" 一节）
- 预设声明行结构：同仓库 `packages/preset/agent-preset-registry/src/index.ts`
- 本插件相关：[README 兼容性与卸载](../README.md#-兼容性与卸载)
