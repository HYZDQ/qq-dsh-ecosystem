// GEN3 表现面 S0 单测：SurfaceBudget 日切/小时切、超限稳定拒绝、快照落盘与损坏降级（§5.3）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSurfaceBudget, dayKeyOf, hourKeyOf } from '../src/surface/budget.js';

// Asia/Shanghai = UTC+8：UTC 16:00 前一天 = 上海次日 00:00
const T_SH_MIDNIGHT = Date.UTC(2026, 9, 25, 16, 0); // 2026-10-26 00:00 +08
const T_SH_HOUR1 = Date.UTC(2026, 9, 25, 17, 30); // 2026-10-26 01:30 +08
const T_SH_NEXT_DAY = Date.UTC(2026, 9, 26, 17, 0); // 2026-10-27 01:00 +08

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'surface-budget-')), name);
}

test('dayKeyOf/hourKeyOf：按上海自然日与自然小时', () => {
  assert.equal(dayKeyOf(T_SH_MIDNIGHT), '2026-10-26');
  assert.equal(hourKeyOf(T_SH_MIDNIGHT), '2026-10-26T00');
  assert.equal(hourKeyOf(T_SH_HOUR1), '2026-10-26T01');
  assert.equal(dayKeyOf(Date.UTC(2026, 9, 25, 15, 59)), '2026-10-25', '15:59 UTC 还是上海 25 日');
});

test('charge：正常累计，小时与日限额超限返回稳定拒绝', () => {
  let now = T_SH_MIDNIGHT;
  const b = createSurfaceBudget({
    limits: { search: { hour: 2, day: 3 } },
    now: () => now
  });
  assert.equal(b.charge('search').ok, true);
  assert.equal(b.charge('search').ok, true);
  const over = b.charge('search'); // 小时第 3 次超限
  assert.equal(over.ok, false);
  assert.equal(over.code, 'SURFACE_BUDGET_EXCEEDED');
  assert.equal(over.resetAt, new Date(Date.UTC(2026, 9, 25, 17, 0)).toISOString(), '整点重置');
  // 小时切后小时计数清零，日计数继续累计
  now = T_SH_HOUR1;
  const afterHour = b.charge('search');
  assert.equal(afterHour.ok, true, '小时切后可再用');
  assert.equal(afterHour.usedHour, 1);
  assert.equal(afterHour.usedDay, 3, '日计数不清');
  const overDay = b.charge('search'); // 日第 4 次超日限
  assert.equal(overDay.ok, false);
  assert.equal(overDay.limit, 3);
  assert.equal(overDay.resetAt, new Date(Date.UTC(2026, 9, 26, 16, 0)).toISOString(), '上海次日 0 点重置');
});

test('日切：跨上海自然日计数全清零', () => {
  let now = T_SH_MIDNIGHT;
  const b = createSurfaceBudget({ limits: { draft: { day: 1 } }, now: () => now });
  assert.equal(b.charge('draft').ok, true);
  assert.equal(b.charge('draft').ok, false, '当天第 2 条被日限额拒绝');
  now = T_SH_NEXT_DAY;
  const next = b.charge('draft');
  assert.equal(next.ok, true, '次日恢复');
  assert.equal(next.usedDay, 1);
});

test('peek/snapshot：只读查看，不含正文', () => {
  const file = tmpFile('budget.json');
  const b = createSurfaceBudget({ file, limits: { search: { hour: 5, day: 10 } }, now: () => T_SH_MIDNIGHT });
  b.charge('search', 2);
  const peek = b.peek();
  assert.equal(peek.search.usedDay, 2);
  assert.equal(peek.search.limitHour, 5);
  assert.ok(peek.search.dayResetAt.endsWith('Z'));
  const snap = b.snapshot();
  assert.equal(snap.dayKey, '2026-10-26');
  assert.equal(snap.diskOk, true);
  assert.deepEqual(snap.counts, { search: { day: 2, hour: 2 } });
});

test('快照落盘与重启恢复：新实例读回计数', () => {
  const file = tmpFile('budget.json');
  const b = createSurfaceBudget({ file, limits: { search: { day: 100 } }, now: () => T_SH_MIDNIGHT });
  b.charge('search', 7);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.dayKey, '2026-10-26');
  const b2 = createSurfaceBudget({ file, limits: { search: { day: 100 } }, now: () => T_SH_MIDNIGHT });
  assert.equal(b2.peek().search.usedDay, 7, '重启后计数延续');
});

test('文件损坏：标记 corrupt，内存计数继续生效', () => {
  const file = tmpFile('budget.json');
  fs.writeFileSync(file, '{broken json', 'utf8');
  const b = createSurfaceBudget({ file, limits: { search: { day: 5 } }, now: () => T_SH_MIDNIGHT });
  assert.equal(b.snapshot().corrupt, true);
  assert.equal(b.charge('search').ok, true);
  assert.equal(b.snapshot().diskOk, true, '损坏文件被合法快照覆盖后恢复');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).dayKey, '2026-10-26', '落盘已重建为合法 JSON');
});

test('写盘失败：diskOk=false 但 charge 不抛错', () => {
  const blocker = tmpFile('blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const b = createSurfaceBudget({
    file: path.join(blocker, 'sub', 'budget.json'), // 路径穿过普通文件，mkdir/write 必失败
    limits: { search: { day: 5 } },
    now: () => T_SH_MIDNIGHT
  });
  const r = b.charge('search');
  assert.equal(r.ok, true, '写盘失败不影响计数');
  assert.equal(b.snapshot().diskOk, false);
});

test('无 file 时纯内存运行', () => {
  const b = createSurfaceBudget({ limits: { diary: { day: 3 } }, now: () => T_SH_MIDNIGHT });
  assert.equal(b.charge('diary').ok, true);
  assert.equal(b.snapshot().diskOk, true);
  assert.deepEqual(b.snapshot().counts, { diary: { day: 1, hour: 1 } });
});
