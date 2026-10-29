// 一次性确认令牌（§9.3）：TTL 60 秒、单次使用，绑定 {tool, argsHash}；任一变化即失效。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail } from './policy.mjs';

const CONFIRM_FILE = 'confirm.json';

export function hashArgs(args) {
  const ordered = Object.keys(args ?? {}).sort().map((key) => [key, args[key]]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex').slice(0, 32);
}

export class ConfirmStore {
  constructor({ stateDir, ttlMs = 60_000, now = Date.now } = {}) {
    Object.assign(this, { stateDir, ttlMs, now, file: path.join(stateDir, CONFIRM_FILE) });
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) ?? []; } catch { return []; }
  }

  #write(tokens) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(tokens));
  }

  // 第一次调用写工具：签发待确认令牌，返回人话摘要与令牌，不执行动作。
  issue({ tool, argsHash, summary }) {
    const tokens = this.#read().filter((item) => item.expiresAt > this.now());
    const token = randomUUID();
    tokens.push({ token, tool, argsHash, summary, createdAt: this.now(), expiresAt: this.now() + this.ttlMs });
    this.#write(tokens);
    return { token, summary, expiresAt: this.now() + this.ttlMs };
  }

  // 第二次调用携带令牌执行：单次消费，绑定不匹配即失效（CONFIRM_MISMATCH / CONFIRM_EXPIRED）。
  consume({ tool, argsHash, token }) {
    const tokens = this.#read();
    const index = tokens.findIndex((item) => item.token === token);
    if (index < 0) throw fail('CONFIRM_MISMATCH', '确认令牌无效或已消费。', '请重新发起写操作以获取新令牌。');
    const item = tokens[index];
    if (item.tool !== tool || item.argsHash !== argsHash) {
      this.#write(tokens.filter((_, i) => i !== index));
      throw fail('CONFIRM_MISMATCH', '确认令牌与本次动作不匹配（目标或参数已变化）。', '请重新发起写操作以获取新令牌。');
    }
    if (item.expiresAt <= this.now()) {
      this.#write(tokens.filter((_, i) => i !== index));
      throw fail('CONFIRM_EXPIRED', '确认令牌已过期（TTL 60 秒）。', '请重新发起写操作以获取新令牌。');
    }
    this.#write(tokens.filter((_, i) => i !== index));
    return true;
  }
}
