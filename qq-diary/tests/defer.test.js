// 活跃期延后（§17.5 第 4 条）：默认关、活跃检测、安静/上限退出、pendingDate 状态。
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { clearDeferState, deferIfOwnerActive, loadDeferState, ownerLastActiveAt, saveDeferState } from '../src/defer.js';
import { cleanupTempRoots, mkTempRoot } from './helpers.js';

after(cleanupTempRoots);

function makeConfig({ activeAt = 0, deferMinutes = 20, maxDefer = 60 } = {}) {
  const root = mkTempRoot();
  const bridgeState = path.join(root, 'bridge', 'state');
  fs.mkdirSync(bridgeState, { recursive: true });
  if (activeAt) {
    fs.writeFileSync(path.join(bridgeState, 'social-v2.json'), JSON.stringify({
      conversations: { 'private:10001': { recentMessages: [{ sender: '主人', text: '在吗', time: activeAt }] } }
    }), 'utf8');
  }
  return {
    config: {
      qqBridgeDir: path.join(root, 'bridge'),
      stateDir: path.join(root, 'state'),
      surface: { deferIfActiveMinutes: deferMinutes, maxDeferMinutes: maxDefer }
    },
    root
  };
}

describe('defer：活跃期延后', () => {
  test('默认关（deferIfActiveMinutes=0）→ 零延后', async () => {
    const { config } = makeConfig({ activeAt: Date.now(), deferMinutes: 0 });
    const r = await deferIfOwnerActive({ config, ownerQQ: 10001 });
    assert.equal(r.deferredMs, 0);
    assert.equal(r.reason, 'off');
  });

  test('主人不活跃（超过窗口）→ 不延后；活跃但窗口判定即刻返回', async () => {
    const now = Date.parse('2026-10-26T14:00:00+08:00');
    // 最近说话在 1 小时前，窗口 20 分钟 → 不延后
    const old = makeConfig({ activeAt: now - 3600_000 });
    const r1 = await deferIfOwnerActive({ config: old.config, ownerQQ: 10001, now: () => now });
    assert.equal(r1.deferredMs, 0);
    assert.equal(r1.reason, 'not-active');
    assert.equal(ownerLastActiveAt(old.config, 10001), now - 3600_000);
  });

  test('活跃 → 延后到安静（timers 注入模拟时间流逝）', async () => {
    let nowMs = Date.parse('2026-10-26T14:00:00+08:00');
    const { config, root } = makeConfig({ activeAt: nowMs - 60_000 }); // 1 分钟前说话，窗口 20 分钟
    // 假 timers：sleep 立即把时钟推进 5 分钟，并在第 2 次检查时把消息变旧
    let ticks = 0;
    const timers = {
      setTimeout: (fn) => {
        ticks += 1;
        nowMs += 5 * 60_000;
        if (ticks === 2) {
          // 主人安静了：把消息时间改成很久以前
          const bridgeState = path.join(root, 'bridge', 'state', 'social-v2.json');
          fs.writeFileSync(bridgeState, JSON.stringify({
            conversations: { 'private:10001': { recentMessages: [{ sender: '主人', text: '晚安', time: nowMs - 3600_000 }] } }
          }), 'utf8');
        }
        fn();
        return 0;
      }
    };
    const r = await deferIfOwnerActive({ config, ownerQQ: 10001, now: () => nowMs, timers, checkIntervalMs: 1 });
    assert.equal(r.reason, 'quiet');
    assert.ok(r.deferredMs > 0, '确实延后了');
    assert.ok(r.deferredMs <= 60 * 60_000, '没超过上限');
  });

  test('pendingDate 状态：写入/读取/清除', () => {
    const { config } = makeConfig();
    assert.equal(loadDeferState(config), null);
    assert.equal(saveDeferState(config, { pendingDate: '2026-10-25', at: 'x' }), true);
    assert.equal(loadDeferState(config).pendingDate, '2026-10-25');
    clearDeferState(config);
    assert.equal(loadDeferState(config), null);
  });
});
