// 从 CHANGELOG.md 提取指定版本的说明段落，输出到 stdout（release.yml 使用）。
// 用法：node extract-changelog.mjs v0.7.0
import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const version = tag.replace(/^v/, '');
const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

const start = text.indexOf(`## [${version}]`);
if (start < 0) {
	console.error(`CHANGELOG.md has no section for version ${version}`);
	process.exit(1);
}
const rest = text.slice(start + `## [${version}]`.length);
// 段落终点：下一个版本标题（## [x.y.z]）或文末
const next = rest.search(/^## \[\d+\.\d+\.\d+\]/m);
let section = (next >= 0 ? rest.slice(0, next) : rest).trim();
// 标题行的日期残余（"- 2026-08-28"）不进正文
if (section.startsWith('-')) section = section.slice(section.indexOf('\n') + 1).trim();

// 标题行换成 tag 名，正文原样保留（## [0.7.0] - 2026-08-28 → 保留日期更有信息量）
console.log(section);
