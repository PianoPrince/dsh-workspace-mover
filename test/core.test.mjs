// 核心纯函数单元测试：帧扫描 / 头部读写 / 存储路径编码。
// 运行：npm test（或 node --test test/）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync, constants } from 'node:zlib';
import { scanFrames, readHeader, rewriteHeaderCwd } from '../lib/index.js';

const OPTS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/** 构造一个「头 + N 个事件帧」的合成档案。 */
function makeArtifact(header, events) {
  const head = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), OPTS);
  const rest = events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8'), OPTS));
  return Buffer.concat([head, ...rest]);
}

test('scanFrames 定位全部帧边界', () => {
  const buf = makeArtifact({ type: 'session', id: 's1', cwd: 'E:\\a' }, [{ seq: 1 }, { seq: 2 }]);
  const frames = scanFrames(buf);
  assert.equal(frames.length, 3);
  for (const [s, e] of frames) assert.ok(e > s && e <= buf.length);
});

test('readHeader 解出首行会话头', () => {
  const buf = makeArtifact({ type: 'session', id: 'session-x', cwd: 'C:\\work' }, [{ seq: 1 }]);
  const header = readHeader(buf);
  assert.equal(header.type, 'session');
  assert.equal(header.id, 'session-x');
  assert.equal(header.cwd, 'C:\\work');
});

test('rewriteHeaderCwd 只改头部，其余帧字节不变', () => {
  const ev = [{ seq: 1, text: 'hello 世界' }, { seq: 2 }];
  const original = makeArtifact({ type: 'session', id: 'session-y', cwd: 'E:\\old\\path' }, ev);
  const rewritten = rewriteHeaderCwd(original, 'E:\\new\\home');
  // 头部已更新
  const header = readHeader(rewritten);
  assert.equal(header.cwd, 'E:\\new\\home');
  assert.equal(header.id, 'session-y');
  // 其余事件帧逐字节保留
  const of = scanFrames(original), nf = scanFrames(rewritten);
  assert.equal(nf.length, of.length);
  assert.ok(of.slice(1).every(([, e], i) => original.subarray(of[i + 1][0], e).equals(rewritten.subarray(nf[i + 1][0], nf[i + 1][1]))));
});

test('损坏档案被拒绝而不是静默通过', () => {
  const buf = makeArtifact({ type: 'session', id: 's', cwd: 'x' }, []);
  buf.writeUInt32LE(0x12345678, 8); // 破坏第一帧内部
  assert.throws(() => readHeader(buf));
});
