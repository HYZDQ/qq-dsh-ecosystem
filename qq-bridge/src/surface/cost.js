// 表现面成本聚合（GEN3 表现面 S0，设计 §17.2.3）：按表现面汇总 token 用量到
// state/simulation/surface-cost-YYYY-MM-DD.json。
//
// 硬边界：**只做展示与软预算告警，不参与限额计算**。真正的硬限额仍由 tokenLedger 负责，
// 对账时以 tokenLedger 为准——qzone writer 在桥接侧已记 `internal:空间写作`，这里绝不重复计费，
// 只是把「这次模型调用属于哪个表现面」的维度补上（类似 Helicone 的 property 聚合）。
import fs from 'node:fs';
import path from 'node:path';

function pad(n) {
  return String(n).padStart(2, '0');
}

function ymd(date) {
  const d = date instanceof Date ? date : new Date(date ?? Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptySurfaceCost() {
  return { tokensIn: 0, tokensOut: 0, modelCalls: 0, ops: 0 };
}

function emptyFile(dailyTokenBudget) {
  return { day: ymd(), dailyTokenBudget: dailyTokenBudget ?? 0, surfaces: {} };
}

function loadFile(file, dailyTokenBudget, log) {
  try {
    if (!fs.existsSync(file)) return emptyFile(dailyTokenBudget);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.day !== 'string' || !raw.surfaces) {
      return emptyFile(dailyTokenBudget);
    }
    return raw;
  } catch (error) {
    log(`surface cost 快照损坏，重建：${error?.message ?? error}`);
    return emptyFile(dailyTokenBudget);
  }
}

/**
 * 创建表现面成本聚合器。
 * @param {object} opts
 * @param {string} opts.dir            落盘目录（state/simulation）
 * @param {number} [opts.dailyTokenBudget] 软预算（超限只 overBudget:true，不阻断）
 * @param {() => number} [opts.now]
 * @param {(msg:string)=>void} [opts.log]
 */
export function createSurfaceCostAggregator({ dir, dailyTokenBudget = 0, now = () => Date.now(), log = () => {} } = {}) {
  if (!dir) throw new Error('createSurfaceCostAggregator 需要 dir');
  let day = ymd(now());
  let data = loadFile(path.join(dir, `surface-cost-${day}.json`), dailyTokenBudget, log);

  function fileFor() {
    return path.join(dir, `surface-cost-${day}.json`);
  }

  function rollover() {
    const d = ymd(now());
    if (d !== day) {
      day = d;
      data = loadFile(fileFor(), dailyTokenBudget, log);
    }
  }

  function persist() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fileFor(), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    } catch (error) {
      // 只告警：成本统计是观测，绝不因写盘失败影响调用链
      log(`surface cost 落盘失败：${error?.message ?? error}`);
    }
  }

  return {
    /**
     * 累加一次表现面调用成本。计数用正整数，缺失/非法按 0。
     * 返回当前面的累计值与软预算状态（只告警不阻断）。
     */
    add({ surface, tokensIn = 0, tokensOut = 0, modelCalls = 0, ops = 1 } = {}) {
      rollover();
      const key = typeof surface === 'string' && surface ? surface : 'unknown';
      if (!data.surfaces[key]) data.surfaces[key] = emptySurfaceCost();
      const bucket = data.surfaces[key];
      const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
      bucket.tokensIn += num(tokensIn);
      bucket.tokensOut += num(tokensOut);
      bucket.modelCalls += num(modelCalls);
      bucket.ops += num(ops);
      persist();
      return { ...this.snapshot() };
    },

    /** 当日聚合：总计 + 各面明细 + 软预算状态。不含任何正文。 */
    snapshot() {
      rollover();
      const total = emptySurfaceCost();
      for (const s of Object.values(data.surfaces)) {
        total.tokensIn += s.tokensIn;
        total.tokensOut += s.tokensOut;
        total.modelCalls += s.modelCalls;
        total.ops += s.ops;
      }
      return {
        day,
        dailyTokenBudget,
        total,
        surfaces: JSON.parse(JSON.stringify(data.surfaces)),
        overBudget: dailyTokenBudget > 0 && (total.tokensIn + total.tokensOut) > dailyTokenBudget
      };
    }
  };
}
