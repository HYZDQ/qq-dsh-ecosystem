// 三代仿真观测层（GEN3 P0.1）：每轮 trace + prompt 快照 + 脱敏落盘。
// 设计约束见 docs/design/GEN3_SIMULATION_PLAN.md 6.8 节与 P0.1 任务行：
//   1. 只读埋点：任何异常都不得影响聊天主链路 —— createTurnRecorder 内部兜底吞错并记日志；
//   2. 隐私：不落正文/密钥/图片；key、userId 等标识符一律哈希化（h_xxxxxxxx）；
//      buildTurnRecord 走字段白名单，未知字段（可能带正文）一律丢弃并记入 droppedFields；
//   3. 落盘：state/simulation-trace-YYYY-MM-DD.jsonl —— 按日分文件即轮转，单文件不会无限涨；
//   4. 回放可用：record 形状稳定，scripts/simulation-replay.mjs 用同一套构建函数产出可对比轨迹。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 8 位十六进制前缀哈希：足以区分同机数据，又不落明文标识符。 */
export function hashId(value) {
  const raw = String(value ?? '');
  if (!raw) return null;
  return `h_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
}

/**
 * 会话 key 脱敏：保留类型前缀（private/group 便于按类型聚合），主体哈希化。
 * 'private:123456789' → 'private:h_1a2b3c4d'
 */
export function redactKey(key) {
  const raw = String(key ?? '');
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return hashId(raw);
  return `${raw.slice(0, idx)}:${hashId(raw)}`;
}

/**
 * prompt 结构快照：按行首「【段名】」切段，记录段名与各段字符数 + 整体哈希。
 * 用途是防「多一段/少一段」悄悄改变行为（对比段名清单即可发现），
 * **不保存 prompt 正文**（正文含群友消息与记忆，只留长度与哈希）。
 */
export function snapshotPrompt(promptText) {
  const raw = String(promptText ?? '');
  const headerRe = /(?:^|\n)【([^【】\n]{1,60})】/g;
  const marks = [];
  let m;
  while ((m = headerRe.exec(raw)) !== null) {
    marks.push({ name: m[1], start: m.index + (raw[m.index] === '\n' ? 1 : 0) });
  }
  const segments = [];
  for (let i = 0; i < marks.length; i += 1) {
    const from = marks[i].start;
    const to = i + 1 < marks.length ? marks[i + 1].start : raw.length;
    segments.push({ name: marks[i].name, chars: to - from });
  }
  // 第一个「【】」之前的裸前言（如有）单独记一段，避免它被悄悄吞掉。
  if (marks.length === 0 && raw.trim()) {
    segments.push({ name: '(无段名前言)', chars: raw.length });
  } else if (marks.length > 0 && marks[0].start > 0 && raw.slice(0, marks[0].start).trim()) {
    segments.unshift({ name: '(无段名前言)', chars: marks[0].start });
  }
  return {
    totalChars: raw.length,
    hash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
    segmentCount: segments.length,
    segments
  };
}

/** 回合 id：时间戳 36 进制 + 随机尾，肉眼可读且不撞车。 */
export function newTurnId() {
  return `t_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 语料样本 id：`s_` + 会话 key 与消息标识的联合哈希（脱敏且稳定）。
 * 语料抽取（simulation-corpus.mjs）与注意力 shadow 都用它，评估时按 id 精确对齐。
 */
export function sampleId(key, msgRef) {
  return `s_${(hashId(`${key}|${msgRef}`) ?? '').slice(2, 10)}`;
}

/** trace 记录允许出现的顶层字段（白名单）。其余字段一律丢弃。 */
const RECORD_FIELDS = Object.freeze([
  'turnId', 'ts', 'durationMs', 'key', 'wakeReason', 'promptSnapshot',
  'outcome', 'send', 'textChars', 'usage', 'attention', 'memory', 'state', 'style', 'rhythm', 'persona'
]);

function asShortString(value, max = 200) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, max);
}

function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

/**
 * 构建一条 trace 记录（字段白名单 + 类型收敛）。
 * key 自动脱敏；textChars 只是**字符数**不是正文；未知字段收进 droppedFields 留痕。
 */
export function buildTurnRecord(input = {}) {
  const dropped = Object.keys(input).filter((k) => !RECORD_FIELDS.includes(k));
  const record = {
    turnId: asShortString(input.turnId) || newTurnId(),
    ts: asShortString(input.ts) || new Date().toISOString(),
    durationMs: asCount(input.durationMs),
    key: redactKey(input.key),
    wakeReason: asShortString(input.wakeReason),
    promptSnapshot: input.promptSnapshot && typeof input.promptSnapshot === 'object' ? input.promptSnapshot : null,
    outcome: asShortString(input.outcome),
    send: input.send && typeof input.send === 'object'
      ? { attempted: !!input.send.attempted, ok: input.send.ok === true ? true : (input.send.ok === false ? false : null) }
      : null,
    textChars: asCount(input.textChars),
    usage: input.usage && typeof input.usage === 'object' ? input.usage : null,
    attention: input.attention && typeof input.attention === 'object' ? input.attention : null,
    memory: input.memory && typeof input.memory === 'object' ? input.memory : null,
    state: input.state && typeof input.state === 'object' ? input.state : null,
    style: input.style && typeof input.style === 'object' ? input.style : null,
    rhythm: input.rhythm && typeof input.rhythm === 'object' ? input.rhythm : null,
    persona: input.persona && typeof input.persona === 'object' ? input.persona : null
  };
  if (dropped.length) record.droppedFields = dropped;
  return record;
}

function ymd(date) {
  const d = date instanceof Date ? date : new Date(date ?? Date.now());
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * trace 落盘器：按日分文件追加 JSONL。
 * write/read 不做异常兜底（调用方是 recorder 或离线脚本，各自决定怎么处理错误）。
 */
export function createTraceWriter({ dir, now = () => new Date() } = {}) {
  if (!dir) throw new Error('createTraceWriter 需要 dir');
  return {
    fileFor(date) {
      return path.join(dir, `simulation-trace-${ymd(date ?? now())}.jsonl`);
    },
    write(record, date) {
      const file = this.fileFor(date);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      return file;
    },
    read(date) {
      const file = this.fileFor(date);
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    }
  };
}

/**
 * 回合记录器：桥接在投递/turn/start/turn/end 三处各调一次，其余它自己管。
 * **所有方法异常自兜底**（吞错 + 回调日志）——观测层绝不能把聊天主链路带崩。
 */
export function createTurnRecorder({ writer, log = () => {}, now = () => Date.now() } = {}) {
  const pendingBySession = new Map(); // sessionId -> 投递时的元数据（等待 turn/start 消费）
  const openBySession = new Map(); // sessionId -> 进行中回合草稿（等待 turn/end 落盘）

  return {
    /** 投递 prompt 时记录元数据与结构快照；promptText 传 null 则不做快照。attention（P0.7 shadow 决策）、persona（1.5 锚点决策）与 state（2.1 PAD 情感决策）随记录落盘。 */
    queueDelivery(sessionId, { key, wakeReason, promptText, attention, persona, state } = {}) {
      try {
        pendingBySession.set(String(sessionId), {
          key: key ?? null,
          wakeReason: wakeReason ?? null,
          promptSnapshot: promptText ? snapshotPrompt(promptText) : null,
          attention: attention && typeof attention === 'object' ? attention : null,
          persona: persona && typeof persona === 'object' ? persona : null,
          state: state && typeof state === 'object' ? state : null,
          queuedAt: now()
        });
      } catch (error) {
        log('simulation trace：queueDelivery 失败', error?.message ?? error);
      }
    },
    /** turn/start：消费待投递元数据，开出回合草稿。没有投递元数据的回合（普通转发/摘要静默等）不进 trace。 */
    onTurnStart(sessionId, turnId) {
      try {
        const id = String(sessionId);
        const pending = pendingBySession.get(id) ?? null;
        pendingBySession.delete(id);
        if (!pending) return;
        openBySession.set(id, {
          turnId: turnId ? String(turnId) : newTurnId(),
          startedAt: now(),
          key: pending.key,
          wakeReason: pending.wakeReason,
          promptSnapshot: pending.promptSnapshot,
          attention: pending.attention ?? null,
          persona: pending.persona ?? null,
          state: pending.state ?? null
        });
      } catch (error) {
        log('simulation trace：onTurnStart 失败', error?.message ?? error);
      }
    },
    /**
     * turn/end：落一条 trace。没有对应草稿/待投递的回合（非仿真唤醒回合）**不落盘**，
     * 保证 trace 只覆盖三代仿真的唤醒回合。
     */
    onTurnEnd(sessionId, { reasonKind, sendAttempted, sendOk, textChars } = {}) {
      try {
        const id = String(sessionId);
        const draft = openBySession.get(id) ?? null;
        openBySession.delete(id);
        if (!draft && !pendingBySession.has(id)) return null;
        // turn/start 丢了（重连补发等）但有未消费的投递元数据：也落盘，标注 outcome 缺回合。
        const meta = draft ?? pendingBySession.get(id) ?? {};
        if (!draft) pendingBySession.delete(id);
        const file = writer.write(buildTurnRecord({
          turnId: draft?.turnId ?? newTurnId(),
          ts: new Date(meta.queuedAt ?? now()).toISOString(),
          durationMs: draft ? now() - draft.startedAt : null,
          key: meta.key,
          wakeReason: meta.wakeReason,
          promptSnapshot: meta.promptSnapshot,
          attention: meta.attention ?? null,
          persona: meta.persona ?? null,
          state: meta.state ?? null,
          outcome: draft ? (reasonKind ?? null) : 'no-turn-start',
          send: sendAttempted || sendOk === true ? { attempted: !!sendAttempted, ok: sendOk ?? null } : null,
          textChars
        }));
        return file;
      } catch (error) {
        log('simulation trace：onTurnEnd 失败', error?.message ?? error);
        return null;
      }
    }
  };
}
