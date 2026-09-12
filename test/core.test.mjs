// 核心纯函数单元测试：帧扫描 / 头部读写 / 存储路径编码。
// 运行：npm test（或 node --test test/）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync, constants } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFrames, readHeader, rewriteHeaderCwd, generationLogFilename, parseGenerationLogFilename, findHighestArtifact, artifactPath, sessionDir } from '../lib/index.js';

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

test('readHeader and rewriteHeaderCwd support uncompressed JSONL', () => {
  const original = Buffer.from(
    JSON.stringify({ type: 'session', id: 'session-raw', cwd: 'E:\\old' }) + '\n' +
    JSON.stringify({ seq: 1, text: 'raw event' }) + '\n',
    'utf8'
  );
  assert.equal(readHeader(original, 'none').cwd, 'E:\\old');
  const rewritten = rewriteHeaderCwd(original, 'E:\\new', 'none');
  assert.equal(readHeader(rewritten, 'none').cwd, 'E:\\new');
  const secondLine = rewritten.indexOf(0x0a) + 1;
  assert.equal(rewritten.subarray(secondLine).toString('utf8'), JSON.stringify({ seq: 1, text: 'raw event' }) + '\n');
});


test('generationLogFilename prefers v3 zstd names', () => {
  assert.equal(generationLogFilename(0, 'zstd'), 'session.jsonl.zstd');
  assert.equal(generationLogFilename(3, 'zstd'), 'session.v3.jsonl.zstd');
  assert.equal(parseGenerationLogFilename('session.jsonl.zstd')?.version, 0);
  assert.equal(parseGenerationLogFilename('session.v3.jsonl.zstd')?.version, 3);
  assert.equal(parseGenerationLogFilename('session.migration.tmp.jsonl.zstd'), null);
});

test('findHighestArtifact picks the newest canonical generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'wsm-gen-'));
  try {
    const dir = join(root, 'sess');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.from('old'));
    writeFileSync(join(dir, 'session.v2.jsonl.zstd'), Buffer.from('mid'));
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.from('new'));
    writeFileSync(join(dir, 'session.migration.abc.jsonl.zstd'), Buffer.from('tmp'));
    const found = findHighestArtifact(dir);
    assert.equal(found?.version, 3);
    assert.equal(found?.name, 'session.v3.jsonl.zstd');
    assert.equal(artifactPath(root, 'E:\\proj', 'session-x'), join(sessionDir(root, 'E:\\proj', 'session-x'), 'session.v3.jsonl.zstd'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findHighestArtifact supports the official uncompressed encoding', () => {
  const root = mkdtempSync(join(tmpdir(), 'wsm-raw-'));
  try {
    const dir = join(root, 'sess');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v3.jsonl'), Buffer.from('{"type":"session"}\n'));
    const found = findHighestArtifact(dir, 'none');
    assert.equal(found?.name, 'session.v3.jsonl');
    assert.equal(artifactPath(root, 'E:\\proj', 'session-x', 'none'), join(sessionDir(root, 'E:\\proj', 'session-x'), 'session.v3.jsonl'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mixed session compression encodings are rejected explicitly', () => {
  const root = mkdtempSync(join(tmpdir(), 'wsm-mixed-'));
  try {
    const dir = join(root, 'sess');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v3.jsonl'), Buffer.from('{}\n'));
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.from('not-zstd'));
    assert.throws(() => findHighestArtifact(dir, 'zstd'), (err) => {
      assert.equal(err.code, 'unsupported');
      assert.match(err.message, /mixed session compression encodings/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
