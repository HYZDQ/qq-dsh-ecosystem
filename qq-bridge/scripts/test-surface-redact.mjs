// GEN3 表现面 S0 单测：统一脱敏规则（§5.4，含编码绕过）与 SurfaceEvent 白名单/落盘（§5.2）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hashForTrace, redactQuery, redactSurfaceText } from '../src/surface/redact.js';
import {
  SURFACE_EVENT_FIELDS,
  buildSurfaceEvent,
  contentHash,
  createSurfaceEventWriter,
  emitSurfaceEvent
} from '../src/surface/events.js';

test('redactQuery：QQ 号/手机号/邮箱/凭据/密钥/路径/CQ 码全部替换', () => {
  const cases = [
    ['加我123456789好友', '[QQ号]'],
    ['打给13800138000', '[手机号]'],
    ['发到a.b@gmail.com', '[邮箱]'],
    ['token=abcdef123456', 'token=[已脱敏]'],
    ['sk-abcdefghijklmnop', 'sk-[已脱敏]'],
    ['看C:\\Users\\test\\secret.txt', '[路径已脱敏]'],
    ['[CQ:image,file=a.jpg]你好', '[CQ已隐藏]你好'],
    ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '[哈希已脱敏]']
  ];
  for (const [input, expect] of cases) {
    const out = redactQuery(input);
    assert.ok(out.includes(expect), `${input} => ${out}，应含 ${expect}`);
  }
});

test('redactQuery：日期/金额/年份等数量上下文不误伤', () => {
  assert.equal(redactQuery('2026-10-26 的天气'), '2026-10-26 的天气');
  assert.equal(redactQuery('一共12345元'), '一共12345元');
  assert.equal(redactQuery('现在是12345点也不对但这是12点'), '现在是[QQ号]点也不对但这是12点', '5 位以上孤立数字按 QQ 号处理');
});

test('redactQuery：编码绕过（base64、\\uXXXX）解码后命中敏感信息整段替换', () => {
  const b64 = Buffer.from('13800138000').toString('base64');
  assert.ok(redactQuery(`x ${b64}`).includes('[已脱敏]'), 'base64 手机号');
  const uni = Array.from('13800138000').map((c) => `\\u00${c.charCodeAt(0).toString(16)}`).join('');
  assert.ok(redactQuery(`y ${uni}`).includes('[已脱敏]'), 'unicode 转义手机号');
  assert.equal(redactQuery(`z ${b64}`.replace(b64, Buffer.from('hello world!!').toString('base64'))).includes('[已脱敏]'), false, '无敏感内容不替换');
});

test('redactQuery：零宽/双向控制符先剥离，普通文本不被吞', () => {
  const hidden = `隐${String.fromCharCode(0x200b)}藏${String.fromCharCode(0x202e)}的13800138000`;
  const out = redactQuery(hidden);
  assert.ok(!out.includes(String.fromCharCode(0x200b)), '零宽被剥');
  assert.ok(!out.includes(String.fromCharCode(0x202e)), '双向控制被剥');
  assert.ok(out.includes('[手机号]'));
  // 普通 ASCII/中文绝不误吞（回归：字符类范围写错会吞掉全部 ASCII）
  assert.equal(redactQuery('ASCII abc 123 中文测试 ]['), 'ASCII abc 123 中文测试 ][');
});

test('redactSurfaceText：CQ/控制字符/URL 参数脱敏 + maxChars 截断', () => {
  const out = redactSurfaceText('A\x01B https://x.com/p?id=1#f C', { maxChars: 0 });
  assert.ok(out.includes('https://x.com/p?[参数已脱敏]'));
  assert.ok(!out.includes('\x01'));
  const long = redactSurfaceText('一二三四五', { maxChars: 3 });
  assert.equal(long, '一二三…');
  assert.equal(redactSurfaceText('任意', { maxChars: 0 }), '任意', 'maxChars=0 不截断');
});

test('hashForTrace/contentHash：稳定 16 位十六进制', () => {
  const h = hashForTrace('abc');
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, hashForTrace('abc'), '同输入同哈希');
  assert.notEqual(h, hashForTrace('abd'));
  assert.match(contentHash('正文'), /^[0-9a-f]{16}$/);
});

test('buildSurfaceEvent：白名单外字段丢弃并留痕，key 自动脱敏', () => {
  const e = buildSurfaceEvent({
    surface: 'qzone',
    op: 'publish',
    key: 'private:123456789',
    ok: true,
    durationMs: 123,
    attempt: 1,
    trust: 'observed',
    budget: { kind: 'draft', used: 2, limit: 3 },
    hashes: { tid: 'abc123' },
    errorCode: null,
    meta: { readback: true, provider: 'deepseek', note: '这是自由文本必须丢' },
    tokensIn: 100,
    tokensOut: 20,
    modelCalls: 1,
    rawText: '不该出现的正文'
  });
  assert.match(e.keyHash, /^private:h_[0-9a-f]{8}$/, 'key 保留类型前缀 + 主体哈希');
  assert.ok(!e.keyHash.includes('123456789'));
  assert.equal(e.meta.readback, true);
  assert.equal(e.meta.provider, 'deepseek');
  assert.ok(!('note' in e.meta), '自由文本 meta 被丢');
  assert.deepEqual(e.droppedFields, ['rawText']);
  assert.equal(e.ok, true);
  assert.deepEqual(e.budget, { kind: 'draft', used: 2, limit: 3 });
  for (const k of Object.keys(e)) {
    if (k === 'droppedFields') continue;
    assert.ok(SURFACE_EVENT_FIELDS.includes(k), `未声明字段：${k}`);
  }
});

test('buildSurfaceEvent：非法 trust/op 收敛为 null，不抛错', () => {
  const e = buildSurfaceEvent({ surface: 'has space', op: 'bad op with spaces', trust: 'trust-me' });
  assert.equal(e.trust, null);
  assert.equal(e.op, null);
  assert.equal(e.surface, null, '含空格的 surface 不是枚举');
});

test('createSurfaceEventWriter：按日分文件追加 JSONL，读回一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-trace-'));
  const day = new Date(Date.UTC(2026, 9, 26, 4, 0)); // 2026-10-26 本地
  const writer = createSurfaceEventWriter({ dir, now: () => day });
  const file = writer.write(buildSurfaceEvent({ surface: 'web', op: 'search', ok: true }));
  assert.equal(path.basename(file), 'surface-trace-2026-10-26.jsonl', '按日分文件');
  writer.write(buildSurfaceEvent({ surface: 'qzone', op: 'draft', ok: false }));
  const rows = writer.read(day);
  assert.equal(rows.length, 2, '追加写');
  assert.equal(rows[0].surface, 'web');
  assert.equal(rows[1].ok, false);
  assert.deepEqual(writer.read(new Date(Date.UTC(2026, 9, 20))), [], '无文件返回空数组');
});

test('emitSurfaceEvent：写入异常自兜底，返回 null 不上抛', () => {
  const logs = [];
  const badWriter = { write: () => { throw new Error('disk full'); } };
  const result = emitSurfaceEvent(badWriter, { surface: 'web' }, (m) => logs.push(m));
  assert.equal(result, null);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('disk full'));
});
