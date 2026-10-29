// GEN3 P0.1 观测层回归：trace 脱敏、prompt 快照、白名单、落盘、recorder 兜底、离线回放。
// 只用合成数据与临时目录，不访问 QQ / DSH / 网络。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildTurnRecord,
  createTraceWriter,
  createTurnRecorder,
  hashId,
  newTurnId,
  redactKey,
  snapshotPrompt
} from '../src/simulation/trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPLAY = path.join(HERE, 'simulation-replay.mjs');
const REPLAY_SOURCE = fs.readFileSync(REPLAY, 'utf8');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sim-trace-'));
}

test('hashId / redactKey：稳定、不落明文标识符', () => {
  assert.equal(hashId('private:123456789'), hashId('private:123456789'), '同输入必须同哈希');
  assert.notEqual(hashId('a'), hashId('b'));
  assert.match(hashId('x'), /^h_[0-9a-f]{8}$/);
  const redacted = redactKey('private:123456789');
  assert.match(redacted, /^private:h_[0-9a-f]{8}$/);
  assert.ok(!redacted.includes('123456789'), '脱敏后不得残留 QQ 号');
  assert.match(redactKey('group:12345'), /^group:h_/);
});

test('snapshotPrompt：按【段名】切段，多一段/少一段可被发现', () => {
  const text = '【你的身份】测试\n\n【会话令牌】tok\n\n【此刻状态】未读 0 条\n\n【唤醒】group:1\n原因：消息';
  const snap = snapshotPrompt(text);
  assert.equal(snap.segmentCount, 4);
  assert.deepEqual(snap.segments.map((s) => s.name), ['你的身份', '会话令牌', '此刻状态', '唤醒']);
  assert.equal(snap.totalChars, text.length);
  assert.ok(snap.hash.length === 12);
  // 加一段立刻反映在段名清单里（这就是「多一段」回归的抓手）
  const snap2 = snapshotPrompt(`${text}\n\n【新加的段】xxx`);
  assert.equal(snap2.segmentCount, 5);
  assert.ok(snap2.segments.some((s) => s.name === '新加的段'));
  // 快照不携带正文
  assert.ok(!JSON.stringify(snap).includes('未读 0 条'));
});

test('buildTurnRecord：字段白名单，未知字段（可能带正文）一律丢弃', () => {
  const rec = buildTurnRecord({
    turnId: 't_1',
    key: 'private:123456789',
    wakeReason: 'message',
    text: '秘密内容不得入盘',
    someDebugBlob: { hello: 'world' }
  });
  assert.equal(rec.key, redactKey('private:123456789'));
  assert.deepEqual(rec.droppedFields.sort(), ['someDebugBlob', 'text']);
  const dumped = JSON.stringify(rec);
  assert.ok(!dumped.includes('秘密内容'), '白名单必须挡住正文');
  assert.ok(!dumped.includes('world'));
  assert.equal(rec.textChars, null);
  assert.equal(rec.send?.attempted ?? null, null);
});

test('traceWriter：按日分文件追加 JSONL，可回读', () => {
  const dir = tmpDir();
  const writer = createTraceWriter({ dir });
  const at = new Date('2026-03-04T12:00:00.000Z');
  writer.write(buildTurnRecord({ turnId: 't_a', key: 'group:1' }), at);
  writer.write(buildTurnRecord({ turnId: 't_b', key: 'group:1' }), at);
  const file = writer.fileFor(at);
  assert.match(path.basename(file), /^simulation-trace-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const rows = writer.read(at);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.turnId), ['t_a', 't_b']);
});

test('turnRecorder：投递→turn/start→turn/end 全链路落盘；非仿真回合不落盘；异常自兜底', () => {
  const dir = tmpDir();
  const writer = createTraceWriter({ dir });
  const rec = createTurnRecorder({ writer });
  rec.queueDelivery('sess-1', {
    key: 'private:123456789',
    wakeReason: 'message',
    promptText: '【你的身份】x\n\n【唤醒】k',
    attention: { source: 'rule-v3-shadow', predictedAction: 'speak', score: 1 }
  });
  rec.onTurnStart('sess-1', 'turn-42');
  rec.onTurnEnd('sess-1', { reasonKind: 'completed', sendAttempted: true, sendOk: true, textChars: 6 });
  const rows = writer.read(new Date());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turnId, 'turn-42');
  assert.equal(rows[0].key, redactKey('private:123456789'));
  assert.equal(rows[0].promptSnapshot.segmentCount, 2);
  assert.equal(rows[0].outcome, 'completed');
  assert.deepEqual(rows[0].send, { attempted: true, ok: true });
  assert.equal(rows[0].attention.predictedAction, 'speak', 'P0.7 shadow 决策必须透传进 trace');

  // 没有投递元数据也没有草稿的回合（例如普通模式转发）不落盘
  rec.onTurnStart('sess-2', 'turn-99');
  rec.onTurnEnd('sess-2', { reasonKind: 'completed' });
  assert.equal(writer.read(new Date()).length, 1, '非仿真回合不得混入 trace');

  // writer 抛错也不能往外抛（异常自兜底，不崩宿主）
  const broken = createTurnRecorder({
    writer: { write() { throw new Error('disk full'); } },
    log: () => {}
  });
  broken.queueDelivery('sess-3', { key: 'group:1', wakeReason: 'message', promptText: '【唤醒】k' });
  broken.onTurnStart('sess-3');
  assert.doesNotThrow(() => broken.onTurnEnd('sess-3', {}));
});

test('turnRecorder：丢了 turn/start 的回合也落盘并标注', () => {
  const dir = tmpDir();
  const writer = createTraceWriter({ dir });
  const rec = createTurnRecorder({ writer });
  rec.queueDelivery('sess-1', { key: 'group:1', wakeReason: 'timeout', promptText: '【唤醒】k' });
  rec.onTurnEnd('sess-1', { reasonKind: 'completed' });
  const rows = writer.read(new Date());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'no-turn-start');
  assert.equal(rows[0].wakeReason, 'timeout');
});

test('simulation-replay：离线回放可跑、输出确定、trace 无明文标识符', () => {
  const out = tmpDir();
  const run = spawnSync(process.execPath, [REPLAY, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, `回放失败：${run.stderr}`);
  assert.ok(/回放完成：4 回合/.test(run.stdout));
  const files = fs.readdirSync(out).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const body = fs.readFileSync(path.join(out, files[0]), 'utf8');
  const rows = body.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.turnId), ['t_fix_001', 't_fix_002', 't_fix_003', 't_fix_004']);
  assert.ok(rows.every((r) => /^h_|^(private|group):h_/.test(r.key ?? 'h_none')), 'key 必须已脱敏');
  assert.ok(!body.includes('123456') && !body.includes('654321'), 'trace 不得含 fixture 明文标识符');
  assert.ok(!body.includes('来了来了'), 'trace 不得含消息正文');

  const check = spawnSync(process.execPath, [REPLAY, '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, `确定性校验失败：${check.stderr}`);
  assert.ok(/确定性校验通过/.test(check.stdout));
});

test('simulation-replay：脚本不得触网 / 不得引用桥接或 DSH', () => {
  for (const needle of ['127.0.0.1', 'sessions.prompt', "from 'ws'", "require('ws')", 'bridge.js']) {
    assert.ok(!REPLAY_SOURCE.includes(needle), `回放脚本不得包含 ${needle}`);
  }
});

test('newTurnId：格式稳定', () => {
  assert.match(newTurnId(), /^t_[0-9a-z]+_[0-9a-f]{6}$/);
});
