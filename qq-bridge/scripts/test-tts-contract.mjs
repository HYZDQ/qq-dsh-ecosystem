// TTS 接入的"契约检查"：配置字段 / 工具闸门 / 端点 / 预设约束 / 控制台 / 文档。
//
// 这是"改了四处要同步"的机器可读版本 —— 少改一处就会在这里红，而不是等到线上发现
// 「配置写了但工具没注册」或「控制台按钮调了一个不存在的接口」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

console.log('## 1. 配置文件里的 tts 段（config.json + config.example.json）');
const TTS_FIELDS = ['enabled', 'baseUrl', 'timeoutMs', 'maxChars', 'outDir', 'mode', 'voiceDesign',
  'refAudio', 'refText', 'instruction', 'cfgScale', 'speed', 'keepDays', 'fallbackToText',
  'allowProactive', 'dailyLimit'];
for (const rel of ['config.json', 'config.example.json']) {
  let parsed = null;
  try {
    parsed = JSON.parse(read(rel).replace(/^\uFEFF/, ''));
  } catch (error) {
    ok(false, `${rel} 不是合法 JSON`, String(error?.message ?? error));
  }
  if (!parsed) continue;
  const tts = parsed.tts;
  ok(Boolean(tts && typeof tts === 'object'), `${rel} 有顶层 tts 段`);
  if (!tts) continue;
  for (const f of TTS_FIELDS) ok(Object.prototype.hasOwnProperty.call(tts, f), `${rel}.tts.${f}`);
  ok(tts.outDir.startsWith('audio/'), `${rel}.tts.outDir 在语音库内`, String(tts.outDir));
  // 模板必须默认关闭（新装部署不因为加了这段配置就静默打开语音）；
  // 真实 config.json 属于用户，允许他打开（打开后工具才注册）。
  if (rel === 'config.example.json') {
    ok(tts.enabled === false, '模板的 tts.enabled 默认 false（关闭时行为与现网一致）');
  }
}

console.log('## 2. 桥接侧：归一 / 端点 / 安全边界');
const bridge = read('src/bridge.js');
ok(bridge.includes("from './tts-client.js'"), 'bridge 引入 tts-client');
ok(bridge.includes('function ttsCfg()'), '有 ttsCfg() 单一归一点');
ok(bridge.includes("'/api/voice/tts/status'"), '操作者端点：TTS 状态');
ok(bridge.includes("'/api/voice/tts'"), '操作者端点：合成（支持 dryRun）');
ok(bridge.includes("'/api/socialV2/tts-say'"), 'AI 端点：合成并发送');
ok(bridge.includes('function ttsAvailable()'), '统一闸门 ttsAvailable()');
ok(bridge.includes('ttsDailyCheck') && bridge.includes('ttsDailyCommit'), '每日条数限额有检查与记账');
ok(bridge.includes('ttsCleanup') && bridge.includes('TTS_STATE_FILE'), '过期清理 + 计数持久化');
ok(bridge.includes('safeJoinLibrary(t.dir, out.relPath)'), '合成产物经 safeJoinLibrary 复核（不信任服务端路径）');
ok(bridge.includes('preprocessTtsText(') && bridge.includes('stripUnknownBracketTags('), '合成前做朗读文本清洗');
// 克隆音色：参考音频与名字登记表、跨命名空间只传文件名、上传体单独放宽
ok(bridge.includes("from './tts-voices.js'"), 'bridge 引入 tts-voices（音色登记表）');
ok(bridge.includes("'/api/voice/tts/voices'"), '桥接端点：音色库增删查');
ok(bridge.includes('readBody(8 * 1024 * 1024)'), '音色上传单独放宽请求体上限');
ok(bridge.includes('payload.refName'), '跨进程只传文件名（refName），不传 Windows 绝对路径');
ok(bridge.includes("'/api/voice/tts/default-voice'"), '桥接端点：保存私聊/群聊默认音色');
ok(bridge.includes("'/api/voice/tts/settings'"), '桥接端点：保存音色贴合度 cfgScale');
ok(bridge.includes('sessionKey'), 'ttsSynthesize 按会话 key 区分私聊/群聊音色');
for (const rel of ['config.json', 'config.example.json']) {
  const cfg = JSON.parse(read(rel).replace(/^\uFEFF/, ''));
  ok(typeof cfg.tts?.voice === 'string', `${rel} 有 tts.voice（默认克隆音色，空=文字描述）`);
  ok(typeof cfg.tts?.voicePrivate === 'string' && typeof cfg.tts?.voiceGroup === 'string',
    `${rel} 有 tts.voicePrivate / tts.voiceGroup（空=跟随通用默认）`);
  const voice = cfg.socialV2?.voice ?? {};
  ok(voice.allowAbsolutePath !== true, `${rel} 没有打开 allowAbsolutePath（合成产物靠"落进语音库"通过校验）`);
}

console.log('## 3. MCP 工具注册闸门');
const mcp = read('src/mcp-snowluma-safe.js');
ok(mcp.includes("'qq_tts_say'"), '注册了 qq_tts_say');
ok(mcp.includes('cfg.tts?.enabled === true'), '闸门包含 tts.enabled');
ok(mcp.includes("cfg.socialV2?.voice?.enabled !== false"), '闸门包含 voice.enabled');
ok(mcp.includes("cfg.socialV2?.tools?.sendVoice !== false"), '闸门包含 tools.sendVoice');
ok(mcp.includes("'/api/socialV2/tts-say'"), 'MCP 走桥接端点（不直连 sidecar）');

console.log('## 4. 预设提示词（v2 / v3 各一条，措辞不得漂移）');
for (const rel of ['plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml',
  'plugins/qq-agent-presets/presets/qq-chat-v3.patch.yml']) {
  const yml = read(rel);
  ok(yml.includes('qq_tts_say'), `${path.basename(rel)} 提到 qq_tts_say`);
  ok(yml.includes('一次唤醒最多 1 条'), `${path.basename(rel)} 有「一次唤醒最多 1 条」`);
  ok(yml.includes('失败就直接改用文字回复'), `${path.basename(rel)} 有失败回退约束`);
}

console.log('## 5. 控制台（/public/console.html）');
const html = read('public/console.html');
for (const id of ['ttsStateLabel', 'ttsHealthLabel', 'ttsTodayLabel', 'ttsText',
  'ttsSpeed', 'ttsTarget', 'ttsVoiceDesign', 'ttsPreviewBtn', 'ttsSayBtn', 'ttsMsg',
  'ttsVoice', 'ttsVoiceName', 'ttsVoiceRefText', 'ttsVoiceFile', 'ttsVoiceUploadBtn', 'ttsVoiceList',
  'ttsCfgScale', 'ttsCfgScaleValue']) {
  ok(html.includes(`id="${id}"`), `控制台元素 ${id}`);
}
// 控制台只开放 design 模式：clone/direction 需要参考音频上传入口，面板没有，别再把这几个控件加回来。
ok(!html.includes('id="ttsMode"'), '控制台不再有音色模式下拉（只走 design）');
ok(!html.includes('id="ttsInstruction"'), '控制台不再有语气指令输入（direction 模式才用）');
ok(html.includes('voiceFileCount'), '控制台语音库文件数与 TTS 状态在同一行');
ok(html.includes("api('/api/voice/tts/status')"), '控制台调状态端点');
ok(html.includes("api('/api/voice/tts'"), '控制台调合成端点');
ok(html.includes('loadTtsStatus'), '进入语音页时刷新状态');

console.log('## 6. sidecar 与文档');
ok(exists('tts-sidecar/sidecar.py'), 'sidecar 脚本在仓库内（部署到 WSL）');
const sidecar = read('tts-sidecar/sidecar.py');
ok(sidecar.includes('def import_ref('), 'sidecar 支持参考音频导入（ffmpeg 转 24k 单声道）');
ok(sidecar.includes('_resolve_ref_by_name'), 'sidecar 按名字解析参考音频（跨命名空间）');
ok(sidecar.includes('/refs'), 'sidecar 暴露 POST /refs');
ok(exists('src/tts-voices.js'), '音色登记表模块在仓库内');
ok(exists('docs/guides/TTS.md'), '部署指南 docs/guides/TTS.md');
ok(read('docs/guides/TTS.md').includes('音色库（克隆音色）'), 'TTS.md 写了克隆音色的用法');
ok(exists('docs/design/VOICE_TTS_INTEGRATION_PLAN.md'), '设计文档仍在');
{
  const side = read('tts-sidecar/sidecar.py');
  ok(side.includes('127.0.0.1'), 'sidecar 默认只监听回环');
  ok(side.includes('os.replace'), '原子落盘（os.replace）');
  ok(side.includes('self.lock.acquire'), '串行队列（独占推理资源）');
  ok(side.includes('commonpath'), 'outDir / refs 路径越界校验');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
