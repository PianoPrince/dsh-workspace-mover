// 每日流量徽章更新：拉仓库 traffic API → 维护一个只增不减的累计克隆徽章。
// 需要 TRAFFIC_TOKEN（classic PAT，勾 repo + gist 权限；仓库自带 GITHUB_TOKEN 无 traffic/gist 权限）。
// 历史与徽章都存在 Gist 里，仓库分支零提交，保持主历史干净。
//
// 累计算法（GitHub 只提供 14 天窗口，且 days[] 会间歇性返回空）：
//   cumulative = max(上次累计, 全部已记录日期之和 + carry)
//   carry = max(0, 本次 14 天总数 − 已记录日期中落在窗口内的部分)
// carry 每次重算而非累加：days[] 为空的运行把"看得见总数但拆不出日期"的部分计入，
// days[] 恢复后 carry 自然归零，不会重复计数；棘轮保证累计数永不回退。
const REPO = process.env.REPO ?? 'PianoPrince/dsh-workspace-mover';
const GIST_ID = process.env.GIST_ID ?? 'c14345658550a4a308570acfbaf9d170';
const TOKEN = process.env.TRAFFIC_TOKEN;

if (!TOKEN) {
	console.error('TRAFFIC_TOKEN is not set — add a classic PAT (repo+gist) as a repository secret.');
	process.exit(1);
}

const api = async (path, options = {}) => {
	const res = await fetch(`https://api.github.com${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'dsh-workspace-mover-traffic-badge',
			...(options.body ? { 'Content-Type': 'application/json' } : {})
		}
	});
	const body = await res.json().catch(() => ({}));
	return { status: res.status, body };
};

const clones = await api(`/repos/${REPO}/traffic/clones`);
if (clones.status !== 200 || typeof clones.body?.count !== 'number') {
	console.error(`traffic/clones failed (HTTP ${clones.status}): ${JSON.stringify(clones.body?.message ?? clones.body)}. ` +
		'403/404 通常意味着 TRAFFIC_TOKEN 缺 repo 权限或已过期。');
	process.exit(1);
}

const gist = await api(`/gists/${GIST_ID}`);
if (gist.status !== 200) {
	console.error(`gist read failed (HTTP ${gist.status}): ${JSON.stringify(gist.body?.message ?? gist.body)}.`);
	process.exit(1);
}

// 历史合并：只新增未见过的日期（GitHub 只回 14 天窗口；缺失日子顺其自然）
const rows = [];
const seen = new Set();
for (const line of String(gist.body.files['wsm-traffic-history.jsonl']?.content ?? '').split('\n')) {
	if (!line.trim()) continue;
	try {
		const row = JSON.parse(line);
		rows.push(row);
		seen.add(row.date);
	} catch { /* 跳过坏行 */ }
}
for (const day of clones.body.days ?? []) {
	const date = String(day.timestamp).slice(0, 10);
	if (!seen.has(date)) {
		rows.push({ date, count: day.count, uniques: day.uniques });
		seen.add(date);
	}
}
rows.sort((a, b) => (a.date < b.date ? -1 : 1));

// 窗口内已记录的部分：优先用响应里出现的日期集合，days[] 为空时退化为"最近 14 天"
const windowDates = (clones.body.days ?? []).map((day) => String(day.timestamp).slice(0, 10));
const windowSet = windowDates.length > 0 ? new Set(windowDates) : null;
const inWindow = (date) => {
	if (windowSet) return windowSet.has(date);
	const ms = Date.parse(`${date}T00:00:00Z`);
	if (Number.isNaN(ms)) return false;
	const now = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
	return ms > now - 14 * 86400000 && ms <= now;
};
const knownWindow = rows.reduce((sum, row) => sum + (inWindow(row.date) ? row.count : 0), 0);
const carry = Math.max(0, clones.body.count - knownWindow);
const sumAll = rows.reduce((sum, row) => sum + row.count, 0);

// 棘轮：只增不减
const stateFile = 'wsm-traffic-state.json';
let prevCumulative = 0;
try {
	prevCumulative = JSON.parse(gist.body.files[stateFile]?.content ?? '{}').cumulative ?? 0;
} catch { /* 坏内容当作 0 */ }
const cumulative = Math.max(prevCumulative, sumAll + carry);

const badge = (label, message) => JSON.stringify({ schemaVersion: 1, label, message, color: 'blue' }, null, 0);
const files = {
	[stateFile]: { content: JSON.stringify({ cumulative, updatedAt: new Date().toISOString() }) },
	'wsm-clones-total.json': { content: badge('git clones', `${cumulative} total`) }
};
// 空 content 会被 GitHub 当作删除操作而 422：历史文件只在有内容时提交
if (rows.length > 0) files['wsm-traffic-history.jsonl'] = { content: rows.map((r) => JSON.stringify(r)).join('\n') + '\n' };
// 14d 徽章已退役：gist 里还留着就删掉（空 content = 删除，仅在文件存在时执行一次）
if (gist.body.files['wsm-clones-14d.json']) files['wsm-clones-14d.json'] = { content: '' };

const patched = await api(`/gists/${GIST_ID}`, { method: 'PATCH', body: JSON.stringify({ files }) });
if (patched.status !== 200) {
	console.error(`gist update failed (HTTP ${patched.status}): ${JSON.stringify(patched.body?.message ?? patched.body)}.`);
	process.exit(1);
}
console.log(`traffic badge updated: 14d=${clones.body.count} (${clones.body.uniques} uniques), days on record=${rows.length}, carry=${carry}, cumulative=${cumulative}`);
