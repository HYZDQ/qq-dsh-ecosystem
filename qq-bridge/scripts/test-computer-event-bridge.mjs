// 电脑操控事件桥单测（dsh-douyin-agent §6.3 接线）：stateDir 解析、落文件、节流、静默失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropQqMessageEvent, resolveComputerEventsDir, publishQqSessionMap } from '../src/computer-event-bridge.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('resolveComputerEventsDir：DOUYIN_STATE_DIR 优先，computer 目录在用才认', () => {
  const stateDir = tmp('ceb-');
  fs.mkdirSync(path.join(stateDir, 'computer'), { recursive: true });
  assert.equal(
    resolveComputerEventsDir({ DOUYIN_STATE_DIR: stateDir }),
    path.join(stateDir, 'computer', 'events'),
  );
});

test('dropQqMessageEvent：落 qq-message-<ts>.json（仅元数据），节流内不重复，失败静默', () => {
  const stateDir = tmp('ceb-drop-');
  fs.mkdirSync(path.join(stateDir, 'computer'), { recursive: true });
  const env = { DOUYIN_STATE_DIR: stateDir };
  let clock = 2_000_000;
  const now = () => clock;

  assert.equal(dropQqMessageEvent({ kind: 'private', from: '123', owner: true }, { env, now }), true);
  const dir = path.join(stateDir, 'computer', 'events');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^qq-message-2000000\.json$/);
  const payload = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.deepEqual({ kind: payload.kind, from: payload.from }, { kind: 'private', from: '123' });
  assert.equal(payload.text, undefined, '绝不携带消息正文（隐私最小化）');

  // 节流：15s 内不重复落
  clock += 5_000;
  assert.equal(dropQqMessageEvent({ kind: 'group', from: '456' }, { env, now }), false);
  assert.equal(fs.readdirSync(dir).length, 1);
  clock += 11_000;
  assert.equal(dropQqMessageEvent({ kind: 'group', from: '456', group: '789' }, { env, now }), true);
  assert.equal(fs.readdirSync(dir).length, 2);

  // 失败静默：无收件箱环境返回 false 不抛
  assert.equal(dropQqMessageEvent({ kind: 'private', from: '1' }, { env: {}, now }), false);
});

test('publishQqSessionMap：会话映射按 kind:id 解析并落 computer/qq-sessions.json', () => {
  const stateDir = tmp('ceb-map-');
  fs.mkdirSync(path.join(stateDir, 'computer'), { recursive: true });
  const env = { DOUYIN_STATE_DIR: stateDir };
  // 真实 bridge 的 state.sessions 值是**字符串**会话 ID（2026-10-27 现网踩坑：夹具用
  // {sessionId} 对象形状测绿了，线上字符串值全被跳过，发出去一张空映射表）。两种形状都要认。
  const ok = publishQqSessionMap({
    'private:123456789': 'sess-owner',        // 真实形状：字符串值
    'group:12345': { sessionId: 'sess-group' }, // 兼容形状：对象值
    'private:broken': {},            // 无 sessionId 忽略
    'weird-key': { sessionId: 'sess-x' }, // 非 kind:id 忽略
  }, { env, now: () => 42 });
  assert.equal(ok, true);
  const file = path.join(stateDir, 'computer', 'qq-sessions.json');
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(map.sessions['sess-owner'], { kind: 'private', userId: '123456789' });
  assert.deepEqual(map.sessions['sess-group'], { kind: 'group', userId: '12345' });
  assert.equal(map.sessions['sess-x'], undefined);
  assert.equal(map.at, 42);
});
