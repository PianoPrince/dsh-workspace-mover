// 每日流量徽章更新：拉仓库 traffic API → 增量合并逐日克隆记录 → 更新 Gist 徽章。
// 需要 TRAFFIC_TOKEN（classic PAT，勾 repo + gist 权限；仓库自带 GITHUB_TOKEN 无 traffic/gist 权限）。
// 历史与徽章都存在 Gist 里，仓库分支零提交，保持主历史干净。
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
const cumulative = rows.reduce((sum, row) => sum + row.count, 0);

const badge = (label, message) => JSON.stringify({ schemaVersion: 1, label, message, color: 'blue' }, null, 0);
const files = {
	'wsm-clones-14d.json': { content: badge('clones (14d)', `${clones.body.count} · ${clones.body.uniques} uniques`) },
	'wsm-traffic-history.jsonl': { content: rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '' }
};
if (cumulative > 0) files['wsm-clones-total.json'] = { content: badge('git clones', `${cumulative} total`) };

const patched = await api(`/gists/${GIST_ID}`, { method: 'PATCH', body: JSON.stringify({ files }) });
if (patched.status !== 200) {
	console.error(`gist update failed (HTTP ${patched.status}): ${JSON.stringify(patched.body?.message ?? patched.body)}.`);
	process.exit(1);
}
console.log(`traffic badge updated: 14d=${clones.body.count} (${clones.body.uniques} uniques), cumulative=${cumulative}, days on record=${rows.length}`);
