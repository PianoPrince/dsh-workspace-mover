const RELEASE_DOWNLOADS_THRESHOLD = 10;
const RELEASE_BADGE_START = '<!-- release-downloads-badge:start -->';
const RELEASE_BADGE_END = '<!-- release-downloads-badge:end -->';
const DEFAULT_OWNER = 'PianoPrince';
const DEFAULT_PREFIX = 'dsh-workspace-mover-';
const ASSET_EXT = /\.(tgz|zip)$/i;

export { RELEASE_DOWNLOADS_THRESHOLD, RELEASE_BADGE_START, RELEASE_BADGE_END };

export function shieldsReleaseDownloadsUrl(gistId, owner) {
	const gistOwner = owner || DEFAULT_OWNER;
	const endpoint = 'https://gist.githubusercontent.com/' + gistOwner + '/' + gistId + '/raw/wsm-release-downloads.json';
	return 'https://img.shields.io/endpoint?url=' + encodeURIComponent(endpoint);
}

export function releaseDownloadsImg(gistId, owner) {
	return '<img alt="Release downloads" src="' + shieldsReleaseDownloadsUrl(gistId, owner) + '" style="height:20px; margin:0 2px;" />';
}

export function summarizeReleaseAssets(releases, options) {
	const prefix = (options && options.prefix) || DEFAULT_PREFIX;
	const assets = [];
	for (const release of releases || []) {
		for (const asset of release.assets || []) {
			if (typeof asset.name === 'string' && asset.name.startsWith(prefix) && ASSET_EXT.test(asset.name)) {
				assets.push({ tag: release.tag_name, name: asset.name, downloads: Number(asset.download_count) || 0 });
			}
		}
	}
	const total = assets.reduce((sum, asset) => sum + asset.downloads, 0);
	return { assets, total, visible: total > RELEASE_DOWNLOADS_THRESHOLD };
}

export function buildReleaseBadgeFiles(input) {
	const total = input.total;
	const assets = input.assets;
	const updatedAt = input.updatedAt;
	const visible = input.visible;
	return {
		'wsm-release-downloads-data.json': {
			content: JSON.stringify({ schemaVersion: 1, total, threshold: RELEASE_DOWNLOADS_THRESHOLD, visible, updatedAt, assets })
		},
		'wsm-release-downloads.json': visible
			? { content: JSON.stringify({ schemaVersion: 1, label: 'Release downloads', message: String(total), color: 'blue' }) }
			: null,
		'wsm-release-downloads.svg': null
	};
}

function escapeRegExp(value) {
	const special = '.*+?^()[]{}|\\';
	return String(value).split('').map(function (ch) {
		return special.includes(ch) ? '\\' + ch : ch;
	}).join('');
}

export function applyReleaseBadgeToMarkdown(markdown, input) {
	const visible = input.visible;
	const gistId = input.gistId;
	const owner = input.owner || DEFAULT_OWNER;
	let text = String(markdown);
	text = text.replace(/\s*<img\b[^>]*wsm-release-downloads[^>]*>/gi, '');
	text = text.replace(/\s*<img\b[^>]*alt="Release downloads[^"]*"[^>]*>/gi, '');
	const inner = visible ? ' ' + releaseDownloadsImg(gistId, owner) + ' ' : '';
	const block = RELEASE_BADGE_START + inner + RELEASE_BADGE_END;
	if (text.includes(RELEASE_BADGE_START) && text.includes(RELEASE_BADGE_END)) {
		return text.replace(new RegExp(escapeRegExp(RELEASE_BADGE_START) + '[\s\S]*?' + escapeRegExp(RELEASE_BADGE_END)), block);
	}
	const clones = /(<img\b[^>]*wsm-clones-total\.json[^>]*>)/i;
	if (clones.test(text)) {
		return text.replace(clones, '$1\n    ' + block);
	}
	return text.trimEnd() + '\n' + block + '\n';
}
