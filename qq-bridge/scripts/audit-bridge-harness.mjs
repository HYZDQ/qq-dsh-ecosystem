// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as roleCard from '../src/role-card.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as imageSearch from '../../qq-image/src/image-search.js';
import * as qzone from '../src/qzone.js';
import * as historyArchive from '../src/history-archive.js';
import * as ttsClient from '../src/tts-client.js';
// 三代仿真模块（GEN3）：bridge.js 顶层 import 在 VM 里会被剥离，必须在这里注入同名绑定。
import * as simulationTrace from '../src/simulation/trace.js';
import * as simulationRhythm from '../src/simulation/rhythm.js';
import * as simulationConfig from '../src/simulation/config.js';
import * as simulationAttention from '../src/simulation/attention.js';
import * as simulationStyle from '../src/simulation/style.js';
import * as simulationMemory from '../src/simulation/memory.js';
import * as simulationMnemon from '../src/simulation/memory-mnemon.js';
import * as simulationPromote from '../src/simulation/memory-promote.js';
import * as simulationPersona from '../src/simulation/persona.js';
import * as simulationAffect from '../src/simulation/affect.js';
import * as simulationProactive from '../src/simulation/proactive.js';
import * as simulationStickerScore from '../src/simulation/sticker-score.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, sendImageMessageV2, imageSearchService, imageDailyCounts, imageRecentSends, imageLastSentAt,
    handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    // GEN3 2.5 灰度与回滚：控制台端点背后的纯逻辑/热生效函数直接暴露给测试。
    simV3, simV3Cfg, simV3StatusSummary, mergeSimV3Input, applySimV3Config, saveSimV3Patch, simV3ConsoleFields,
    // GEN3 记忆闸门（测试用）：shadow/只读锁/名单空时必须为 false。
    simMemoryOn, simMemoryCanaryActive,
    // GEN3 预设选择（测试用）：canary 会话应走 qq-chat-v3，名单外仍走 qq-chat-v2。
    modePreset,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    collectors, setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
    get qzoneService() { return qzoneService; },
    get qzoneServiceError() { return qzoneServiceError; },
    qzoneContextProvider, qzoneDraftWithAgent,
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, pathToFileURL, URL, Buffer, AbortSignal, console: { log() {}, error() {} }, fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...presetPrompt,
    // 人格卡解析与「人格分裂」状态纯函数：bridge.js 顶层 import 在 VM 里被剥离，
    // 必须在这里注入同名绑定（selectRoleText / resolveRole / normalizeRoleState 等）。
    ...roleCard,
    // 图片检索模块（位于工作区同级 qq-image/）：桥接用 createImageSearchService /
    // normalizeImageSearchConfig / defaultImageFetchers。defaultImageFetchers 会在测试里通过
    // globals 覆盖成桩，保证测试不联网（见 qq-image/scripts/test-image-endpoints.mjs）。
    ...imageSearch,
    ...qzone,
    ...historyArchive,
    // 本地语音合成（TTS）：bridge 顶层 import 在 VM 里被剥离，这里注入真实实现。
    // 注意：normalizeTtsConfig / preprocessTtsText 是纯函数，测试可以直接断言；
    // createTtsClient 只有在真的合成时才发 HTTP —— 测试里 tts.enabled 默认 false，
    // 因此不会真的去连 WSL 的 sidecar。
    createTtsClient: ttsClient.createTtsClient,
    normalizeTtsConfig: ttsClient.normalizeTtsConfig,
    preprocessTtsText: ttsClient.preprocessTtsText,
    stripUnknownBracketTags: ttsClient.stripUnknownBracketTags,
    TTS_CODES: ttsClient.TTS_CODES,
    TtsError: ttsClient.TtsError,
    // 电脑操控事件桥（QQ 会话映射发布）：会写真实 home 目录下的文件，测试里必须无副作用。
    publishQqSessionMap: () => false,
    dropQqMessageEvent: () => false,
    // GEN3 仿真绑定：bridge 里 `sim*` 前缀是别名 import，这里必须显式改成 bridge 使用的名字。
    buildTurnRecord: simulationTrace.buildTurnRecord,
    createTraceWriter: simulationTrace.createTraceWriter,
    createTurnRecorder: simulationTrace.createTurnRecorder,
    sampleId: simulationTrace.sampleId,
    simHashId: simulationTrace.hashId,
    simComputeGapsV2: simulationRhythm.computeGapsV2,
    simPlanDelaysV3: simulationRhythm.planDelaysV3,
    simRandInt: simulationRhythm.randInt,
    normalizeSocialV3: simulationConfig.normalizeSocialV3,
    SOCIAL_V3_SCHEMA: simulationConfig.SOCIAL_V3_SCHEMA,
    fieldId: simulationConfig.fieldId,
    actionToSpeakSilent: simulationAttention.actionToSpeakSilent,
    decideAttention: simulationAttention.decideAttention,
    extractFeatures: simulationAttention.extractFeatures,
    inferAddressee: simulationAttention.inferAddressee,
    simDetectStyle: simulationStyle.detectStyle,
    simIsSensitiveTopic: simulationStyle.isSensitiveTopic,
    simRewriteLite: simulationStyle.rewriteLite,
    createMemoryStore: simulationMemory.createMemoryStore,
    formatMemoryLine: simulationMemory.formatMemoryLine,
    createMnemonBackend: simulationMnemon.createMnemonBackend,
    DEFAULT_MNEMON_LIMIT_BYTES: simulationMnemon.DEFAULT_MNEMON_LIMIT_BYTES,
    buildPromotion: simulationPromote.buildPromotion,
    parseSessionKey: simulationPromote.parseSessionKey,
    planPromotion: simulationPromote.planPromotion,
    simBuildAnchorText: simulationPersona.buildAnchorText,
    simShouldReanchor: simulationPersona.shouldReanchor,
    simExtractStyleStats: simulationPersona.extractStyleStats,
    simDetectDrift: simulationPersona.detectDrift,
    simClassifyEvent: simulationAffect.classifyEvent,
    simStepPad: simulationAffect.stepPad,
    simPadModulation: simulationAffect.padModulation,
    simResetPad: simulationAffect.resetPad,
    simQuietDecision: simulationProactive.quietDecision,
    simInterruptScore: simulationProactive.interruptScore,
    simBelowThreshold: simulationProactive.belowThreshold,
    simBudgetState: simulationProactive.budgetState,
    simCheckBudget: simulationProactive.checkBudget,
    simConsumeBudget: simulationProactive.consumeBudget,
    simNoteUnanswered: simulationProactive.noteUnanswered,
    simBackoffFactor: simulationProactive.backoffFactor,
    simExtractFollowUps: simulationProactive.extractFollowUps,
    simFollowUpDecision: simulationProactive.followUpDecision,
    simMarkFollowed: simulationProactive.markFollowed,
    simScoreSticker: simulationStickerScore.scoreSticker,
    simRankStickers: simulationStickerScore.rankStickers,
    simPickStickerOrNone: simulationStickerScore.pickStickerOrNone,
    simEmotionFromText: simulationStickerScore.emotionFromText,
    simEmotionFromPad: simulationStickerScore.emotionFromPad,
    simRecordStickerUse: simulationStickerScore.recordUse,
    simRecordStickerFeedback: simulationStickerScore.recordFeedback,
    simNormalizeStickerUsage: simulationStickerScore.normalizeUsage,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-v3']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    // Windows 上杀软/索引器会短暂占用刚写出的 state/bridge.lock、音频临时文件等，
    // rmSync 直接删会偶发 EBUSY（与被测逻辑无关，却会让 test:audit 变红）。
    // Node 的 rimraf 自带重试参数，正好用于这种瞬时占用。
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}
