import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReleaseBadgeToMarkdown, buildReleaseBadgeFiles, summarizeReleaseAssets } from './release-downloads-core.mjs';

const REPO = process.env.REPO || 'PianoPrince/dsh-workspace-mover';
const GIST_ID = process.env.GIST_ID || 'c14345658550a4a308570acfbaf9d170';
const TOKEN = process.env.TRAFFIC_TOKEN;
const ASSET_PREFIX = 'dsh-workspace-mover-';
const PATCH_README = process.env.PATCH_README === '1';

if (!TOKEN) {
	console.error('TRAFFIC_TOKEN is not set.');
	process.exit(1);
}

const api = async (urlPath, options = {}) => {
	const res = await fetch('https://api.github.com' + urlPath, {
		...options,
		headers: {
			Authorization: 'Bearer ' + TOKEN,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'dsh-workspace-mover-release-downloads',
			...(options.body ? { 'Content-Type': 'application/json' } : {})
		}
	});
	const body = await res.json().catch(() => ({}));
	return { status: res.status, body };
}

const releases = await api('/repos/' + REPO + '/releases?per_page=100');
if (releases.status !== 200 || !Array.isArray(releases.body)) {
	console.error('release list failed (HTTP ' + releases.status + '): ' + JSON.stringify(releases.body && releases.body.message ? releases.body.message : releases.body));
	process.exit(1);
}

const summary = summarizeReleaseAssets(releases.body, { prefix: ASSET_PREFIX });
const files = buildReleaseBadgeFiles({
	total: summary.total,
	assets: summary.assets,
	updatedAt: new Date().toISOString(),
	visible: summary.visible
});

const gist = await api('/gists/' + GIST_ID);
if (gist.status !== 200) {
	console.error('gist read failed (HTTP ' + gist.status + '): ' + JSON.stringify(gist.body && gist.body.message ? gist.body.message : gist.body));
	process.exit(1);
}

const patched = await api('/gists/' + GIST_ID, { method: 'PATCH', body: JSON.stringify({ files }) });
if (patched.status !== 200) {
	console.error('gist update failed (HTTP ' + patched.status + '): ' + JSON.stringify(patched.body && patched.body.message ? patched.body.message : patched.body));
	process.exit(1);
}

if (PATCH_README) {
	const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
	for (const name of ['README.md', 'README_EN.md']) {
		const filePath = path.join(root, name);
		const before = readFileSync(filePath, 'utf8');
		const after = applyReleaseBadgeToMarkdown(before, { visible: summary.visible, gistId: GIST_ID });
		if (after !== before) writeFileSync(filePath, after);
	}
}

console.log('release downloads updated: ' + summary.total + ' across ' + summary.assets.length + ' assets; visible=' + summary.visible);
