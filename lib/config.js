// dsh-workspace-mover — 官方 Config 接入（守卫式，同步、无 boot 风险）
//
// 官方做法：导出 schemastery schema 作为插件 Config，声明 .volatile() 的字段成为设置页
// 上的实时字段。但 @deepseek-ai/schemastery 由**宿主的 loader** 提供（它不是本插件的
// 依赖，也不是本插件目录下可解析的模块）。这里实测：从 lib/index.js 与 lib/config.js
// 出发，`@deepseek-ai/schemastery` 与 npm 上的 `schemastery` **都解析失败**。
//
// 而官方明确记录过一类事故：bundle 层 import 失败会打断 **boot**（有插件 pin 住
// @deepseek-ai/dsh-settings，宿主删除该模块后整个 DSH 起不来）。所以：
//
//   1. 本模块**不做任何静态 import**，也不使用顶层 await（避免模块求值挂起）；
//   2. schema 由注入的构造器同步构造，拿不到就导出 undefined —— 不导出 Config，
//      插件完全照常工作，只是没有设置页；
//   3. 策略的实际生效值永远有环境变量 / 代码默认值兜底（见 lib/index.js 的
//      resolvePolicy），所以"没有设置页"不等于"策略不可调"。
//
// 宿主若通过 Cordis 的 config 机制注入 schema 构造器，apply(ctx, config) 里的
// attachConfig() 会把它接上；未注入时一切照旧。

/** 策略字段定义（与 lib/index.js 的 POLICY_DEFAULTS 一一对应，勿单独改动）。 */
const POLICY_FIELDS = [
	{ key: 'backupKeep', def: 20, max: 1000, desc: '每个会话保留的迁移备份份数' },
	{ key: 'historyLimit', def: 100, max: 10000, desc: '移动历史的保留条数' },
	{ key: 'batchLimit', def: 50, max: 500, desc: '单批移动/修复的会话数上限' },
	{ key: 'repointLimit', def: 200, max: 5000, desc: '单个工作区搬家的会话数上限' },
	{ key: 'scanLimit', def: 400, max: 100000, desc: '救援扫描解析的档案数上限' },
	{ key: 'cleanupDays', def: 30, max: 3650, desc: '「清理 N 天前数据」的默认天数' }
];

/** schemastery 的 .volatile() 只在部分版本存在；缺失时退化为普通字段（仍可配置）。 */
function live(node) {
	return typeof node?.volatile === 'function' ? node.volatile() : node;
}

/**
 * 用给定的 schema 构造器同步构造 Config。构造过程整体包在 try 内：
 * 不同版本的 schemastery 方法集不同（例如 .volatile 常缺），任何一步失败都
 * 必须降级为 undefined，绝不把异常抛到插件启动路径上。
 * @param {any} z schemastery 构造器（需有 z.object / z.number）
 * @returns {any|undefined} schema，或构造失败时 undefined
 */
function buildConfig(z) {
	if (!z || typeof z.object !== 'function' || typeof z.number !== 'function') return undefined;
	try {
		const shape = {};
		for (const { key, def, max } of POLICY_FIELDS) {
			let node = z.number();
			if (typeof node.step === 'function') node = node.step(1);
			if (typeof node.min === 'function') node = node.min(1);
			if (typeof node.max === 'function') node = node.max(max);
			if (typeof node.default === 'function') node = node.default(def);
			shape[key] = live(node);
		}
		return z.object(shape);
	} catch {
		return undefined;
	}
}

/**
 * 从宿主注入的对象上取 schema 构造器并构造 Config。
 * 只接受已经在手上的构造器——不做动态 import，因此不会影响启动时序。
 * @param {any} schemaBuilder 可能的 schemastery 构造器（或带 default 的模块对象）
 */
function attachConfig(schemaBuilder) {
	const z = schemaBuilder?.default ?? schemaBuilder;
	return buildConfig(z);
}

// 本模块导出的 Config 恒为 undefined：插件不主动 import schemastery。
// 宿主若注入构造器，apply 内会用它构造并注册（见 lib/index.js）。
const Config = undefined;

export { Config, POLICY_FIELDS, buildConfig, attachConfig, live };
