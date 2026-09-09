const REPO = process.env.REPO ?? 'PianoPrince/dsh-workspace-mover';
const GIST_ID = process.env.GIST_ID ?? 'c14345658550a4a308570acfbaf9d170';
const TOKEN = process.env.TRAFFIC_TOKEN;
const ASSET_PREFIX = 'dsh-workspace-mover-';

if (!TOKEN) {
	console.error('TRAFFIC_TOKEN is not set.');
	process.exit(1);
}

const api = async (path, options = {}) => {
	const res = await fetch(`https://api.github.com${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'dsh-workspace-mover-release-downloads',
			...(options.body ? { 'Content-Type': 'application/json' } : {})
		}
	});
	const body = await res.json().catch(() => ({}));
	return { status: res.status, body };
};

const releases = await api(`/repos/${REPO}/releases?per_page=100`);
if (releases.status !== 200 || !Array.isArray(releases.body)) {
	console.error(`release list failed (HTTP ${releases.status}): ${JSON.stringify(releases.body?.message ?? releases.body)}`);
	process.exit(1);
}

const assets = releases.body.flatMap((release) => (release.assets ?? [])
	.filter((asset) => typeof asset.name === 'string' && asset.name.startsWith(ASSET_PREFIX) && /\.(tgz|zip)$/i.test(asset.name))
	.map((asset) => ({ tag: release.tag_name, name: asset.name, downloads: Number(asset.download_count) || 0 })));
const total = assets.reduce((sum, asset) => sum + asset.downloads, 0);
const badge = total > 10
	? `<svg xmlns="http://www.w3.org/2000/svg" width="190" height="20" role="img" aria-label="Release downloads: ${total}"><rect width="190" height="20" fill="#555"/><rect x="112" width="78" height="20" fill="#4c1"/><text x="56" y="14" fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">Release downloads</text><text x="151" y="14" fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">${total}</text></svg>`
	: '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" />';

const gist = await api(`/gists/${GIST_ID}`);
if (gist.status !== 200) {
	console.error(`gist read failed (HTTP ${gist.status}): ${JSON.stringify(gist.body?.message ?? gist.body)}`);
	process.exit(1);
}
const files = {
	'wsm-release-downloads.json': { content: JSON.stringify({ schemaVersion: 1, total, threshold: 10, updatedAt: new Date().toISOString(), assets }) },
	'wsm-release-downloads.svg': { content: badge }
};
const patched = await api(`/gists/${GIST_ID}`, { method: 'PATCH', body: JSON.stringify({ files }) });
if (patched.status !== 200) {
	console.error(`gist update failed (HTTP ${patched.status}): ${JSON.stringify(patched.body?.message ?? patched.body)}`);
	process.exit(1);
}
console.log(`release downloads updated: ${total} across ${assets.length} assets; visible=${total > 10}`);
