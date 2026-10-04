import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBadgeFiles, buildState, buildStructuredDaily, mergeHistory, normalizeClonesResponse, normalizePathsResponse, normalizeReferrersResponse, normalizeViewsResponse, parseHistory } from '../.github/scripts/traffic-badge-core.mjs';

const snapshot = {
	count: 12,
	uniques: 7,
	clones: [
		{ timestamp: '2026-09-08T00:00:00Z', count: 5, uniques: 3 },
		{ timestamp: '2026-09-09T00:00:00Z', count: 7, uniques: 4 }
	]
};

test('traffic response uses GitHub clones[] rows and rejects the old days[] shape', () => {
	const normalized = normalizeClonesResponse(snapshot);
	assert.deepEqual(normalized.days, [
		{ date: '2026-09-08', count: 5, uniques: 3 },
		{ date: '2026-09-09', count: 7, uniques: 4 }
	]);
	assert.throws(() => normalizeClonesResponse({ count: 12, uniques: 7, days: snapshot.clones }), /no clones array/);
});

test('traffic normalizes views, referrers, and popular paths', () => {
	assert.deepEqual(normalizeViewsResponse({ count: 9, uniques: 4, views: [{ timestamp: '2026-09-09T00:00:00Z', count: 9, uniques: 4 }] }).days, [
		{ date: '2026-09-09', count: 9, uniques: 4 }
	]);
	assert.deepEqual(normalizeReferrersResponse([{ referrer: 'github.com', count: 3, uniques: 2 }]), [
		{ referrer: 'github.com', count: 3, uniques: 2 }
	]);
	assert.deepEqual(normalizePathsResponse([{ path: '/README.md', title: 'README', count: 5, uniques: 3 }]), [
		{ path: '/README.md', title: 'README', count: 5, uniques: 3 }
	]);
});

test('history upsert replaces corrected dates without double counting', () => {
	const old = parseHistory('{"date":"2026-09-08","count":4,"uniques":2}\n');
	const merged = mergeHistory(old, [
		{ date: '2026-09-08', count: 5, uniques: 3 },
		{ date: '2026-09-09', count: 7, uniques: 4 }
	]);
	assert.deepEqual(merged, [
		{ date: '2026-09-08', count: 5, uniques: 3 },
		{ date: '2026-09-09', count: 7, uniques: 4 }
	]);
	const state = buildState({}, merged, normalizeClonesResponse(snapshot), '2026-09-10T00:00:00Z');
	assert.equal(state.cumulativeClones, 12);
	assert.equal(state.observedSince, '2026-09-08');
});

test('schema migration preserves the old value as a legacy estimate only', () => {
	const state = buildState({ cumulative: 193 }, [], { ...normalizeClonesResponse(snapshot), days: [] }, '2026-09-10T00:00:00Z');
	assert.equal(state.schemaVersion, 2);
	assert.equal(state.cumulativeClones, 0);
	assert.equal(state.legacyEstimate, 193);
	assert.equal(state.lastWindow.count, 12);
});

test('badge exposes only observed GitHub clones and 14d uniques', () => {
	const state = buildState({}, parseHistory('{"date":"2026-09-08","count":5,"uniques":3}\n{"date":"2026-09-09","count":7,"uniques":4}\n'), normalizeClonesResponse(snapshot), '2026-09-10T00:00:00Z');
	const files = buildBadgeFiles(state);
	const total = JSON.parse(files['wsm-clones-total.json'].content);
	assert.equal(total.label, 'GitHub clones observed');
	assert.match(total.message, /12 since 2026-09-08/);
	assert.match(total.message, /7 unique \(14d\)/);
	assert.equal(files['wsm-clones-14d.json'], undefined);
});

test('structured daily backfills JSONL-only early days without clobbering views', () => {
	const existing = [{ date: '2026-09-09', clones: { date: '2026-09-09', count: 7, uniques: 4 }, views: { date: '2026-09-09', count: 2, uniques: 1 } }];
	const historyRows = parseHistory('{"date":"2026-09-07","count":1,"uniques":1}\n{"date":"2026-09-08","count":5,"uniques":3}\n{"date":"2026-09-09","count":99,"uniques":99}\n');
	const cloneDays = [{ date: '2026-09-09', count: 7, uniques: 4 }];
	const viewDays = [{ date: '2026-09-09', count: 2, uniques: 1 }];
	const daily = buildStructuredDaily(existing, historyRows, cloneDays, viewDays);
	assert.deepEqual(daily.map((row) => row.date), ['2026-09-07', '2026-09-08', '2026-09-09']);
	assert.deepEqual(daily[0].clones, { date: '2026-09-07', count: 1, uniques: 1 });
	assert.equal(daily[0].views, undefined, 'JSONL 回填行没有 views 数据');
	// JSONL 与快照冲突时快照优先：09-09 保持 7/4，且 views 不丢
	assert.deepEqual(daily[2].clones, { date: '2026-09-09', count: 7, uniques: 4 });
	assert.deepEqual(daily[2].views, { date: '2026-09-09', count: 2, uniques: 1 });
});
