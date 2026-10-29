// GEN3 表现面 S0 单测：健康视图（§17.2.2 不返回正文、hash 只留 16 位）与
// 成本聚合（§17.2.3 软预算只告警、按面聚合、不参与限额）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildSurfaceStatus } from '../src/surface/health.js';
import { createSurfaceCostAggregator } from '../src/surface/cost.js';

const CFG = {
  socialV3: {
    enabled: true,
    mode: 'shadow',
    modules: { surface: true },
    surface: {
      webSearch: { enabled: true, draftMaterialPerDay: 2 },
      qzone: { enabled: true, contextSource: 'v3', proactiveApproval: false, proactiveMinPerDay: 1, proactiveMaxPerDay: 3 },
      diary: { enabled: false, contextSource: 'v2' }
    }
  }
};

test('buildSurfaceStatus：形状完整、模块开关如实、proactive 反映 v1.4 决策（默认不审批）', () => {
  const s = buildSurfaceStatus({ cfg: CFG });
  assert.equal(s.ok, true);
  assert.equal(s.moduleOn, true);
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.surfaces.web.enabled, true);
  assert.equal(s.surfaces.web.draftMaterialPerDay, 2);
  assert.equal(s.surfaces.qzone.enabled, true);
  assert.equal(s.surfaces.qzone.contextSource, 'v3');
  assert.equal(s.surfaces.qzone.proactive.approval, false, '主人已定：想发就发不强制确认');
  assert.equal(s.surfaces.qzone.proactive.minPerDay, 1);
  assert.equal(s.surfaces.qzone.proactive.maxPerDay, 3);
  assert.equal(s.surfaces.qzone.defaultVisibility, null, '无运行态时不猜可见性');
  assert.equal(s.surfaces.diary.enabled, false);
  assert.equal(s.surfaces.diary.writeAt, '22:00', 'v1.4 写入时间');
});

test('buildSurfaceStatus：缺数据填 null，不抛错', () => {
  const s = buildSurfaceStatus({ cfg: {} });
  assert.equal(s.moduleOn, false);
  assert.equal(s.surfaces.web.budget, null);
  assert.equal(s.surfaces.web.last, null);
  assert.equal(s.surfaces.qzone.lastPublish, null);
  assert.equal(s.surfaces.qzone.unknownCount, 0);
  assert.equal(s.surfaces.diary.lastRun, null);
  assert.equal(s.cost, null);
});

test('buildSurfaceStatus：哈希只留前 16 位，正文类字段绝不出现（§17.2.2）', () => {
  const s = buildSurfaceStatus({
    cfg: CFG,
    runtime: {
      qzone: {
        defaultVisibility: '所有人可见',
        lastPublish: { state: 'unknown', tidHash: 'a'.repeat(32), startedAt: '2026-10-26T10:00:00Z', verifiedAt: null, content: '绝不该出现的说说正文' },
        quota: { usedToday: 1, limit: 6 },
        unknownCount: 1
      },
      diary: { lastRun: { at: 'x', ok: true, date: '2026-10-25' }, memoryQueue: 2, text: '绝不该出现的日记正文' }
    },
    lastEvents: { web: { at: '2026-10-26T09:00:00Z', ok: true, provider: 'deepseek', cached: true, degraded: false, query: '绝不该出现的搜索词' } }
  });
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes('说说正文') && !blob.includes('日记正文') && !blob.includes('搜索词'), '不返回正文/搜索词');
  assert.equal(s.surfaces.qzone.lastPublish.tidHash, 'a'.repeat(16), 'hash 截到 16 位');
  assert.equal(s.surfaces.qzone.defaultVisibility, '所有人可见');
  assert.equal(s.surfaces.qzone.unknownCount, 1);
  assert.equal(s.surfaces.diary.memoryQueue, 2);
  assert.equal(s.surfaces.web.last.provider, 'deepseek');
  assert.equal(s.surfaces.web.last.cached, true);
});

test('buildSurfaceStatus：非法 hash 输入收敛为 null', () => {
  const s = buildSurfaceStatus({
    cfg: CFG,
    runtime: { qzone: { lastPublish: { state: 'published', tidHash: '不是哈希!@#' } } }
  });
  assert.equal(s.surfaces.qzone.lastPublish.tidHash, null);
});

test('cost 聚合：按面累加 tokens/ops，snapshot 给总计与软预算状态', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-cost-'));
  const agg = createSurfaceCostAggregator({ dir, dailyTokenBudget: 100 });
  agg.add({ surface: 'qzone', tokensIn: 300, tokensOut: 50, modelCalls: 1 });
  agg.add({ surface: 'qzone', tokensIn: 100, tokensOut: 10, modelCalls: 1 });
  agg.add({ surface: 'diary', tokensIn: 20, tokensOut: 5 });
  const snap = agg.snapshot();
  assert.equal(snap.surfaces.qzone.tokensIn, 400);
  assert.equal(snap.surfaces.qzone.modelCalls, 2);
  assert.equal(snap.surfaces.qzone.ops, 2);
  assert.equal(snap.surfaces.diary.ops, 1);
  assert.equal(snap.total.tokensIn, 420);
  assert.equal(snap.total.ops, 3);
  assert.equal(snap.overBudget, true, '超软预算只标记不阻断');
});

test('cost 聚合：落盘重启后延续，损坏文件重建不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-cost-'));
  const day = new Date(Date.UTC(2026, 9, 26, 4, 0));
  const agg = createSurfaceCostAggregator({ dir, now: () => day });
  agg.add({ surface: 'web', tokensIn: 10, tokensOut: 2 });
  const again = createSurfaceCostAggregator({ dir, now: () => day });
  assert.equal(again.snapshot().surfaces.web.tokensIn, 10, '重启后延续');
  // 写坏当日文件后重建
  const file = path.join(dir, `surface-cost-${again.snapshot().day}.json`);
  fs.writeFileSync(file, '{broken', 'utf8');
  const recovered = createSurfaceCostAggregator({ dir, now: () => day });
  assert.equal(recovered.snapshot().surfaces.web, undefined, '损坏即重建为空');
  recovered.add({ surface: 'web', tokensIn: 1 });
  assert.equal(recovered.snapshot().total.tokensIn, 1);
});

test('cost 聚合：缺字段/非法值按 0，不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-cost-'));
  const agg = createSurfaceCostAggregator({ dir });
  const snap = agg.add({ surface: 'x', tokensIn: 'abc', tokensOut: -5 });
  assert.equal(snap.surfaces.x.tokensIn, 0);
  assert.equal(snap.surfaces.x.tokensOut, 0);
  assert.equal(snap.overBudget, false, '预算 0 不判超限');
});
