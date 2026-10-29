// 测试公共工具：临时项目根、假 qq-bridge、假 fetch、假定时器、日记文本生成。
//
// 约定：
// - 所有可写目录都在 os.tmpdir() 下自建，测试之间互不共享；after(cleanupTempRoots) 统一清理。
// - 永远不读写真 qq-bridge 的可写文件；假 qq-bridge 目录由 makeFakeBridge 造在临时目录里。
// - 时间统一注入（FIXED_NOW），不使用真实时钟等待。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { loadConfig, loadBridgeFacts } from '../src/config.js';
import { countDiaryChars } from '../src/prompt.js';
import { readCollection } from '../src/store.js';

export const FIXED_NOW = new Date('2026-10-23T23:35:00+08:00');
export const FIXED_TODAY = '2026-10-23';
export const FIXED_WEEKDAY = '星期五';
export const OWNER_QQ = 10001;
export const GROUP_ID = 30001;
export const DEFAULT_ROLE = '蓝莓球';
export const DEFAULT_ROLE_TEXT =
  '我是蓝莓球，一个住在 QQ 群里的小家伙。说话软软的，喜欢甜食，晚上容易犯困，但被叫到名字会立刻精神起来。';
export const SNOWLUMA_TOKEN = 'snowluma-token-123456';
export const CONSOLE_TOKEN = 'console-token-abcdef123456';
export const AGENT_TOKEN = 'agent-token-abcdef123456';

const tempRoots = [];

export function mkTempRoot(prefix = 'qqdiary-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

export function cleanupTempRoots() {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上偶发占用：临时目录交给系统回收，不阻断测试结果
    }
  }
}

export function writeTextFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

export function writeJsonFile(file, data) {
  writeTextFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJsonFileSync(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function countMatches(text, regex) {
  return (String(text ?? '').match(regex) ?? []).length;
}

/** 造一个假的 qq-bridge 目录（只给测试读；绝不指向真仓库）。 */
export function makeFakeBridge(
  root,
  {
    ownerQQ = OWNER_QQ,
    snowluma = { httpUrl: 'http://127.0.0.1:19999', accessToken: SNOWLUMA_TOKEN },
    consolePort = 3100,
    role = DEFAULT_ROLE,
    roleText = DEFAULT_ROLE_TEXT,
    consoleToken = CONSOLE_TOKEN,
    writeConsoleToken = true,
    writeCurrentRole = true,
    writeRoleFile = true,
    extraConfig = {}
  } = {}
) {
  const dir = path.join(root, 'qq-bridge');
  writeJsonFile(path.join(dir, 'config.json'), {
    ownerQQ,
    snowluma: { httpUrl: snowluma.httpUrl, accessToken: snowluma.accessToken },
    consolePort,
    allow: { private: [ownerQQ], groups: [GROUP_ID] },
    ...extraConfig
  });
  if (writeConsoleToken) writeTextFile(path.join(dir, 'state', 'console-token'), `${consoleToken}\n`);
  if (writeCurrentRole) writeJsonFile(path.join(dir, 'state', 'current-role.json'), { role, mode: 'reserved2' });
  if (writeRoleFile) writeTextFile(path.join(dir, 'roles', `${role}.md`), roleText);
  return dir;
}

/**
 * 造一个完整的临时项目：temp root + config.json + 假 qq-bridge，并用 loadConfig 加载，
 * 保证 config 字段与真实运行时一致（不手搓半成品 config）。
 */
export function createProject({
  config = {},
  bridge = {},
  social,
  role = DEFAULT_ROLE,
  roleText = DEFAULT_ROLE_TEXT
} = {}) {
  const root = mkTempRoot();
  const bridgeDir = makeFakeBridge(root, { ...bridge, role, roleText });
  if (social !== undefined) writeJsonFile(path.join(bridgeDir, 'state', 'social-v2.json'), social);

  const fileConfig = {
    qqBridgeDir: bridgeDir,
    diaryDir: 'diaries',
    logDir: 'logs',
    apiKey: 'test-key-0123456789abcdef',
    baseURL: 'https://llm.invalid/v1',
    maxRetries: 0,
    timeoutMs: 5000,
    ...config
  };
  writeJsonFile(path.join(root, 'config.json'), fileConfig);

  const loaded = loadConfig({ root });
  const diaryFile = () => path.join(loaded.config.diaryDir, loaded.config.diaryFile || 'diary.md');
  const bridgeFile = (...parts) => path.join(bridgeDir, ...parts);
  return {
    root,
    bridgeDir,
    bridgeFile,
    config: loaded.config,
    warnings: loaded.warnings,
    configFile: loaded.configFile,
    facts: loadBridgeFacts(bridgeDir),
    now: FIXED_NOW,
    diaryDir: loaded.config.diaryDir,
    socialPath: path.join(bridgeDir, 'state', 'social-v2.json'),
    stateFile: (name) => path.join(loaded.config.stateDir, name),
    writeSocial(data) {
      writeJsonFile(path.join(bridgeDir, 'state', 'social-v2.json'), data);
    },
    /** 合集文件路径（diaries/diary.md）。 */
    diaryFile
  };
}

/** 读临时项目的日记合集条目（按日期升序）。 */
export function readEntries(project) {
  const collection = readCollection({ config: project.config });
  return collection.entries;
}

/** 按日期在合集里取一篇；没有则 null。 */
export function readEntry(project, dateKey) {
  return readEntries(project).find((entry) => entry.date === dateKey) ?? null;
}

/** 构造一条 social-v2.json 里的 recentMessages 记录。 */
export function msg(text, minutesAgo = 30, { now = FIXED_NOW, ...extra } = {}) {
  return { time: now.getTime() - Math.round(minutesAgo * 60000), text, ...extra };
}

/** group:/private: 会话包装。 */
export function conversation(messages = [], extra = {}) {
  return { recentMessages: messages, ...extra };
}

const DIARY_SENTENCES = [
  '今天醒来的时候窗外有雾，玻璃上蒙着一层白。',
  '中午和大家聊到吃什么，最后还是点了常吃的那家。',
  '下午有点犯困，趴在桌上听了一会儿歌。',
  '傍晚群里突然热闹起来，我看了半天也没插上话。',
  '晚上煮了碗面，加了两个蛋，味道比想象中好。',
  '睡前想起白天的一句玩笑，忍不住又笑了一下。',
  '今天没什么大事，但心里挺安稳的。'
];

/** 生成至少 targetChars 个中文字符的确定性日记正文。 */
export function diaryText(targetChars = 300) {
  const out = [];
  let count = 0;
  let index = 0;
  while (count < targetChars && index < 200) {
    const sentence = DIARY_SENTENCES[index % DIARY_SENTENCES.length];
    out.push(sentence);
    count += countDiaryChars(sentence);
    index += 1;
  }
  return out.join('');
}

export const DEFAULT_SUMMARY = '今天过得很平静，聊了会儿天，心情不错。';

/** 生成 200~400 字中文日记的模型 JSON 文本：{"diary":...,"summary":...}。 */
export function diaryJson(chars = 300, summary = DEFAULT_SUMMARY) {
  return JSON.stringify({ diary: diaryText(chars), summary });
}

/** Anthropic Messages 风格的正常响应体。 */
export function llmBody({ chars = 300, summary = DEFAULT_SUMMARY, model = 'deepseek-v4-flash' } = {}) {
  const text = JSON.stringify({ diary: diaryText(chars), summary });
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 321, output_tokens: 456 },
    model
  };
}

/** 把对象包成 fetch 的 Response。 */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export function textResponse(body, status = 200) {
  return new Response(String(body ?? ''), { status });
}

/** 可记录调用的假 fetch：handler(record, nth) 返回 Response（也可抛错）。 */
export function makeFetchMock(handler = () => jsonResponse({})) {
  const calls = [];
  const mock = async (url, options = {}) => {
    const record = { url: String(url), options, method: options?.method ?? 'GET' };
    calls.push(record);
    return handler(record, calls.length);
  };
  mock.calls = calls;
  return mock;
}

/** 直接返回一次标准 LLM 响应的假 fetch。 */
export function llmFetchMock(options = {}) {
  return makeFetchMock(() => jsonResponse(llmBody(options)));
}

/**
 * 假定时器：只收集回调，由测试手动 runIntervals / runTimeouts 触发。
 * startScheduler 只依赖 now() 计算时间，定时器仅用于「什么时候 tick」。
 */
export function makeFakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setInterval(fn, ms) {
      const id = nextId;
      nextId += 1;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    get intervalCount() {
      return intervals.size;
    },
    get timeoutCount() {
      return timeouts.size;
    },
    get timeoutDelays() {
      return [...timeouts.values()].map((item) => item.ms);
    },
    runIntervals() {
      for (const item of [...intervals.values()]) item.fn();
    },
    runTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const item of pending) item.fn();
    }
  };
}

/** 让所有已排队的 Promise 回调跑完（fire 是 async 的）。 */
export function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function sleepReal(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
