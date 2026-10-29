// GEN3 P0.6 回归：memberImpressions 姓名→userId 迁移（收编/只读保留/幂等/回滚）+ bridge 契约。
// 全部用合成 fixture（临时目录），不碰真实 state。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIGRATE = path.join(HERE, 'migrate-socialv2-userid.mjs');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

function makeFixture(dir) {
  const obj = {
    paused: false,
    conversations: {
      'group:123456789': {
        recentMessages: [
          { seq: 1, sender: '张三', userId: '123456789', text: 'hi', isSelf: false, time: 1 },
          { seq: 2, sender: '张三', userId: '123456789', text: 'yo', isSelf: false, time: 2 }
        ],
        unread: [],
        memberImpressions: {
          '张三': { traits: ['爱接梗'], interactionCount: 3, lastSeenAt: 100 },
          '神秘人': { traits: ['话少'], interactionCount: 1, lastSeenAt: 50 },
          'u:123456789': { traits: ['老熟人'], interactionCount: 2, lastSeenAt: 80, aliases: ['张三'] }
        }
      },
      'private:111111111': {
        recentMessages: [{ sender: '主人', userId: '111111111', text: 'hi', isSelf: false, time: 1 }],
        unread: [],
        memberImpressions: {
          '主人': { traits: ['靠谱'], interactionCount: 9, lastSeenAt: 200 }
        }
      }
    }
  };
  const file = path.join(dir, 'social-v2.json');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  return file;
}

function run(args) {
  return spawnSync(process.execPath, [MIGRATE, ...args], { encoding: 'utf8' });
}

test('迁移：姓名键收编到 u:<userId>（合并次数/别名），解析不到的保留，schemaVersion=2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-migrate-'));
  const file = makeFixture(dir);
  const r = run(['--state', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/收编 2 条/.test(r.stdout), r.stdout);
  assert.ok(/保留 1 条/.test(r.stdout));
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.schemaVersion, 2);
  const g = after.conversations['group:123456789'].memberImpressions;
  // 张三 + 已有 u: 条目合并：次数 3+2=5，traits 并集，别名含张三
  const merged = g['u:123456789'];
  assert.ok(merged, '张三应并入 u:123456789');
  assert.equal(merged.interactionCount, 5);
  assert.deepEqual(merged.traits.sort(), ['爱接梗', '老熟人'].sort());
  assert.ok(merged.aliases.includes('张三'));
  assert.ok(!('张三' in g), '姓名键已收编');
  assert.ok(g['神秘人'], '解析不到 userId 的姓名键只读保留');
  const p = after.conversations['private:111111111'].memberImpressions;
  assert.deepEqual(p['u:111111111'].traits, ['靠谱']);
  assert.equal(p['u:111111111'].interactionCount, 9);
  assert.ok(p['u:111111111'].aliases.includes('主人'));
});

test('迁移幂等：第二次执行零改动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-migrate-'));
  const file = makeFixture(dir);
  assert.equal(run(['--state', file]).status, 0);
  const first = fs.readFileSync(file, 'utf8');
  const r2 = run(['--state', file]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(/无需迁移（幂等）/.test(r2.stdout), r2.stdout);
  assert.equal(fs.readFileSync(file, 'utf8'), first, '幂等执行不得改动文件');
});

test('回滚：--rollback 还原迁移前原状（字节级）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-migrate-'));
  const file = makeFixture(dir);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(run(['--state', file]).status, 0);
  assert.notEqual(fs.readFileSync(file, 'utf8'), before, '迁移应有改动');
  const r = run(['--state', file, '--rollback']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/已还原备份/.test(r.stdout));
  assert.equal(fs.readFileSync(file, 'utf8'), before, '回滚必须字节级还原');
});

test('bridge 契约：userId 键约定、别名解析、schemaVersion 落盘在位', () => {
  assert.ok(BRIDGE_SRC.includes('resolveUserIdByNameV2'), '写入路径必须解析 userId');
  assert.ok(BRIDGE_SRC.includes('findImpressionKeyV2'), '编辑/删除必须按名字/别名解析');
  assert.ok(BRIDGE_SRC.includes('impressionDisplayNameV2'), '读取必须按别名展示');
  assert.ok(BRIDGE_SRC.includes('schemaVersion: 2'), 'saveSocialV2State 必须打 schemaVersion');
  assert.ok(BRIDGE_SRC.includes("startsWith('u:')"), 'u: 键约定在位');
});
