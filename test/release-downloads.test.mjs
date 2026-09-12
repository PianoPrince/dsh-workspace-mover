import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyReleaseBadgeToMarkdown, buildReleaseBadgeFiles, RELEASE_BADGE_END, RELEASE_BADGE_START, summarizeReleaseAssets } from '../.github/scripts/release-downloads-core.mjs';

const gistId = 'c14345658550a4a308570acfbaf9d170';

test('counts prefixed tgz/zip assets and hides the badge at 10 or fewer downloads', () => {
	const summary = summarizeReleaseAssets([
		{
			tag_name: 'v1.4.2',
			assets: [
				{ name: 'dsh-workspace-mover-1.4.2.tgz', download_count: 6 },
				{ name: 'dsh-workspace-mover-1.4.2.zip', download_count: 4 },
				{ name: 'source.tar.gz', download_count: 99 }
			]
		}
	]);
	assert.equal(summary.total, 10);
	assert.equal(summary.visible, false);
	assert.equal(summary.assets.length, 2);
});

test('shows a shields.io endpoint badge only after the total exceeds 10', () => {
	const summary = summarizeReleaseAssets([
		{ tag_name: 'v2.0.0', assets: [{ name: 'dsh-workspace-mover-2.0.0.tgz', download_count: 11 }] }
	]);
	assert.equal(summary.visible, true);
	const files = buildReleaseBadgeFiles({ total: summary.total, assets: summary.assets, updatedAt: '2026-09-10T00:00:00Z', visible: summary.visible });
	const badge = JSON.parse(files['wsm-release-downloads.json'].content);
	assert.equal(badge.label, 'Release downloads');
	assert.equal(badge.message, '11');
	assert.equal(badge.color, 'blue');
	assert.equal(files['wsm-release-downloads.svg'], null);
});

test('hidden state deletes gist SVG and shields files so GitHub cannot render a broken alt-text link', () => {
	const files = buildReleaseBadgeFiles({ total: 3, assets: [], updatedAt: '2026-09-10T00:00:00Z', visible: false });
	assert.equal(files['wsm-release-downloads.json'], null);
	assert.equal(files['wsm-release-downloads.svg'], null);
	const data = JSON.parse(files['wsm-release-downloads-data.json'].content);
	assert.equal(data.total, 3);
	assert.equal(data.visible, false);
});

test('README keeps an invisible marker below 10 and a shields graphic above 10', () => {
	const source = [
		'<p>',
		'    <img alt="GitHub clones observed" src="https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2FPianoPrince%2Fc14345658550a4a308570acfbaf9d170%2Fraw%2Fwsm-clones-total.json" style="height:20px; margin:0 2px;" />',
		'    <img alt="Release downloads (shown after 10 downloads)" src="https://gist.githubusercontent.com/PianoPrince/c14345658550a4a308570acfbaf9d170/raw/wsm-release-downloads.svg" style="height:20px; margin:0 2px;" />',
		'</p>'
	].join('\n');
	const hidden = applyReleaseBadgeToMarkdown(source, { visible: false, gistId });
	assert.equal(hidden.includes('wsm-release-downloads.svg'), false);
	assert.equal(hidden.includes('Release downloads (shown after 10 downloads)'), false);
	assert.equal(hidden.includes('<img alt="Release downloads"'), false);
	assert.equal(hidden.includes(RELEASE_BADGE_START), true);
	assert.equal(hidden.includes(RELEASE_BADGE_END), true);
	const shown = applyReleaseBadgeToMarkdown(hidden, { visible: true, gistId });
	assert.equal(shown.includes('img.shields.io/endpoint?url='), true);
	assert.equal(shown.includes('wsm-release-downloads.json'), true);
	assert.equal(shown.includes('wsm-release-downloads.svg'), false);
	assert.equal(shown.includes('<img alt="Release downloads"'), true);
});

test('extract-changelog accepts both current and historical heading styles', () => {
        const script = fileURLToPath(new URL('../.github/scripts/extract-changelog.mjs', import.meta.url));
        const current = execFileSync(process.execPath, [script, 'v2.0.1'], { encoding: 'utf8' });
        const historical = execFileSync(process.execPath, [script, 'v1.4.2'], { encoding: 'utf8' });
        assert.match(current, /Compatible with DeepSeek Harness/);
        assert.match(historical, /GitHub Release tags now publish/);
        assert.doesNotMatch(historical, /Compatible with DeepSeek Harness/);
});
