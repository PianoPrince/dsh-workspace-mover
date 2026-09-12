// Daily GitHub traffic collection for the public README badges.
// GitHub exposes a rolling 14-day window; the daily rows are persisted in a Gist.
import { buildBadgeFiles, buildState, mergeHistory, normalizeClonesResponse, normalizePathsResponse, normalizeReferrersResponse, normalizeViewsResponse, parseHistory } from './traffic-badge-core.mjs';

const REPO = process.env.REPO ?? 'PianoPrince/dsh-workspace-mover';
const GIST_ID = process.env.GIST_ID ?? 'c14345658550a4a308570acfbaf9d170';
const TOKEN = process.env.TRAFFIC_TOKEN;

if (!TOKEN) {
	console.error('TRAFFIC_TOKEN is not set — add a repository secret with access to repository traffic and the Gist.');
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
if (clones.status !== 200) {
	console.error(`traffic/clones failed (HTTP ${clones.status}): ${JSON.stringify(clones.body?.message ?? clones.body)}`);
	process.exit(1);
}

const views = await api(`/repos/${REPO}/traffic/views`);
const referrers = await api(`/repos/${REPO}/traffic/popular/referrers`);
const paths = await api(`/repos/${REPO}/traffic/popular/paths`);
for (const [label, response] of [['views', views], ['popular referrers', referrers], ['popular paths', paths]]) {
	if (response.status !== 200) {
		console.error(`${label} failed (HTTP ${response.status}): ${JSON.stringify(response.body?.message ?? response.body)}`);
		process.exit(1);
	}
}

let snapshot;
let viewsSnapshot;
let referrersSnapshot;
let pathsSnapshot;
try {
	snapshot = normalizeClonesResponse(clones.body);
	viewsSnapshot = normalizeViewsResponse(views.body);
	referrersSnapshot = normalizeReferrersResponse(referrers.body);
	pathsSnapshot = normalizePathsResponse(paths.body);
} catch (err) {
	console.error(`traffic/clones response is invalid: ${err?.message ?? err}`);
	process.exit(1);
}

const gist = await api(`/gists/${GIST_ID}`);
if (gist.status !== 200) {
	console.error(`gist read failed (HTTP ${gist.status}): ${JSON.stringify(gist.body?.message ?? gist.body)}`);
	process.exit(1);
}

const previousHistory = parseHistory(gist.body.files['wsm-traffic-history.jsonl']?.content ?? '');
const rows = mergeHistory(previousHistory, snapshot.days);
const stateFile = 'wsm-traffic-state.json';
let previousState = {};
try {
	previousState = JSON.parse(gist.body.files[stateFile]?.content ?? '{}');
} catch {
	// A malformed state is treated as a fresh baseline; the old value is not trusted.
}
const state = buildState(previousState, rows, snapshot);
let trafficHistory = { schemaVersion: 1, daily: [], popularSnapshots: [] };
try {
	trafficHistory = JSON.parse(gist.body.files['wsm-traffic-history.json']?.content ?? JSON.stringify(trafficHistory));
} catch {
	// Start a new structured history file if the previous one is malformed.
}
const dailyByDate = new Map((Array.isArray(trafficHistory.daily) ? trafficHistory.daily : []).map((row) => [row.date, row]));
for (const day of snapshot.days) dailyByDate.set(day.date, { ...dailyByDate.get(day.date), date: day.date, clones: day });
for (const day of viewsSnapshot.days) dailyByDate.set(day.date, { ...dailyByDate.get(day.date), date: day.date, views: day });
trafficHistory.daily = [...dailyByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
trafficHistory.popularSnapshots = Array.isArray(trafficHistory.popularSnapshots) ? trafficHistory.popularSnapshots : [];
trafficHistory.popularSnapshots.push({ collectedAt: state.updatedAt, referrers: referrersSnapshot, paths: pathsSnapshot });
trafficHistory.updatedAt = state.updatedAt;
const files = {
	[stateFile]: { content: JSON.stringify(state) },
	'wsm-traffic-history.json': { content: JSON.stringify(trafficHistory) },
	...buildBadgeFiles(state)
};
if (rows.length > 0) files['wsm-traffic-history.jsonl'] = { content: rows.map((row) => JSON.stringify(row)).join('\n') + '\n' };
if (gist.body.files['wsm-clones-14d.json']) files['wsm-clones-14d.json'] = { content: '' };

const patched = await api(`/gists/${GIST_ID}`, { method: 'PATCH', body: JSON.stringify({ files }) });
if (patched.status !== 200) {
	console.error(`gist update failed (HTTP ${patched.status}): ${JSON.stringify(patched.body?.message ?? patched.body)}`);
	process.exit(1);
}
console.log(`traffic badge updated: 14d=${snapshot.count} (${snapshot.uniques} uniques), days on record=${rows.length}, cumulative=${state.cumulativeClones}, observedSince=${state.observedSince}, quality=${state.quality}`);
