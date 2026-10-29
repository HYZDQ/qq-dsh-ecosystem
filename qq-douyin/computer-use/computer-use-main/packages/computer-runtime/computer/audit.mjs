// 审计收据与结构化日志（§9.5 / §11.1）：
// 24h 内同 {app, action, target, textHash} 去重返回既有收据；日志只留文本 hash 与前 8 字符，不落明文/截图/剪贴板。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const RECEIPTS_FILE = 'receipts.jsonl';
const LOG_FILE = 'computer.jsonl';
const DAY_MS = 24 * 60 * 60_000;

export function textDigest(text) {
  const value = String(text ?? '');
  return { textHash: createHash('sha256').update(value).digest('hex').slice(0, 32), textHead: [...value].slice(0, 8).join('') };
}

export function receiptKey(tool, action, target, textHash) {
  return { tool, action, target, textHash };
}

export class AuditLog {
  constructor({ stateDir, now = Date.now } = {}) {
    Object.assign(this, { stateDir, now, receiptsFile: path.join(stateDir, RECEIPTS_FILE), logFile: path.join(stateDir, LOG_FILE) });
  }

  #append(file, entry) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  }

  #readReceipts() {
    try {
      return fs.readFileSync(this.receiptsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
  }

  log(entry) {
    this.#append(this.logFile, { at: this.now(), ...entry });
  }

  // 24h 去重查重（§9.5）：命中返回既有收据，调用方据此跳过重复执行。
  lookup({ tool, action, target, textHash }) {
    return this.#readReceipts().find((item) => this.now() - item.at < DAY_MS && item.textHash === textHash
      && item.tool === tool && item.action === action && item.target === target) ?? null;
  }

  // 写动作收据。默认每次执行都记新收据（GUI 重复点击是合法操作，不做跳过）；
  // allowDuplicate=false 时启用 24h 去重（适用于对外发送类一次性动作，如任务结束收据）。
  receipt({ tool, app = '', action, target = '', textHash = '', ok, verified, detail = undefined, allowDuplicate = true }) {
    const hit = this.lookup({ tool, action, target, textHash });
    if (hit && !allowDuplicate) return { receiptId: hit.receiptId, deduped: true, verified: hit.verified };
    const receipt = { receiptId: `rcp-${randomUUID().slice(0, 8)}`, at: this.now(), tool, app, action, target, textHash, ok, verified, detail };
    this.#append(this.receiptsFile, receipt);
    return { receiptId: receipt.receiptId, deduped: false, duplicateOf: hit?.receiptId ?? null, verified };
  }

  recent(limit = 20) {
    return this.#readReceipts().slice(-limit);
  }
}
