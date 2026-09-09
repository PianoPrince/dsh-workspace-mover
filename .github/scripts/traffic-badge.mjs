// Daily GitHub traffic collection for the public README badges.
// GitHub exposes a rolling 14-day window; the daily rows are persisted in a Gist.
import { buildBadgeFiles, buildState, mergeHistory, normalizeClonesResponse, parseHistory } from './traffic-badge-core.mjs';

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

let snapshot;
try {
	snapshot = normalizeClonesResponse(clones.body);
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
const files = {
	[stateFile]: { content: JSON.stringify(state) },
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
