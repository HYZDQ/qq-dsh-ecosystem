// 音色库登记表（src/tts-voices.js）的离线单测。
// 重点：名字校验 fail-closed、清单被改坏也不能穿越出 refs 目录、删除只删 refs 内的文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createVoiceStore, normalizeVoiceName, MAX_VOICES } from '../src/tts-voices.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-voices-'));
const refs = path.join(tmp, 'refs');
fs.mkdirSync(refs, { recursive: true });
// 每个用例一份独立登记表，避免互相看见对方写进去的音色。
let seq = 0;
const store = () => createVoiceStore({ file: path.join(tmp, `voices-${++seq}.json`), refsDir: refs });

test('音色名只接受 1~20 个中文/字母/数字/-_', () => {
  assert.equal(normalizeVoiceName('小暖'), '小暖');
  assert.equal(normalizeVoiceName('voice_01'), 'voice_01');
  assert.equal(normalizeVoiceName('  小暖  '), '小暖');
  assert.equal(normalizeVoiceName(''), null);
  assert.equal(normalizeVoiceName('a'.repeat(21)), null);
  assert.equal(normalizeVoiceName('../etc/passwd'), null);
  assert.equal(normalizeVoiceName('a b'), null, '空格不允许（免得文件名出现空格）');
  assert.equal(normalizeVoiceName(null), null);
});

test('新增 → 列表 → 取值', () => {
  const s = store();
  s.add({ name: '小暖', file: '小暖.wav', refText: '今天天气不错', durationSec: 3.2, bytes: 1024 });
  const list = s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '小暖');
  assert.equal(list[0].refAudio, path.join(refs, '小暖.wav'));
  // 文件还没落地 → exists=false（控制台据此提示「音频丢失」）
  assert.equal(list[0].exists, false);
  fs.writeFileSync(path.join(refs, '小暖.wav'), 'RIFF');
  assert.equal(s.get('小暖').exists, true);
});

test('同名再存是覆盖，不会重复登记', () => {
  const s = store();
  s.add({ name: '小暖', file: '小暖.wav', refText: '第一版' });
  s.add({ name: '小暖', file: '小暖.wav', refText: '第二版' });
  assert.equal(s.list().length, 1);
  assert.equal(s.get('小暖').refText, '第二版');
});

test('非法名字拦住、不写表', () => {
  const s = store();
  assert.throws(() => s.add({ name: 'a b', file: 'x.wav', refText: 'x' }), /不合法/);
  assert.equal(s.list().length, 0);
});

test('清单被改坏（file 写成 ../）也只能落在 refs 目录内', () => {
  const file = path.join(tmp, 'broken.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, voices: [{ name: '坏', file: '../../evil.wav', refText: 'x' }] }));
  const s = createVoiceStore({ file, refsDir: refs });
  const got = s.get('坏');
  assert.equal(got.refAudio, path.join(refs, 'evil.wav'));
  assert.ok(path.resolve(got.refAudio).startsWith(path.resolve(refs)));
});

test('删除只删 refs 内的文件，并清理登记表', () => {
  const s = store();
  fs.writeFileSync(path.join(refs, '可删.wav'), 'RIFF');
  s.add({ name: '可删', file: '可删.wav', refText: 'x' });
  const gone = s.remove('可删');
  assert.equal(gone.name, '可删');
  assert.equal(fs.existsSync(path.join(refs, '可删.wav')), false);
  assert.equal(s.list().length, 0);
  assert.equal(s.remove('不存在'), null);
});

test('最多 20 个音色', () => {
  const s = store();
  for (let i = 0; i < MAX_VOICES; i++) s.add({ name: `v${i}`, file: `v${i}.wav`, refText: 'x' });
  assert.throws(() => s.add({ name: 'v99', file: 'v99.wav', refText: 'x' }), /最多/);
});

test('损坏的登记表读成空列表（不抛）', () => {
  const file = path.join(tmp, 'corrupt.json');
  fs.writeFileSync(file, '{not json');
  const s = createVoiceStore({ file, refsDir: refs });
  assert.deepEqual(s.list(), []);
  assert.equal(s.get('任何'), null);
});

console.log('🎉 tts-voices 单测全部通过');
