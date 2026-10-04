const DAY_MS = 86400000;

function dateOf(timestamp) {
	const date = String(timestamp ?? '').slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid traffic date: ${timestamp}`);
	return date;
}

function nonNegativeNumber(value, label) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`invalid traffic ${label}: ${value}`);
	return value;
}

export function normalizeClonesResponse(body) {
	if (!body || typeof body !== 'object') throw new Error('traffic response is not an object');
	nonNegativeNumber(body.count, 'count');
	nonNegativeNumber(body.uniques, 'uniques');
	if (!Array.isArray(body.clones)) throw new Error('traffic response has no clones array');
	return {
		count: body.count,
		uniques: body.uniques,
		days: body.clones.map((day) => ({
			date: dateOf(day?.timestamp),
			count: nonNegativeNumber(day?.count, 'daily count'),
			uniques: nonNegativeNumber(day?.uniques, 'daily uniques')
		}))
	};
}

function normalizeWindowResponse(body, field, label) {
	if (!body || typeof body !== 'object') throw new Error(`${label} response is not an object`);
	nonNegativeNumber(body.count, `${label} count`);
	nonNegativeNumber(body.uniques, `${label} uniques`);
	if (!Array.isArray(body[field])) throw new Error(`${label} response has no ${field} array`);
	return {
		count: body.count,
		uniques: body.uniques,
		days: body[field].map((day) => ({
			date: dateOf(day?.timestamp),
			count: nonNegativeNumber(day?.count, `${label} daily count`),
			uniques: nonNegativeNumber(day?.uniques, `${label} daily uniques`)
		}))
	};
}

export function normalizeViewsResponse(body) {
	return normalizeWindowResponse(body, 'views', 'views');
}

function normalizePopularResponse(body, key, label) {
	if (!Array.isArray(body)) throw new Error(`${label} response is not an array`);
	return body.map((item) => ({
		[key]: String(item?.[key] ?? ''),
		...(key === 'path' ? { title: String(item?.title ?? '') } : {}),
		count: nonNegativeNumber(item?.count, `${label} count`),
		uniques: nonNegativeNumber(item?.uniques, `${label} uniques`)
	}));
}

export function normalizeReferrersResponse(body) {
	return normalizePopularResponse(body, 'referrer', 'referrers');
}

export function normalizePathsResponse(body) {
	return normalizePopularResponse(body, 'path', 'paths');
}

export function parseHistory(content) {
	const rows = [];
	for (const line of String(content ?? '').split('\n')) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			rows.push({ date: dateOf(row?.date), count: nonNegativeNumber(row?.count, 'history count'), uniques: nonNegativeNumber(row?.uniques ?? 0, 'history uniques') });
		} catch {
			// Ignore malformed historical rows; the current API snapshot remains usable.
		}
	}
	return rows;
}

export function mergeHistory(existingRows, incomingDays) {
	const byDate = new Map(existingRows.map((row) => [row.date, { ...row }]));
	for (const day of incomingDays) byDate.set(day.date, { ...day });
	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function addDays(date, amount) {
	return new Date(Date.parse(`${date}T00:00:00Z`) + amount * DAY_MS).toISOString().slice(0, 10);
}

function completeWindow(days) {
	if (days.length !== 14) return false;
	const sorted = [...new Set(days.map((day) => day.date))].sort();
	return sorted.length === 14 && sorted.every((date, index) => index === 0 || date === addDays(sorted[index - 1], 1));
}

export function buildState(previousState, rows, snapshot, collectedAt = new Date().toISOString()) {
	const previous = previousState && typeof previousState === 'object' ? previousState : {};
	const legacyEstimate = previous.schemaVersion === 2 ? previous.legacyEstimate : previous.cumulative;
	const state = {
		schemaVersion: 2,
		observedSince: previous.schemaVersion === 2 && previous.observedSince ? previous.observedSince : (rows[0]?.date ?? collectedAt.slice(0, 10)),
		cumulativeClones: rows.reduce((sum, row) => sum + row.count, 0),
		lastWindow: {
			count: snapshot.count,
			uniques: snapshot.uniques,
			start: snapshot.days[0]?.date ?? null,
			end: snapshot.days.at(-1)?.date ?? null
		},
		quality: completeWindow(snapshot.days) ? 'complete' : 'partial',
		updatedAt: collectedAt
	};
	if (typeof legacyEstimate === 'number' && Number.isFinite(legacyEstimate) && legacyEstimate >= 0) state.legacyEstimate = legacyEstimate;
	return state;
}

export function buildBadgeFiles(state) {
	const badge = (label, message) => JSON.stringify({ schemaVersion: 1, label, message, color: 'blue' });
	const uniques = state.lastWindow?.uniques;
	// GitHub 的按天 uniques 跨天相加会把重复克隆者重复计数，得不出真去重的累计值——
	// 徽章上的 uniques 因此永远是最近 14 天窗口的值，后缀 (14d) 消除"累计"歧义。
	const uniqueSuffix = typeof uniques === 'number' && Number.isFinite(uniques) ? ` · ${uniques} unique (14d)` : '';
	return {
		'wsm-clones-total.json': { content: badge('GitHub clones observed', `${state.cumulativeClones} since ${state.observedSince}${uniqueSuffix}`) }
	};
}

/**
 * 结构化每日历史（wsm-traffic-history.json 的 daily）的合并：
 * ① 已有行保留（含 views）；② JSONL 历史里更早的天补进 clones-only 行（v1.4.1
 * 迁移时结构化文件只带保留窗口，起点比 JSONL 晚）；③ 当日 API 快照按 clones/views 覆盖。
 */
export function buildStructuredDaily(existingDaily, historyRows, cloneDays, viewDays) {
	const byDate = new Map((Array.isArray(existingDaily) ? existingDaily : []).map((row) => [row.date, row]));
	for (const row of historyRows ?? []) {
		if (!byDate.has(row.date)) {
			byDate.set(row.date, { date: row.date, clones: { date: row.date, count: row.count, uniques: row.uniques } });
		}
	}
	for (const day of cloneDays) byDate.set(day.date, { ...byDate.get(day.date), date: day.date, clones: day });
	for (const day of viewDays) byDate.set(day.date, { ...byDate.get(day.date), date: day.date, views: day });
	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
