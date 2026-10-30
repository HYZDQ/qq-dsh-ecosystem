// TTS 客户端纯函数测试：配置归一 / 路径反向校验 / 朗读文本清洗 / 错误码分类。
//
// 全部离线：不起 sidecar、不发网络请求（HTTP 部分用注入的 fetch 桩）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TTS_CODES,
  TtsError,
  createTtsClient,
  isLoopbackUrl,
  normalizeTtsConfig,
  preprocessTtsText,
  stripUnknownBracketTags
} from '../src/tts-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 1. baseUrl 必须回环（本地合成不出网）');
ok(isLoopbackUrl('http://127.0.0.1:18100'), '127.0.0.1 合法');
ok(isLoopbackUrl('http://localhost:18100/'), 'localhost 合法');
ok(!isLoopbackUrl('http://192.168.1.9:18100'), '局域网地址被拒');
ok(!isLoopbackUrl('https://api.xi-ai.cn/tts'), '云端地址被拒');
{
  const c = normalizeTtsConfig({ enabled: true, baseUrl: 'http://10.0.0.5:18100' }, { root: ROOT, voiceDir: path.join(ROOT, 'audio') });
  ok(c.baseUrl === 'http://127.0.0.1:18100', '非回环 baseUrl 回退默认值');
  ok(c.warnings.some((w) => w.includes('回环')), '并产生告警（有告警才看得见）');
}

console.log('## 2. outDir 必须落在语音库内（写错不会开门）');
{
  const voiceDir = path.join(ROOT, 'audio');
  const okCfg = normalizeTtsConfig({ outDir: 'audio/tts' }, { root: ROOT, voiceDir });
  ok(okCfg.outDir === path.join(voiceDir, 'tts'), '默认 audio/tts 落在库内');
  ok(okCfg.outDirRel === 'tts', 'relPath 为 tts');

  const bad = normalizeTtsConfig({ outDir: 'C:/Windows/Temp/tts' }, { root: ROOT, voiceDir });
  ok(bad.outDir === path.join(voiceDir, 'tts'), '库外路径降级为 <库>/tts');
  ok(bad.warnings.some((w) => w.includes('不在语音库内')), '降级会告警');

  const up = normalizeTtsConfig({ outDir: 'audio/../..' }, { root: ROOT, voiceDir });
  ok(up.outDir === path.join(voiceDir, 'tts'), '上跳目录同样被降级');
}

console.log('## 3. 数值钳制（写错配置不炸链路）');
{
  const c = normalizeTtsConfig(
    { maxChars: 9999, timeoutMs: 1, cfgScale: 99, speed: 5, keepDays: -1, dailyLimit: -5 },
    { root: ROOT, voiceDir: path.join(ROOT, 'audio') }
  );
  ok(c.maxChars === 400, 'maxChars 上限 400', String(c.maxChars));
  ok(c.timeoutMs === 3000, 'timeoutMs 下限 3000', String(c.timeoutMs));
  ok(c.cfgScale === 10, 'cfgScale 上限 10', String(c.cfgScale));
  ok(c.speed === 2, 'speed 上限 2', String(c.speed));
  ok(c.keepDays === 0, 'keepDays 负数归 0', String(c.keepDays));
  ok(c.dailyLimit === 0, 'dailyLimit 负数归 0', String(c.dailyLimit));
}

console.log('## 4. 音色模式与必填项');
{
  const c = normalizeTtsConfig({ mode: 'weird' }, { root: ROOT, voiceDir: path.join(ROOT, 'audio') });
  ok(c.mode === 'design', '未知 mode 回退 design');
  const clone = normalizeTtsConfig({ mode: 'clone' }, { root: ROOT, voiceDir: path.join(ROOT, 'audio') });
  ok(clone.warnings.some((w) => w.includes('refAudio')), 'clone 缺 refAudio 告警');
  ok(clone.warnings.some((w) => w.includes('refText')), 'clone 缺 refText 告警');
}

console.log('## 5. 朗读文本预处理（§8.5）');
{
  const r = preprocessTtsText('**晚安** `代码` [链接](https://a.b) https://x.y/z 😴 @小明 [笑]', { maxChars: 200 });
  ok(!r.includes('**') && !r.includes('#'), '去掉 Markdown 标记', r);
  ok(!r.includes('https://'), '去掉链接', r);
  ok(!r.includes('@'), '去掉 @ 提及', r);
  ok(!/😴/.test(r), '去掉 emoji', r);
  ok(r.includes('[笑]'), '保留 [笑] 这类发音指令', r);
}
{
  const long = '第一句。第二句。第三句。第四句。第五句。';
  const cut = preprocessTtsText(long, { maxChars: 9 });
  ok(cut === '第一句。第二句。', '优先在句号处截断', JSON.stringify(cut));
}
ok(preprocessTtsText('1234 和 iPhone 15', { maxChars: 50 }) === '1234 和 iPhone 15', '数字与英文缩写不被改写');
ok(stripUnknownBracketTags('[旁白]你好[笑]') === '你好[笑]', '未知方括号被清理、Vocal Event 保留');

console.log('## 6. HTTP 客户端：超时 / 不可达 / 服务端错误码');
{
  const client = createTtsClient({
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 500,
    fetchImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }); }
  });
  const health = await client.health();
  ok(health.ok === false && health.ready === false, '/health 连不上返回 ready=false（不抛）');
  let thrown = null;
  try { await client.synthesize({ text: '测试' }); } catch (error) { thrown = error; }
  ok(thrown instanceof TtsError, 'synthesize 抛 TtsError');
  ok(thrown.code === TTS_CODES.UNAVAILABLE, '连接失败 → tts_unavailable', thrown?.code);
}
{
  const client = createTtsClient({
    baseUrl: 'http://127.0.0.1:18100',
    timeoutMs: 500,
    fetchImpl: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }); }
  });
  let thrown = null;
  try { await client.synthesize({ text: '测试' }); } catch (error) { thrown = error; }
  ok(thrown?.code === TTS_CODES.TIMEOUT, '超时 → tts_timeout', thrown?.code);
}
{
  const client = createTtsClient({
    baseUrl: 'http://127.0.0.1:18100',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, code: 'tts_text_too_long', error: '太长' }) })
  });
  let thrown = null;
  try { await client.synthesize({ text: '测试' }); } catch (error) { thrown = error; }
  ok(thrown?.code === TTS_CODES.TEXT_TOO_LONG, '服务端错误码原样透出', thrown?.code);
}
{
  const client = createTtsClient({
    baseUrl: 'http://127.0.0.1:18100',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, path: '/tmp/x.wav', relPath: 'tts/20261030/abc.wav', bytes: 1024, durationSec: 2.5, elapsedMs: 3000 })
    })
  });
  const out = await client.synthesize({ text: '测试' });
  ok(out.relPath === 'tts/20261030/abc.wav', '合成结果带 relPath（桥接据此再校验库内路径');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
