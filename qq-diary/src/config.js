// 配置加载与校验（含 qq-bridge 侧的只读事实读取）。
//
// 本模块只做「读 + 规整 + 校验」：不写任何文件、不打印密钥。
// qq-bridge 的文件全部按只读处理：config.json / state/current-role.json / state/console-token。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'js-yaml';
import { parseWriteAt, assertTimeZone, DEFAULT_TIMEZONE } from './scheduler.js';

export const DEFAULT_CONFIG = {
  qqBridgeDir: 'D:\\github\\qq-bridge',
  diaryDir: '',
  logDir: '',
  timezone: DEFAULT_TIMEZONE,
  writeAt: '22:00', // v1.4 主人已定：写入时间由 23:30 改为 22:00
  lookbackHours: 24,
  maxContextChars: 10000,
  privateShare: 0.6,
  includeGroups: true,
  includeOtherPrivates: false,
  maxPerConversationChars: 3000,
  minDiaryChars: 200,
  maxDiaryChars: 400,
  model: 'deepseek-v4-flash',
  baseURL: 'https://api.deepseek.com/anthropic/v1',
  apiKey: '',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  timeoutMs: 120000,
  maxRetries: 2,
  redactPatterns: true,
  notifyOwner: {
    enabled: true,
    maxChars: 80,
    template: '📔 {date} 日记已写好：{summary}',
    retryMax: 3,
    channels: ['snowluma', 'bridge'],
    timeoutMs: 15000
  },
  // ── 进阶项（有默认值，一般不用改） ──
  maxRoleChars: 3000,
  maxMessageChars: 300,
  maxTokens: 1600,
  activityLogLines: 100,
  maxActivityChars: 1500,
  maxTopicsChars: 500,
  maxImpressionsChars: 400,
  tickMs: 60000,
  retryDelayMs: 900000,
  maxDailyRetries: 2,
  dryRunCallsLlm: false,
  // 每日写入上限（§17.5 第 6 条，含 force 重写）
  maxWritesPerDay: 3,
  // ── 表现面（GEN3_SURFACE_INTEGRATION_PLAN S3）：默认全关＝旧链路零变化 ──
  surface: {
    enabled: false,
    contextSource: 'v2',   // v2=读本地文件（旧行为）；v3=桥接 surface/context API（失败自动回退 v2）
    writeMemory: false,    // 日记摘要幂等写回长期记忆（surface-token，重试队列）
    deferIfActiveMinutes: 0,  // 活跃期延后（v1.4 建议先关，观察后再开）
    maxDeferMinutes: 60
  }
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function positiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function ratio(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** 允许相对路径（相对项目根）；空串用默认值。 */
export function resolveConfiguredPath(value, root, fallbackRelative) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return path.join(root, fallbackRelative);
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
}

/**
 * 读 config.json 并与默认值合并。
 * 返回 { config, warnings, configFile }；任何字段非法只降级 + warning，不抛错。
 */
export function loadConfig({ root = process.cwd(), file = '', env = process.env } = {}) {
  const projectRoot = path.resolve(root);
  const configFile = file ? path.resolve(file) : path.join(projectRoot, 'config.json');
  const warnings = [];
  let fileConfig = {};
  try {
    const text = fs.readFileSync(configFile, 'utf8');
    fileConfig = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (!isPlainObject(fileConfig)) {
      warnings.push('config.json 顶层不是对象，已忽略文件内容');
      fileConfig = {};
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      warnings.push(`未找到 ${configFile}，使用默认配置（可复制 config.example.json）`);
    } else {
      warnings.push(`config.json 读取失败（${error?.message ?? error}），使用默认配置`);
    }
  }

  const raw = { ...DEFAULT_CONFIG, ...fileConfig };
  const notifyRaw = isPlainObject(raw.notifyOwner) ? { ...DEFAULT_CONFIG.notifyOwner, ...raw.notifyOwner } : { ...DEFAULT_CONFIG.notifyOwner };

  const config = { ...raw };
  config.projectRoot = projectRoot;
  config.configFile = configFile;
  config.qqBridgeDir = resolveConfiguredPath(raw.qqBridgeDir, projectRoot, '..\\qq-bridge');
  config.diaryDir = resolveConfiguredPath(raw.diaryDir, projectRoot, 'diaries');
  config.logDir = resolveConfiguredPath(raw.logDir, projectRoot, 'logs');
  // 所有日记写在同一个文件里（按日期升序）；只接受文件名，不允许带路径分隔符
  const diaryFileRaw = typeof raw.diaryFile === 'string' ? raw.diaryFile.trim() : '';
  const diaryFileBase = diaryFileRaw ? path.basename(diaryFileRaw.replace(/[\\/]+/g, '/')) : '';
  config.diaryFile = diaryFileBase && /\.md$/i.test(diaryFileBase) ? diaryFileBase : 'diary.md';
  if (diaryFileRaw && config.diaryFile !== diaryFileRaw) {
    warnings.push(`diaryFile ${JSON.stringify(diaryFileRaw)} 无效（必须是 .md 文件名，不能带路径），已用 ${config.diaryFile}`);
  }
  config.stateDir = path.join(projectRoot, 'state');
  config.lockFile = path.join(config.stateDir, 'daemon.pid');
  config.indexFile = path.join(config.diaryDir, 'index.json');
  config.backupDir = path.join(config.diaryDir, '.backup');

  try {
    config.timezone = assertTimeZone(str(raw.timezone, DEFAULT_TIMEZONE));
  } catch {
    warnings.push(`时区 ${raw.timezone} 无效，回退 ${DEFAULT_TIMEZONE}`);
    config.timezone = DEFAULT_TIMEZONE;
  }

  const writeAt = parseWriteAt(raw.writeAt);
  if (!writeAt) {
    warnings.push(`writeAt ${JSON.stringify(raw.writeAt)} 无效，回退 22:00`);
    config.writeAt = '22:00';
  } else {
    config.writeAt = `${String(writeAt.hour).padStart(2, '0')}:${String(writeAt.minute).padStart(2, '0')}`;
  }

  // 表现面段（S3）：浅合并 + 收敛，未知键忽略
  const surfaceRaw = isPlainObject(raw.surface) ? { ...DEFAULT_CONFIG.surface, ...raw.surface } : { ...DEFAULT_CONFIG.surface };
  config.surface = {
    enabled: surfaceRaw.enabled === true,
    contextSource: surfaceRaw.contextSource === 'v3' ? 'v3' : 'v2',
    writeMemory: surfaceRaw.writeMemory === true,
    deferIfActiveMinutes: positiveInt(surfaceRaw.deferIfActiveMinutes, 0, 0, 120),
    maxDeferMinutes: positiveInt(surfaceRaw.maxDeferMinutes, 60, 0, 180)
  };
  config.maxWritesPerDay = positiveInt(raw.maxWritesPerDay, 3, 1, 10);

  config.lookbackHours = positiveInt(raw.lookbackHours, 24, 1, 168);
  config.maxContextChars = positiveInt(raw.maxContextChars, 10000, 500, 50000);
  config.privateShare = ratio(raw.privateShare, 0.6);
  config.includeGroups = raw.includeGroups !== false;
  config.includeOtherPrivates = raw.includeOtherPrivates === true;
  config.maxPerConversationChars = positiveInt(raw.maxPerConversationChars, 3000, 200, 30000);
  config.minDiaryChars = positiveInt(raw.minDiaryChars, 200, 50, 2000);
  config.maxDiaryChars = positiveInt(raw.maxDiaryChars, 400, 100, 4000);
  if (config.maxDiaryChars <= config.minDiaryChars) {
    warnings.push(`maxDiaryChars(${config.maxDiaryChars}) 必须大于 minDiaryChars(${config.minDiaryChars})，已按 min+100 调整`);
    config.maxDiaryChars = config.minDiaryChars + 100;
  }
  config.model = str(raw.model, DEFAULT_CONFIG.model);
  config.baseURL = str(raw.baseURL, DEFAULT_CONFIG.baseURL).replace(/\/+$/, '');
  config.apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  config.apiKeyEnv = str(raw.apiKeyEnv, 'DEEPSEEK_API_KEY');
  config.timeoutMs = positiveInt(raw.timeoutMs, 120000, 5000, 600000);
  config.maxRetries = positiveInt(raw.maxRetries, 2, 0, 5);
  config.redactPatterns = raw.redactPatterns !== false;

  config.notifyOwner = {
    enabled: notifyRaw.enabled !== false,
    maxChars: positiveInt(notifyRaw.maxChars, 80, 20, 500),
    template: str(notifyRaw.template, DEFAULT_CONFIG.notifyOwner.template),
    retryMax: positiveInt(notifyRaw.retryMax, 3, 1, 10),
    channels: Array.isArray(notifyRaw.channels)
      ? notifyRaw.channels.filter((c) => c === 'snowluma' || c === 'bridge')
      : [...DEFAULT_CONFIG.notifyOwner.channels],
    timeoutMs: positiveInt(notifyRaw.timeoutMs, 15000, 1000, 120000)
  };
  if (!config.notifyOwner.channels.length) {
    warnings.push('notifyOwner.channels 为空，已回退 ["snowluma","bridge"]');
    config.notifyOwner.channels = [...DEFAULT_CONFIG.notifyOwner.channels];
  }
  if (!config.notifyOwner.template.includes('{date}') && !config.notifyOwner.template.includes('{summary}')) {
    warnings.push('notifyOwner.template 不含 {date}/{summary} 占位符，将直接发送模板原文');
  }

  config.maxRoleChars = positiveInt(raw.maxRoleChars, 3000, 200, 20000);
  config.maxMessageChars = positiveInt(raw.maxMessageChars, 300, 20, 2000);
  config.maxTokens = positiveInt(raw.maxTokens, 1600, 200, 8000);
  config.activityLogLines = positiveInt(raw.activityLogLines, 100, 5, 500);
  config.maxActivityChars = positiveInt(raw.maxActivityChars, 1500, 100, 8000);
  config.maxTopicsChars = positiveInt(raw.maxTopicsChars, 500, 0, 4000);
  config.maxImpressionsChars = positiveInt(raw.maxImpressionsChars, 400, 0, 4000);
  config.tickMs = positiveInt(raw.tickMs, 60000, 5000, 3600000);
  config.retryDelayMs = positiveInt(raw.retryDelayMs, 900000, 10000, 86400000);
  config.maxDailyRetries = positiveInt(raw.maxDailyRetries, 2, 0, 10);
  config.dryRunCallsLlm = raw.dryRunCallsLlm === true;

  // 环境变量只用来判断来源，不落盘、不回显
  config.apiKeyEnvName = config.apiKeyEnv;
  void env;

  return { config, warnings, configFile };
}

/** 读取 DSH 凭据：$DSH_HOME/.credentials.yaml → refs.<ref>。失败返回空串。 */
export function readDshCredential(ref, { dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh') } = {}) {
  const name = String(ref ?? '').trim();
  if (!name) return '';
  try {
    const doc = YAML.load(fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8'));
    const value = doc?.refs?.[name];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

export function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, data: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text), error: null };
  } catch (error) {
    return { ok: false, data: null, error: error?.code === 'ENOENT' ? 'missing' : String(error?.message ?? error) };
  }
}

/**
 * 读 qq-bridge 的只读事实（ownerQQ、SnowLuma HTTP 端点/令牌、控制台端口、白名单）。
 * 只读：绝不写回 qq-bridge 的任何文件。
 */
export function loadBridgeFacts(qqBridgeDir) {
  const dir = String(qqBridgeDir ?? '').trim();
  const file = dir ? path.join(dir, 'config.json') : '';
  const read = file ? readJsonFile(file) : { ok: false, error: 'qqBridgeDir 未配置', data: null };
  const data = isPlainObject(read.data) ? read.data : {};
  const snowluma = isPlainObject(data.snowluma) ? data.snowluma : {};
  const allow = isPlainObject(data.allow) ? data.allow : {};
  // 表现面 S4（§8.7 日记→空间）：开关与空间正文上限都取桥接侧单一源（控制台可改），
  // 与桥接 createQzoneService 的 diaryShareEnabled 判定完全一致（三层：socialV3.enabled
  // + modules.surface + surface.diary.shareToQzone）。
  const socialV3 = isPlainObject(data.socialV3) ? data.socialV3 : {};
  const v3Modules = isPlainObject(socialV3.modules) ? socialV3.modules : {};
  const v3Surface = isPlainObject(socialV3.surface) ? socialV3.surface : {};
  const v3Diary = isPlainObject(v3Surface.diary) ? v3Surface.diary : {};
  const qzoneCfg = isPlainObject(data.qzone) ? data.qzone : {};
  const facts = {
    ok: read.ok,
    error: read.ok ? null : read.error,
    file,
    ownerQQ: Number.isFinite(Number(data.ownerQQ)) ? Number(data.ownerQQ) : null,
    // 桥接侧 DSH 模型名：角色自写日记时写进 frontmatter.model（只读）
    dshModel: str(data?.dsh?.model),
    // 日记→空间（S4）：默认关；打开后 diary_share_to_qzone 才放行（发布仍要主人确认）
    diaryShareEnabled: socialV3.enabled === true && v3Modules.surface === true && v3Diary.shareToQzone === true,
    qzoneMaxContentChars: positiveInt(qzoneCfg.maxContentChars, 1000, 1, 5000),
    snowluma: {
      httpUrl: str(snowluma.httpUrl).replace(/\/+$/, ''),
      accessToken: typeof snowluma.accessToken === 'string' ? snowluma.accessToken.trim() : ''
    },
    consolePort: positiveInt(data.consolePort, 3100, 1, 65535),
    allow: {
      private: Array.isArray(allow.private) ? allow.private.map(Number).filter(Number.isFinite) : [],
      groups: Array.isArray(allow.groups) ? allow.groups.map(Number).filter(Number.isFinite) : []
    }
  };
  return facts;
}

/** 读桥接控制台令牌（只读）；日志/输出里绝不回显。 */
export function readBridgeConsoleToken(qqBridgeDir) {
  try {
    return fs.readFileSync(path.join(String(qqBridgeDir), 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** 读桥接当前模式（只读）：state/mode.json + state/social-v2.json 的 paused。 */
export function readBridgeMode(qqBridgeDir) {
  const modeFile = readJsonFile(path.join(String(qqBridgeDir), 'state', 'mode.json'));
  const socialFile = readJsonFile(path.join(String(qqBridgeDir), 'state', 'social-v2.json'));
  return {
    mode: str(modeFile.data?.mode),
    paused: socialFile.ok ? socialFile.data?.paused === true : null,
    ready: modeFile.ok
  };
}
