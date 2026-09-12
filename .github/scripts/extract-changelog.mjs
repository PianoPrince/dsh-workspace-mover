// 从 CHANGELOG.md 提取指定版本的说明段落，输出到 stdout（release.yml 使用）。
// 用法：node extract-changelog.mjs v0.7.0
import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const version = tag.replace(/^v/, '');
const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## \\[?${escapedVersion}\\]?`, 'm');
const start = text.search(heading);
if (start < 0) {
	console.error(`CHANGELOG.md has no section for version ${version}`);
	process.exit(1);
}
const rest = text.slice(start + text.slice(start).indexOf('\n') + 1);
// 段落终点：下一个版本标题（## x.y.z 或 ## [x.y.z]）或文末
const next = rest.search(/^## \[?\d+\.\d+\.\d+\]?/m);
let section = (next >= 0 ? rest.slice(0, next) : rest).trim();
section = section.replace(/\n+All notable changes to this project are documented here\.\s*$/, '').trim();
console.log(section);
