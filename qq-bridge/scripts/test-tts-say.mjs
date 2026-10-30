// 「合成并发送」链路的安全性测试：用一个**假 sidecar**（本地 HTTP）跑通客户端 ↔ 服务端契约，
// 重点验证三件事：
//   1) 正常合成返回 relPath，且路径必须落在语音库内（否则拒绝）；
//   2) 服务端返回越界路径（../ 或绝对路径）时，桥接侧 safeJoinLibrary 必须拒绝；
//   3) 文本过长/引擎报错不会被吞掉，错误码原样透出（便于模型回退文本）。
//
// 不真的合成音频、不连 WSL：这里测的是"信任边界"，真合成在 docs/guides/TTS.md 的验收步骤里。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTtsClient, normalizeTtsConfig, TTS_CODES, preprocessTtsText } from '../src/tts-client.js';
import { safeJoinLibrary } from '../src/voice-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

// 假 sidecar：按请求体回放预设响应；每次请求都记录，便于断言"桥接没有偷偷重试"。
let calls = 0;
let mode = 'ok';
let lastBody = null;
const server = http.createServer((req, res) => {
  const send = (status, payload) => {
    const data = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(data);
  };
  if (req.method === 'GET' && req.url === '/health') {
    calls += 1;
    return send(200, { ok: true, engine: 'audio.cpp', model: 'breeze', ready: mode !== 'down' });
  }
  if (req.method === 'POST' && req.url === '/tts') {
    calls += 1;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { lastBody = JSON.parse(raw); } catch { lastBody = null; }
      if (mode === 'too_long') return send(400, { ok: false, code: 'tts_text_too_long', error: '太长' });
      if (mode === 'engine_error') return send(502, { ok: false, code: 'tts_engine_error', error: '引擎炸了' });
      if (mode === 'traversal') {
        // 恶意/出错的 sidecar：返回库外路径
        return send(200, { ok: true, path: 'C:/Windows/system32/x.wav', relPath: '../../Windows/x.wav', bytes: 1024, durationSec: 1, elapsedMs: 10 });
      }
      return send(200, { ok: true, path: '/mnt/d/x.wav', relPath: 'tts/20261030/abc.wav', bytes: 1024, durationSec: 2, elapsedMs: 1234, cached: false });
    });
    return;
  }
  send(404, { ok: false, error: 'not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// 临时语音库 + 临时产物目录，避免测试污染真实 audio/
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-test-'));
const voiceDir = path.join(tmpRoot, 'audio');
fs.mkdirSync(path.join(voiceDir, 'tts', '20261030'), { recursive: true });
fs.writeFileSync(path.join(voiceDir, 'tts', '20261030', 'abc.wav'), 'RIFF');
const warningCfg = normalizeTtsConfig({ outDir: 'audio/tts' }, { root: tmpRoot, voiceDir });

console.log('## 1. 正常合成：relPath 落在库内');
{
  const client = createTtsClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
  const out = await client.synthesize({ text: '晚安', mode: 'design', outDir: 'tts', voiceDesign: '温柔女声' });
  ok(out.relPath === 'tts/20261030/abc.wav', 'relPath 原样返回', out.relPath);
  const abs = safeJoinLibrary(voiceDir, out.relPath);
  ok(abs === fs.realpathSync(path.join(voiceDir, 'tts', '20261030', 'abc.wav')), 'safeJoinLibrary 解析到库内文件');
  ok(lastBody?.text === '晚安' && lastBody?.outDir === 'tts', '请求体带 text/outDir', JSON.stringify(lastBody));
}

console.log('## 2. 服务端返回库外路径 → 必须拒绝（不信任 sidecar）');
{
  mode = 'traversal';
  const client = createTtsClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
  const out = await client.synthesize({ text: '晚安' });
  const abs = safeJoinLibrary(voiceDir, out.relPath);
  ok(abs === null, 'safeJoinLibrary 拒绝 ../ 上跳路径', String(abs));
  ok(safeJoinLibrary(voiceDir, 'C:/Windows/x.wav') === null, '绝对路径同样被拒');
}

console.log('## 3. 文本过长 / 引擎错误：错误码原样透出，且**不重试**');
{
  mode = 'too_long';
  const before = calls;
  const client = createTtsClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
  let thrown = null;
  try { await client.synthesize({ text: '很长很长' }); } catch (error) { thrown = error; }
  ok(thrown?.code === TTS_CODES.TEXT_TOO_LONG, 'tts_text_too_long 透出', thrown?.code);
  ok(calls - before === 1, '只请求一次（失败不重试）', String(calls - before));

  mode = 'engine_error';
  const before2 = calls;
  thrown = null;
  try { await client.synthesize({ text: '很长很长' }); } catch (error) { thrown = error; }
  ok(thrown?.code === TTS_CODES.ENGINE_ERROR, 'tts_engine_error 透出', thrown?.code);
  ok(calls - before2 === 1, '引擎错误也不重试', String(calls - before2));
}

console.log('## 4. 预处理后的文本才发给 sidecar（不念 Markdown/链接）');
{
  mode = 'ok';
  const client = createTtsClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
  const raw = '**晚安！** [笑](https://x.y) 早点睡 😴';
  const clean = preprocessTtsText(raw, { maxChars: 120 });
  const out = await client.synthesize({ text: clean });
  ok(lastBody?.text === clean, 'sidecar 收到的是清洗后的文本', lastBody?.text);
  ok(out.ok === true, '返回 ok=true');
  ok(lastBody?.text.includes('[笑]'), 'Vocal Event 仍保留', lastBody?.text);
}

console.log('## 5. 配置越界只降级、不抛（ttsCfg 才不会把桥接带崩）');
ok(warningCfg.outDir === path.join(voiceDir, 'tts'), 'outDir 落在库内', warningCfg.outDir);
ok(warningCfg.outDirRel === 'tts', 'outDirRel=tts', warningCfg.outDirRel);

server.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
