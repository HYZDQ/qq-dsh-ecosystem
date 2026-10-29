import { interactionStatus } from './interaction-status.mjs';
import { SETTINGS_SECTIONS } from './settings-sections.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy, updatePolicy, stopFilePath, stopRequested } from './computer/policy.mjs';
import { AuditLog } from './computer/audit.mjs';
import { ScheduleStore } from './computer/tasks/schedules.mjs';

import { UsageLedger } from './usage-ledger.mjs';
import { WatchOptions } from './watch-options.mjs';
import { DiagnosticsService } from './diagnostics.mjs?v=14';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const PREFIX = '/api/douyin-browser';
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('只接收JSON设置。'), { status: 400 });
  let size = 0; const chunks = []; for await (const bytes of req) { size += bytes.length; chunks.push(bytes); if (size > 262_144) throw Object.assign(new Error('设置请求过长。'), { status: 413 }); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; } catch { throw Object.assign(new Error('设置必须是JSON对象。'), { status: 400 }); }
}
const empty = value => { if (Object.keys(value).length) throw Object.assign(new Error('此操作不接收参数。'), { status: 400 }); };
const active = state => Boolean(state?.running || state?.starting || state?.busy || state?.worker?.alive);

// 评论互动设置（2026-10-29）：与 dsh-douyin-agent 的 comment-duty 值班共用 comment-duty.json。
const COMMENT_DUTY_KEYS = new Set(['enabled', 'replyOwner', 'multiTurn', 'maxTurns', 'replyStranger', 'expertAsk', 'expertTimeoutMin', 'doubaoNick', 'ownerNick', 'intervalSec']);
function readCommentDuty(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'comment-duty.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('评论互动设置无法读取。'); }
}
function commentDutyState(stateDir) {
  const saved = readCommentDuty(stateDir);
  let activeThreads = 0, repliedToday = 0, pendingExpert = 0;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(stateDir, 'comment-threads.json'), 'utf8'));
    activeThreads = Object.values(t.threads || {}).filter(th => th?.status === 'active').length;
    pendingExpert = Object.values(t.expert || {}).filter(e => e && !e.answered).length;
    repliedToday = (t.repliedDay || {})[new Date().toISOString().slice(0, 10)] || 0;
  } catch { /* 没记录就是 0 */ }
  return {
    config: {
      enabled: saved.enabled !== false, replyOwner: saved.replyOwner !== false, multiTurn: saved.multiTurn !== false,
      maxTurns: saved.maxTurns ?? 5, replyStranger: saved.replyStranger === true, expertAsk: saved.expertAsk !== false,
      expertTimeoutMin: saved.expertTimeoutMin ?? 5, ownerNick: saved.ownerNick ?? '', doubaoNick: saved.doubaoNick || '豆包',
    },
    activeThreads, repliedToday, pendingExpert,
  };
}
function configureCommentDuty(stateDir, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('评论互动设置须为对象。');
  for (const key of Object.keys(patch)) if (!COMMENT_DUTY_KEYS.has(key)) throw new Error(`不支持的评论互动设置：${key}`);
  for (const key of ['enabled', 'replyOwner', 'multiTurn', 'replyStranger', 'expertAsk']) if (key in patch && typeof patch[key] !== 'boolean') throw new Error(`${key} 须为开关。`);
  if ('maxTurns' in patch && (!Number.isSafeInteger(patch.maxTurns) || patch.maxTurns < 1 || patch.maxTurns > 20)) throw new Error('多轮上限须为1至20的整数。');
  if ('expertTimeoutMin' in patch && (!Number.isSafeInteger(patch.expertTimeoutMin) || patch.expertTimeoutMin < 1 || patch.expertTimeoutMin > 30)) throw new Error('豆包超时须为1至30分钟。');
  for (const key of ['doubaoNick', 'ownerNick']) if (key in patch && (typeof patch[key] !== 'string' || patch[key].length > 40)) throw new Error(`${key} 须为不超过40字的昵称。`);
  const next = { ...readCommentDuty(stateDir), ...patch };
  const file = path.join(stateDir, 'comment-duty.json');
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return commentDutyState(stateDir);
}

// 复用 DSH 原生 WebServer 和设置页插槽，不启动独立软件或第二个端口。
export function createNativeSettingsRoute({ getController, getComments, getReport, getSpark, getWatch, getMode, getShare, getChat, getMedia, modelSettings, configureMode, startWatch, startSpark, startChat, watchSchedule, getDiagnostics } = {}) {
  const token = randomBytes(32).toString('hex');
  let diagnostics;
  return { kind: 'prefix', path: PREFIX, async handler(req, res) {
    try {
      const host = req.headers.host;
      if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return send(res, 403, { error: '设置页只接受本机来源。' });
      const origin = `${req.socket?.encrypted ? 'https' : 'http'}://${host}`, url = new URL(req.url, origin);
      if (url.origin !== origin || req.headers.origin && req.headers.origin !== origin || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: '拒绝跨来源设置请求。' });
      const controller = await getController();
      const stateDir = controller.limits().stateDir ?? resolveRuntimePaths().stateDir, usageLedger = new UsageLedger({ stateDir }), optionsService = new WatchOptions({ stateDir });
      const computerDir = path.join(stateDir, 'computer');
      const computerState = () => {
        const { policy, invalid } = loadPolicy(computerDir);
        return {
          enabled: policy.enabled === true, profile: policy.profile, apps: policy.apps,
          titleDeny: policy.titleDeny, allowShell: policy.allowShell, allowVisionFallback: policy.allowVisionFallback,
          control: policy.control, invalidPolicy: invalid === true, stop: stopRequested(computerDir),
          receipts: new AuditLog({ stateDir: computerDir }).recent(10),
          schedules: new ScheduleStore({ stateDir: computerDir }).state(),
        };
      };
      if (!url.pathname.startsWith(`${PREFIX}/diagnostics`)) for (const getter of [getSpark, getChat]) if (getter) { const service = await getter(); if (service.agent) { service.agent.usageLedger = usageLedger; service.agent.source = 'dsh'; } }
      if (req.method === 'GET' && url.pathname === `${PREFIX}/state`) {
        const [spark, comments, reports] = await Promise.all([getSpark(), getComments(), getReport()]);
        return send(res, 200, { token, schedule: watchSchedule?.state(), interactions: interactionStatus({chat:getChat?(await getChat()).state():{},spark:spark.state(),share:getShare?(await getShare()).state():{},comments:comments.state(),watch:(await getWatch()).state(),modelReady:modelSettings.state().configured}), sections: SETTINGS_SECTIONS, usage: usageLedger.state(), watchOptions: optionsService.state(), commentDuty: commentDutyState(stateDir), video: controller.limits().state(), spark: spark.state(), comments: comments.state(), reports: await reports.state(), persona: controller.getPersonaMemory().snapshot(), mode: (await getMode()).state(), model: typeof modelSettings.catalog === 'function' ? await modelSettings.catalog() : modelSettings.state(), watch: (await getWatch()).state(), ...(getShare ? { share: (await getShare()).state() } : {}), ...(getChat ? { chat: (await getChat()).state() } : {}), ...(getMedia ? { media: await (await getMedia()).status() } : {}), computer: computerState(), setup: { browser: 'Microsoft Edge', audioOptional: true, independentAppRequired: false, model: '使用 DSH 已配置提供商；可选音频 Key 单独保存。' } });
      }
      if (req.method !== 'POST') return send(res, 404, { error: '设置地址不存在。' });
      const supplied = req.headers['x-douyin-settings-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return send(res, 403, { error: '请刷新原生设置页后重试。' });
      const input = await body(req); let value;
      switch (url.pathname.slice(PREFIX.length)) {
        // 2026-10-27 界面精简：/diagnostics*、/reports/*、/media/* 功能已删除（含 UI 与工具面）。
        case '/watch/schedule': if(!watchSchedule) throw new Error('自动启动调度尚未加载。'); value=watchSchedule.configure(input,{explicit:true}); break;
        case '/watch/options': value = optionsService.configure(input, { explicit: true }); break; // 2026-10-29 修复：观看中也允许保存主题（下次启动生效），不再409
        case '/comment-duty/configure': value = configureCommentDuty(stateDir, input); break;
        case '/video/configure': value = controller.limits().savePolicy(input, { explicit: true }); break;
        case '/video/start': empty(input); if ((await getWatch()).state().running) throw Object.assign(new Error('请先停止自主观看，再开始新一轮。'), { status: 409 }); await controller.pauseForLimits?.(); value = controller.limits().markSession('dsh', { explicit: true }); break;
        case '/video/stop': empty(input); value = controller.limits().endSession({ explicit: true }); await controller.pauseForLimits?.(); break;
        case '/browser/open': empty(input); value = await controller.openBrowser(); break;
        case '/persona/configure': {
          if (Object.keys(input).some(key => !['content', 'expectedRevision'].includes(key))) throw Object.assign(new Error('人格设置只接收正文和读取版本。'), { status: 400 });
          if (active((await getWatch()).state()) || active((await getSpark()).state()) || getChat && active((await getChat()).state())) throw Object.assign(new Error('请先停止自主观看、自动问候和私信回复，再保存人格。'), { status: 409 });
          const persona = controller.getPersonaMemory();
          persona.saveManualText({ text: input.content, expectedRevision: input.expectedRevision }, { explicit: true });
          value = persona.initialize({ importLegacy: false }); break;
        }
        case '/model/configure': {
          const assertStopped = async () => {
            const spark = (await getSpark()).state(), chat = getChat ? (await getChat()).state() : null;
            if (active((await getWatch()).state()) || active(spark) || active(chat)) throw Object.assign(new Error('请先停止自主观看、自动问候和私信回复，再修改模型。'), { status: 409 });
          };
          await assertStopped();
          value = await modelSettings.configure(input, { explicit: true, beforeCommit: assertStopped }); break;
        }
        case '/mode/configure': value = await configureMode(input); break;
        case '/watch/start': {
          if (Object.keys(input).some(key => key !== 'maxRequests')) throw Object.assign(new Error('自主观看只接收本轮请求上限。'), { status: 400 });
          value = await startWatch(input); break;
        }
        case '/watch/stop': empty(input); value = await (await getWatch()).stop({ explicit: true }); break;
        case '/spark/configure': value = await (await getSpark()).configure(input, { explicit: true }); break;
        case '/spark/stop': empty(input); value = await (await getSpark()).stop({ explicit: true }); break;
        case '/spark/start': empty(input); value = await startSpark(); break;
        case '/spark/resolve': value = await (await getSpark()).resolve(input, { explicit: true }); break;
        case '/comments/configure': value = await (await getComments()).configure(input, { explicit: true }); break;
        case '/comments/resolve': value = await (await getComments()).resolve(input, { explicit: true }); break;
        case '/share/configure': value = await (await getShare()).configure(input, { explicit: true }); break;
        case '/share/resolve': value = await (await getShare()).resolve(input, { explicit: true }); break;
        case '/chat/contacts': empty(input); value = await (await getChat()).listContacts({ signal: AbortSignal.timeout(45_000) }); break;
        case '/chat/configure': {
          if (Object.keys(input).some(key => !['recipientIds', 'dailyReplyLimit'].includes(key))) throw Object.assign(new Error('私信设置只接收许可联系人和每日上限。'), { status: 400 });
          value = await (await getChat()).configure(input); break;
        }
        case '/chat/start': empty(input); value = await startChat(); break;
        case '/chat/stop': empty(input); value = await (await getChat()).stop(); break;
        case '/chat/resolve': if (Object.keys(input).length !== 1 || typeof input.recipientId !== 'string') throw Object.assign(new Error('只接受已核对的许可联系人。'), { status: 400 }); value = await (await getChat()).resumeContact(input.recipientId); break;
        case '/computer/configure': value = { ...updatePolicy(computerDir, input), ...computerState() }; break;
        case '/computer/stop': {
          empty(input);
          fs.mkdirSync(computerDir, { recursive: true });
          fs.writeFileSync(stopFilePath(computerDir), new Date().toISOString());
          value = computerState();
          break;
        }
        case '/computer/resume': {
          empty(input);
          fs.rmSync(stopFilePath(computerDir), { force: true });
          value = computerState();
          break;
        }
        case '/computer/receipts': {
          if (Object.keys(input).some((key) => key !== 'limit')) throw Object.assign(new Error('收据查询只接收 limit。'), { status: 400 });
          value = new AuditLog({ stateDir: computerDir }).recent(Number(input.limit) || 20);
          break;
        }
        case '/computer/schedules/configure': value = new ScheduleStore({ stateDir: computerDir }).configure(input); break;
        case '/computer/schedules/enable': {
          if (Object.keys(input).some((key) => key !== 'enabled') || typeof input.enabled !== 'boolean') throw Object.assign(new Error('调度开关只接收 enabled 布尔值。'), { status: 400 });
          value = new ScheduleStore({ stateDir: computerDir }).setEnabled(input.enabled);
          break;
        }
        case '/computer/schedules/remove': {
          if (Object.keys(input).some((key) => key !== 'id') || typeof input.id !== 'string') throw Object.assign(new Error('删除调度只接收 id。'), { status: 400 });
          value = new ScheduleStore({ stateDir: computerDir }).remove(input.id);
          break;
        }
        default: return send(res, 404, { error: '设置地址不存在。' });
      }
      return send(res, 200, value);
    } catch (error) { return send(res, error.code === 'PERSONA_REVISION_CONFLICT' ? 409 : Number.isInteger(error.status) ? error.status : error.code?.startsWith('PERSONA_') ? 400 : 500, { error: error.message || String(error) }); }
  } };
}
