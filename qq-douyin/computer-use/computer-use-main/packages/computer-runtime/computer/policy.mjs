// 电脑操控策略与权限闸门（P0）。
// 约定来源：docs/computer-agent-development.md §9；fail-closed 优先——任何缺失配置都拒绝写操作。
import fs from 'node:fs';
import path from 'node:path';

// 驱动白名单之外的 windows-mcp 工具一律不得被 computer_* 调用（§8.4 L3 永久禁用 / §13 契约）。
export const FORBIDDEN_DRIVER_TOOLS = Object.freeze(['PowerShell', 'Registry', 'Process', 'FileSystem', 'Scrape', 'MultiEdit', 'MultiSelect', 'Notification']);
// P0 允许触达的驱动工具（其余默认拒绝）。
export const ALLOWED_DRIVER_TOOLS = Object.freeze(['Snapshot', 'Screenshot', 'Click', 'Type', 'Shortcut', 'Move', 'Scroll', 'App', 'Wait', 'Clipboard']);

export const STOP_FILENAME = 'STOP';
export const POLICY_FILENAME = 'policy.json';
const DEFAULT_TITLE_DENY = ['DSH', '1Password', 'Bitwarden', '银行', 'UAC', '凭据', 'Credential'];

export function fail(code, message, hint) {
  return Object.assign(new Error(message), { code, hint });
}

export function defaultPolicy() {
  return {
    profile: 'standard',
    enabled: true,
    control: { channel: 'private', adminIds: [] },
    apps: [],
    domains: [],
    titleDeny: [...DEFAULT_TITLE_DENY],
    allowShell: false,
    allowVisionFallback: true,
  };
}

export function policyPath(stateDir) {
  return path.join(stateDir, POLICY_FILENAME);
}

export function stopFilePath(stateDir) {
  return path.join(stateDir, STOP_FILENAME);
}

export function stopRequested(stateDir) {
  try { return fs.existsSync(stopFilePath(stateDir)); } catch { return true; }
}

// 策略文件缺失时按默认值创建（enabled=true 但 apps/adminIds 为空，写操作仍然 fail-closed）；
// 文件损坏或关键字段非法时恢复默认并标记 invalid，由调用方提示用户（§11.2 POLICY_INVALID）。
export function loadPolicy(stateDir) {
  const file = policyPath(stateDir);
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') return { policy: defaultPolicy(), invalid: true, file }; }
  if (raw === null) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(defaultPolicy(), null, 2));
    } catch { /* 只读环境下沿用内存默认值 */ }
    return { policy: defaultPolicy(), invalid: false, file };
  }
  try {
    const parsed = JSON.parse(raw);
    const policy = { ...defaultPolicy(), ...parsed, control: { ...defaultPolicy().control, ...(parsed?.control ?? {}) } };
    if (!Array.isArray(policy.apps) || !Array.isArray(policy.domains) || !Array.isArray(policy.control.adminIds) || !Array.isArray(policy.titleDeny)) throw new Error('列表字段格式错误');
    if (!['safe', 'standard', 'power'].includes(policy.profile)) throw new Error('profile 非法');
    if (policy.control.channel !== 'private') throw new Error('control.channel 只允许 private');
    return { policy, invalid: false, file };
  } catch {
    return { policy: defaultPolicy(), invalid: true, file };
  }
}

// 更新并落盘策略（设置页 P2）：只接受白名单字段，校验规则与 loadPolicy 一致；失败抛 POLICY_INVALID 不落盘。
export function updatePolicy(stateDir, patch = {}) {
  const { policy } = loadPolicy(stateDir);
  const next = {
    ...policy,
    control: { ...policy.control, ...(patch.control ?? {}) },
  };
  for (const key of ['enabled', 'allowShell', 'allowVisionFallback']) {
    if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
  }
  for (const key of ['profile']) {
    if (patch[key] !== undefined) next[key] = String(patch[key]);
  }
  for (const key of ['apps', 'domains', 'titleDeny']) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.control?.adminIds !== undefined) next.control.adminIds = patch.control.adminIds;
  if (!Array.isArray(next.apps) || !Array.isArray(next.domains) || !Array.isArray(next.control.adminIds) || !Array.isArray(next.titleDeny)) throw fail('POLICY_INVALID', '列表字段格式错误');
  if (!['safe', 'standard', 'power'].includes(next.profile)) throw fail('POLICY_INVALID', 'profile 非法');
  if (next.control.channel !== 'private') throw fail('POLICY_INVALID', 'control.channel 只允许 private');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(policyPath(stateDir), JSON.stringify(next, null, 2));
  } catch (error) {
    throw fail('POLICY_INVALID', `策略写入失败：${error?.message ?? error}`);
  }
  return next;
}

// 9.3 红线：任务控制/写操作的确认仅限管理员私聊。管理员 = qq-bridge 白名单 owner 的 QQ 号（adminIds 单一来源）。
export function assertAdminControl(policy, actor) {
  const ids = policy?.control?.adminIds ?? [];
  if (!ids.length) throw fail('NOT_ADMIN', 'policy.json 的 adminIds 为空，所有任务控制被拒绝（fail-closed）。', '把 qq-bridge 白名单 owner 的 QQ 号填入 adminIds。');
  if (!actor || typeof actor !== 'object') throw fail('NOT_ADMIN', '缺少调用者身份，拒绝桌面任务控制。', '任务控制仅接受管理员私聊，需由入口层提供 actor。');
  if (actor.channel !== 'private') throw fail('NOT_ADMIN', '桌面任务控制仅限管理员私聊，群聊一律拒绝。');
  if (!ids.map(String).includes(String(actor.id))) throw fail('NOT_ADMIN', '非管理员发起的任务控制被拒绝。');
  return true;
}

// 写操作策略检查：enabled / apps fail-closed / 标题黑名单 / STOP 急停。
export function checkWriteAllowed(policy, stateDir, { title = '' } = {}) {
  if (!policy?.enabled) throw fail('COMPUTER_DISABLED', '电脑操控运行时未开启。', '在设置里开启电脑操控。');
  if (stopRequested(stateDir)) throw fail('COMPUTER_DISABLED', '急停 STOP 文件存在，所有写操作被拒绝。', '删除 STOP 文件后恢复。');
  if (!Array.isArray(policy.apps) || policy.apps.length === 0) throw fail('TARGET_NOT_ALLOWED', '策略 apps 白名单为空，所有写操作被拒绝（fail-closed）。', '在 policy.json 的 apps 中列出允许的应用。');
  const denied = (policy.titleDeny ?? []).find((word) => word && String(title).includes(word));
  if (denied) throw fail('TITLE_DENIED', `目标窗口命中危险标题关键词：${denied}`, '已拒绝并暂停，请人工确认该窗口。');
  return true;
}

// 网页写的目标白名单（§6.3 四道闸之「目标白名单」）：domains 为空 = 全部拒绝（fail-closed，与 apps 一致）。
// 条目按域名后缀匹配：'douyin.com' 同时放行 'www.douyin.com'。
export function checkBrowserDomainAllowed(policy, url) {
  const domains = policy?.domains ?? [];
  if (!Array.isArray(domains) || domains.length === 0) {
    throw fail('TARGET_NOT_ALLOWED', '策略 domains 白名单为空，网页写操作被拒绝（fail-closed）。', '在 policy.json 的 domains 中列出允许的网站域名（如 douyin.com）。');
  }
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch {
    throw fail('TARGET_NOT_ALLOWED', `无法解析目标域名：${String(url).slice(0, 100)}`, '网页写操作必须给出可解析的 http(s) 目标。');
  }
  const hit = domains.some((entry) => {
    const e = String(entry).toLowerCase().replace(/^\*?\./, '').replace(/^https?:\/\//, '').split('/')[0];
    return Boolean(e) && (host === e || host.endsWith(`.${e}`));
  });
  if (!hit) throw fail('TARGET_NOT_ALLOWED', `域名 ${host} 不在 domains 白名单内。`, '在 policy.json 的 domains 中登记允许的网站域名。');
  return true;
}

// 网页写闸门（B 方案）：enabled/STOP + 标题黑名单 + domains 目标白名单（apps 白名单是桌面专用，网页侧用 domains）。
export function checkBrowserWriteAllowed(policy, stateDir, { title = '', url = '' } = {}) {
  if (!policy?.enabled) throw fail('COMPUTER_DISABLED', '电脑操控运行时未开启。', '在设置里开启电脑操控。');
  if (stopRequested(stateDir)) throw fail('COMPUTER_DISABLED', '急停 STOP 文件存在，所有写操作被拒绝。', '删除 STOP 文件后恢复。');
  const denied = (policy.titleDeny ?? []).find((word) => word && String(title).includes(word));
  if (denied) throw fail('TITLE_DENIED', `目标页面命中危险标题关键词：${denied}`, '已拒绝并暂停，请人工确认该页面。');
  checkBrowserDomainAllowed(policy, url);
  return true;
}

// 连续 2 次基础设施失败熔断 30 分钟（§9.5，与抖音写链路同参）。
export class CircuitBreaker {
  constructor({ now = Date.now, threshold = 2, cooldownMs = 30 * 60_000 } = {}) {
    Object.assign(this, { now, threshold, cooldownMs, failures: 0, openUntil: 0 });
  }
  check() {
    if (this.openUntil > this.now()) throw fail('CIRCUIT_OPEN', '电脑操控基础设施连续失败，已熔断。', `请等待至 ${new Date(this.openUntil).toISOString()} 后半开重试。`);
  }
  recordSuccess() { this.failures = 0; this.openUntil = 0; }
  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold) { this.openUntil = this.now() + this.cooldownMs; this.failures = 0; }
  }
  state() { return { failures: this.failures, openUntil: this.openUntil, open: this.openUntil > this.now() }; }
}
