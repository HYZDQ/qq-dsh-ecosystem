// src/image-search.js 的离线单测。
//
// 约束：
// - 完全不联网：所有 provider 抓取 / 图片下载 / 联网搜索都用注入桩；
// - 不写 state/、不读仓库 config.json（只读临时目录里的假 config.json）；
// - 覆盖：provider 解析 fixture、合并去重、查询清洗、URL/SSRF/端口/凭据校验、
//   magic bytes 与尺寸、Content-Type 白名单、previewBytes/maxBytes/maxPixels、
//   maxPerMessage 截断、sha256 去重、总字节截断、TTL（可注入 now）、配置收敛、
//   enabled=false、空 query、白名单无关。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createImageSearchService,
  defaultImageFetchers,
  imageSizeFromBuffer,
  inspectImageBytes,
  isAcceptableImageContentType,
  loadImageSearchConfig,
  mergeCandidates,
  mimeTypeFromBuffer,
  normalizeImageSearchConfig,
  parseBaiduImageJson,
  parseBingImageHtml,
  parseOgImageHtml,
  sanitizeImageQuery,
  validateImageUrl,
  validatePageUrl
} from '../src/image-search.js';

let passed = 0;
let failures = 0;

async function test(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(error?.stack ?? error);
  }
}

async function expectCode(run, code, label) {
  try {
    await (typeof run === 'function' ? run() : run);
  } catch (error) {
    assert.equal(error?.code, code, `${label}：期望 code=${code}，实际 ${error?.code}（${error?.message}）`);
    return error;
  }
  assert.fail(`${label}：应当抛错 code=${code}`);
}

// ── 图片字节 fixture（最小合法序列） ────────────────────────────────────
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex'
);
const GIF_FULL = Buffer.from(
  '47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b',
  'hex'
);
const GIF_HEADER = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([1, 0, 1, 0])]);
const JPEG_SMALL = (() => {
  const buf = Buffer.alloc(40);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  buf.writeUInt16BE(16, 4); // APP0，下一段从 20 开始
  buf[20] = 0xff; buf[21] = 0xc0; // SOF0
  buf.writeUInt16BE(17, 22);
  buf[24] = 8; // precision
  buf.writeUInt16BE(2, 25); // height
  buf.writeUInt16BE(3, 27); // width
  buf[34] = 0xff; buf[35] = 0xd9; // EOI
  return buf;
})();
const WEBP_VP8X = (() => {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[24] = 0x7f; buf[25] = 0x07; buf[26] = 0x00; // 1920
  buf[27] = 0x37; buf[28] = 0x04; buf[29] = 0x00; // 1080
  return buf;
})();
const WEBP_VP8L = (() => {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(8, 16);
  buf[20] = 0x2f;
  buf[21] = 0; buf[22] = 0; buf[23] = 0; buf[24] = 0; // 1x1
  return buf;
})();
const WEBP_VP8 = (() => {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(1, 28);
  return buf;
})();
const HTML_BYTES = Buffer.from('<html><body>not an image</body></html>', 'utf8');
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8');

function makePng(width = 1, height = 1, totalBytes = 0) {
  const header = Buffer.from(PNG_1X1.subarray(0, 24));
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  if (!totalBytes) return header;
  return Buffer.concat([header, Buffer.alloc(Math.max(0, totalBytes - header.length))]);
}

function makeJpeg(width = 16, height = 12, totalBytes = 0) {
  const buf = Buffer.alloc(Math.max(40, totalBytes));
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  buf.writeUInt16BE(16, 4); // APP0，下一段从 20 开始
  buf[20] = 0xff; buf[21] = 0xc0; // SOF0
  buf.writeUInt16BE(17, 22);
  buf[24] = 8;
  buf.writeUInt16BE(height, 25);
  buf.writeUInt16BE(width, 27);
  buf[34] = 0xff; buf[35] = 0xd9;
  return buf;
}

function makeGif(width = 16, height = 12, totalBytes = 0) {
  const buf = Buffer.alloc(Math.max(16, totalBytes));
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

// 「通过占位图下限」的合法 fixture：≥2048 字节且宽高 ≥8（task-3 起 preview/prepareSend 的下限）。
const VALID_PNG = makePng(8, 8, 4096);
const VALID_JPEG = makeJpeg(16, 12, 4096);
const VALID_GIF = makeGif(16, 12, 4096);

// ── provider fixture ────────────────────────────────────────────────────
const BAIDU_DATA = {
  data: [
    {
      thumbURL: 'https://thumb.example.com/1.jpg',
      middleURL: 'https://mid.example.com/1.jpg',
      replaceUrl: [{ ObjURL: 'https://img.example.com/1.jpg' }],
      fromPageTitleEnc: '猫咪 &lt;b&gt;图&lt;/b&gt; &amp; 好图',
      fromURL: 'https://page.example.com/1',
      fromURLHost: 'page.example.com:8080',
      width: 800,
      height: 600,
      byteSize: 12345
    },
    {
      thumbURL: 'https://thumb.example.com/2.jpg',
      middleURL: 'http://mid.example.com/2.jpg',
      replaceUrl: [{ ObjURL: 'http://img.example.com/2.jpg' }],
      fromPageTitleEnc: '第二张',
      fromURL: 'https://page.example.com/2',
      width: 640,
      height: 480
    },
    {
      thumbURL: 'https://thumb.example.com/3.jpg',
      fromURLHost: 'page3.example.com',
      width: '300',
      height: '200'
    },
    {
      thumbURL: 'https://thumb.example.com/4.jpg',
      objURL: 'ENCRYPTED_OBJ_URL_HASH',
      replaceUrl: [{ ObjURL: 'http://img.example.com/4.jpg' }]
    },
    { thumbURL: 'http://thumb.example.com/5.jpg', replaceUrl: [{ ObjURL: 'http://img.example.com/5.jpg' }] }
  ]
};
const BAIDU_JSON = JSON.stringify(BAIDU_DATA);

const BING_HTML = `<html><body>
<a class="iusc" m="{&quot;murl&quot;:&quot;https://img.example.com/b1.jpg&quot;,&quot;turl&quot;:&quot;https://thumb.example.com/b1.jpg&quot;,&quot;purl&quot;:&quot;https://page.example.com/b1&quot;,&quot;t&quot;:&quot;必应 &amp; 一&quot;,&quot;mid&quot;:&quot;M1&quot;}"><img alt="alt1"></a>
<a class="iusc" m="{&quot;murl&quot;:&quot;http://img.example.com/b2.jpg&quot;,&quot;turl&quot;:&quot;https://thumb.example.com/b2.jpg&quot;,&quot;t&quot;:&quot;坏的&quot;}"><img alt="alt2"></a>
<a class="iusc" m="{&quot;murl&quot;:&quot;https://img.example.com/b3.jpg&quot;,&quot;turl&quot;:&quot;https://thumb.example.com/b3.jpg&quot;}"><img alt="alt 三"></a>
<a m="not-json"></a>
</body></html>`;

const OG_PAGE = 'https://page.example.com/articles/1';
const OG_HTML = `<html><head>
<title>页面标题兜底</title>
<meta property="og:image" content="/img/og.png">
<meta name="twitter:image" content="https://cdn.example.com/tw.jpg">
<meta property="og:title" content="OG 标题 &amp; 描述 &lt;b&gt;尾&lt;/b&gt;">
</head><body>
<img src="https://img.example.com/i1.jpg" alt="i1">
<img src="//img.example.com/i2.jpg">
<img src="http://img.example.com/i3.jpg">
<img src="data:image/png;base64,AAAA">
</body></html>`;

// ── 抓取桩 ──────────────────────────────────────────────────────────────
/**
 * Baidu 反爬桩：`https://image.baidu.com/` 返回 Set-Cookie；acjson 返回 JSON。
 * `baiduResponses` 可按调用次数依次返回不同 body（用于 antiFlag 重试测试）。
 */
function makeFetchText({
  baidu = BAIDU_JSON,
  baiduResponses,
  bing = BING_HTML,
  pages = new Map(),
  fail = {},
  delayMs = 0,
  setCookie = ['BAIDUID=fixture-cookie; Path=/', 'BDUSS=fixture-token; Path=/'],
  homeBody = '<html><head><title>百度图片</title></head><body></body></html>'
} = {}) {
  const calls = [];
  let baiduIndex = 0;
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (url === 'https://image.baidu.com/') {
      if (fail.baiduHome) throw new Error(fail.baiduHome);
      return {
        statusCode: 200,
        body: homeBody,
        contentType: 'text/html; charset=utf-8',
        headers: setCookie ? { 'set-cookie': setCookie } : {}
      };
    }
    if (url.startsWith('https://image.baidu.com/search/acjson')) {
      if (fail.baidu) throw new Error(fail.baidu);
      let body = baidu;
      if (Array.isArray(baiduResponses)) {
        body = baiduResponses[Math.min(baiduIndex, baiduResponses.length - 1)];
        baiduIndex += 1;
      }
      return { statusCode: 200, body, contentType: 'application/json' };
    }
    if (url.startsWith('https://cn.bing.com/images/async')) {
      if (fail.bing) throw new Error(fail.bing);
      return { statusCode: 200, body: bing, contentType: 'text/html' };
    }
    if (pages.has(url)) return { statusCode: 200, body: pages.get(url), contentType: 'text/html' };
    if (fail.page) throw new Error(fail.page);
    throw new Error(`未预期的 fetchText：${url}`);
  };
  fn.calls = calls;
  return fn;
}

function makeFetchBuffer(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function pngHandler(url) {
  if (url === 'https://img.example.com/1.jpg') return { buffer: VALID_PNG, contentType: 'image/png' };
  return { buffer: VALID_PNG, contentType: 'image/png' };
}

function makeService({ overrides = {}, fetchText, fetchBuffer, searchWeb, now, log } = {}) {
  const config = { ...normalizeImageSearchConfig(undefined).config, ...overrides };
  const service = createImageSearchService({
    getConfig: () => config,
    fetchText: fetchText ?? (async () => { throw new Error('fetchText 未注入'); }),
    fetchBuffer: fetchBuffer ?? (async () => { throw new Error('fetchBuffer 未注入'); }),
    searchWeb: searchWeb ?? (async () => []),
    ...(now ? { now } : {}),
    ...(log ? { log } : {})
  });
  return { service, config };
}

/** 先跑一次搜索拿到候选缓存；默认 providers=['baidu'] 便于按 id 测 prepareSend。 */
async function searchFixture({ overrides = {}, originalImages = new Map(), now, log } = {}) {
  const fetchText = makeFetchText();
  const fetchBuffer = makeFetchBuffer((url) => {
    if (originalImages.has(url)) return originalImages.get(url);
    return { buffer: VALID_PNG, contentType: 'image/png' };
  });
  const { service, config } = makeService({
    overrides: { providers: ['baidu'], ...overrides },
    fetchText,
    fetchBuffer,
    now,
    log
  });
  const result = await service.search({ query: '猫咪', count: config.maxCandidates });
  return { service, config, result, fetchText, fetchBuffer };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. 配置收敛
// ═══════════════════════════════════════════════════════════════════════
await test('normalizeImageSearchConfig：undefined 全默认、零 warning', () => {
  const { config, warnings } = normalizeImageSearchConfig(undefined);
  assert.deepEqual(config, {
    enabled: true,
    providers: ['baidu', 'bing'],
    maxCandidates: 8,
    previewBytes: 262144,
    maxPerMessage: 3,
    maxBytes: 8388608,
    maxPixels: 64000000,
    maxTotalBytesPerMessage: 20971520,
    safeMode: false,
    defaultAsSticker: false,
    dailyLimit: 0,
    cooldownMs: 0,
    cacheTtlMinutes: 10,
    dedupeWindowMinutes: 30,
    requestTimeoutMs: 10000,
    userAgent: 'qq-bridge-image/0.2.0'
  });
  assert.deepEqual(warnings, []);
});

await test('normalizeImageSearchConfig：合法自定义值原样保留', () => {
  const raw = {
    enabled: false,
    providers: ['webpage-og', 'baidu', 'webpage-og'],
    maxCandidates: 20,
    previewBytes: 1048576,
    maxPerMessage: 5,
    maxBytes: 20971520,
    maxPixels: 1000000,
    maxTotalBytesPerMessage: 41943040,
    safeMode: true,
    defaultAsSticker: true,
    dailyLimit: 1000,
    cooldownMs: 3600000,
    cacheTtlMinutes: 120,
    dedupeWindowMinutes: 1440,
    requestTimeoutMs: 30000,
    userAgent: 'custom-ua/1.0'
  };
  const { config, warnings } = normalizeImageSearchConfig(raw);
  assert.deepEqual(warnings, []);
  assert.deepEqual(config, { ...raw, providers: ['webpage-og', 'baidu'] });
});

await test('normalizeImageSearchConfig：越界/错误类型回落默认值 + 中文 warning', () => {
  const { config, warnings } = normalizeImageSearchConfig({
    enabled: 'yes',
    providers: ['baidu', 'nope', 7, 'baidu', 'bing'],
    maxCandidates: 999,
    previewBytes: 'big',
    maxPerMessage: 0,
    maxBytes: -1,
    maxPixels: 10,
    maxTotalBytesPerMessage: 1,
    safeMode: 'yes',
    dailyLimit: -5,
    cooldownMs: 3600001,
    cacheTtlMinutes: 0,
    dedupeWindowMinutes: 1441,
    requestTimeoutMs: 'fast',
    userAgent: 'x'.repeat(201)
  });
  const defaults = normalizeImageSearchConfig(undefined).config;
  assert.deepEqual(config, { ...defaults, providers: ['baidu', 'bing'] });
  assert.ok(warnings.length >= 12, `warnings 数量应足够多，实际 ${warnings.length}`);
  assert.ok(warnings.every((line) => typeof line === 'string' && line.includes('imageSearch')));
  assert.ok(warnings.every((line) => !line.includes('config.json') && !line.includes('\\\\')));
  assert.ok(warnings.some((line) => line.includes('maxCandidates')));
  assert.ok(warnings.some((line) => line.includes('userAgent')));
  assert.ok(warnings.some((line) => line.includes('providers[1]')));
});

await test('normalizeImageSearchConfig：raw 非对象按 {} 处理且不抛错', () => {
  for (const raw of ['oops', [], 42, true]) {
    const { config, warnings } = normalizeImageSearchConfig(raw);
    assert.deepEqual(config, normalizeImageSearchConfig(undefined).config);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('imageSearch'));
  }
});

await test('normalizeImageSearchConfig：providers 去重保序、空则默认', () => {
  assert.deepEqual(normalizeImageSearchConfig({ providers: ['BING', 'baidu', 'bing'] }).config.providers, ['bing', 'baidu']);
  assert.deepEqual(normalizeImageSearchConfig({ providers: [] }).config.providers, ['baidu', 'bing']);
  assert.deepEqual(normalizeImageSearchConfig({ providers: ['nope', 3] }).config.providers, ['baidu', 'bing']);
});

await test('loadImageSearchConfig：读临时目录 config.json；缺失时全默认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-image-search-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ imageSearch: { maxCandidates: 5, providers: ['bing'] } }), 'utf8');
    const loaded = loadImageSearchConfig(dir);
    assert.equal(loaded.config.maxCandidates, 5);
    assert.deepEqual(loaded.config.providers, ['bing']);
    assert.deepEqual(loaded.warnings, []);

    const missing = loadImageSearchConfig(path.join(dir, 'not-exist'));
    assert.deepEqual(missing.config, normalizeImageSearchConfig(undefined).config);
    assert.deepEqual(missing.warnings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. 查询清洗
// ═══════════════════════════════════════════════════════════════════════
await test('sanitizeImageQuery：CQ 码/控制字符/空白折叠/截断/非字符串', () => {
  assert.equal(sanitizeImageQuery('  猫咪  [CQ:image,file=abc]  图  '), '猫咪 图');
  assert.equal(sanitizeImageQuery('a\u0000\u0007b\nc\td'), 'a b c d');
  assert.equal(sanitizeImageQuery('[CQ:at,qq=1]'), '');
  assert.equal(sanitizeImageQuery(undefined), '');
  assert.equal(sanitizeImageQuery(12345), '12345');
  assert.equal(Array.from(sanitizeImageQuery('啊'.repeat(130))).length, 120);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. URL 校验
// ═══════════════════════════════════════════════════════════════════════
await test('validateImageUrl：合法 https / 显式 443 / 自定义端口', () => {
  assert.equal(validateImageUrl('https://images.example.com/a.png'), 'https://images.example.com/a.png');
  assert.equal(validateImageUrl('https://images.example.com:443/a.png'), 'https://images.example.com/a.png');
  assert.equal(
    validateImageUrl('https://images.example.com:8443/a.png', { allowedPorts: ['8443'] }),
    'https://images.example.com:8443/a.png'
  );
  assert.equal(validateImageUrl(' https://images.example.com/a.png '), 'https://images.example.com/a.png');
});

await test('validateImageUrl：非 https / 凭据 / 非 443 端口 / 非法参数全部拒绝', async () => {
  const cases = [
    'http://images.example.com/a.png',
    'ftp://images.example.com/a.png',
    'https://user:pass@images.example.com/a.png',
    'https://images.example.com:8443/a.png',
    '',
    '   ',
    '/relative/a.png',
    'nonsense',
    null,
    42
  ];
  for (const raw of cases) {
    await expectCode(() => validateImageUrl(raw), 'INVALID_URL', `拒绝 ${String(raw)}`);
  }
});

await test('validateImageUrl：SSRF（localhost / .local / 私有 IP / 元数据 IP）拒绝', async () => {
  const cases = [
    'https://localhost/a.png',
    'https://app.localhost/a.png',
    'https://printer.local/a.png',
    'https://127.0.0.1/a.png',
    'https://10.0.0.5/a.png',
    'https://192.168.1.1/a.png',
    'https://172.16.0.1/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/a.png',
    'https://[fd00::1]/a.png',
    'https://0.0.0.0/a.png'
  ];
  for (const url of cases) {
    await expectCode(() => validateImageUrl(url), 'INVALID_URL', `SSRF 拒绝 ${url}`);
  }
  // 公网 IP 字面量允许
  assert.equal(validateImageUrl('https://93.184.216.34/a.png'), 'https://93.184.216.34/a.png');
});

await test('validateImageUrl：不做 QQ 白名单过滤（本模块与白名单无关）', () => {
  const url = 'https://totally-unknown-host.example.org/pic.png';
  assert.equal(validateImageUrl(url), url);
});

await test('validatePageUrl：宽松 https、无凭据、长度 ≤2048', () => {
  assert.equal(validatePageUrl('https://page.example.com/a?x=1'), 'https://page.example.com/a?x=1');
  assert.equal(validatePageUrl('https://page.example.com:8443/a'), 'https://page.example.com:8443/a');
  assert.equal(validatePageUrl('http://page.example.com/a'), '');
  assert.equal(validatePageUrl('https://user:pass@page.example.com/a'), '');
  assert.equal(validatePageUrl('javascript:alert(1)'), '');
  assert.equal(validatePageUrl('/relative'), '');
  assert.equal(validatePageUrl(''), '');
  assert.equal(validatePageUrl(`https://page.example.com/${'a'.repeat(2048)}`), '');
  assert.equal(validatePageUrl(undefined), '');
});

// ═══════════════════════════════════════════════════════════════════════
// 4. 图片字节解析
// ═══════════════════════════════════════════════════════════════════════
await test('mimeTypeFromBuffer：PNG/JPEG/GIF/WebP 与未知内容', () => {
  assert.equal(mimeTypeFromBuffer(PNG_1X1), 'image/png');
  assert.equal(mimeTypeFromBuffer(JPEG_SMALL), 'image/jpeg');
  assert.equal(mimeTypeFromBuffer(GIF_FULL), 'image/gif');
  assert.equal(mimeTypeFromBuffer(GIF_HEADER), 'image/gif');
  assert.equal(mimeTypeFromBuffer(WEBP_VP8X), 'image/webp');
  assert.equal(mimeTypeFromBuffer(WEBP_VP8L), 'image/webp');
  assert.equal(mimeTypeFromBuffer(HTML_BYTES), '');
  assert.equal(mimeTypeFromBuffer(SVG_BYTES), '');
  assert.equal(mimeTypeFromBuffer(Buffer.alloc(0)), '');
  assert.equal(mimeTypeFromBuffer(null), '');
});

await test('imageSizeFromBuffer：PNG/GIF/JPEG 与 WebP 三种容器', () => {
  assert.deepEqual(imageSizeFromBuffer(PNG_1X1), { width: 1, height: 1 });
  assert.deepEqual(imageSizeFromBuffer(GIF_FULL), { width: 1, height: 1 });
  assert.deepEqual(imageSizeFromBuffer(GIF_HEADER), { width: 1, height: 1 });
  assert.deepEqual(imageSizeFromBuffer(JPEG_SMALL), { width: 3, height: 2 });
  assert.deepEqual(imageSizeFromBuffer(WEBP_VP8X), { width: 1920, height: 1080 });
  assert.deepEqual(imageSizeFromBuffer(WEBP_VP8L), { width: 1, height: 1 });
  assert.deepEqual(imageSizeFromBuffer(WEBP_VP8), { width: 1, height: 1 });
  assert.equal(imageSizeFromBuffer(HTML_BYTES), null);
  assert.equal(imageSizeFromBuffer(Buffer.alloc(4)), null);
});

await test('inspectImageBytes：合法图片返回完整元数据；HTML/SVG 抛 NOT_IMAGE', async () => {
  const info = inspectImageBytes(PNG_1X1);
  assert.equal(info.ok, true);
  assert.equal(info.mimeType, 'image/png');
  assert.equal(info.ext, 'png');
  assert.equal(info.width, 1);
  assert.equal(info.height, 1);
  assert.equal(info.bytes, PNG_1X1.length);
  assert.match(info.sha256, /^[0-9a-f]{64}$/);

  const jpeg = inspectImageBytes(JPEG_SMALL);
  assert.equal(jpeg.mimeType, 'image/jpeg');
  assert.equal(jpeg.ext, 'jpg');
  assert.equal(inspectImageBytes(GIF_FULL).ext, 'gif');
  assert.equal(inspectImageBytes(WEBP_VP8X).ext, 'webp');

  await expectCode(() => inspectImageBytes(HTML_BYTES), 'NOT_IMAGE', 'HTML 拒绝');
  await expectCode(() => inspectImageBytes(SVG_BYTES), 'NOT_IMAGE', 'SVG 拒绝');
  await expectCode(() => inspectImageBytes(null), 'NOT_IMAGE', 'null 拒绝');
});

await test('isAcceptableImageContentType：空放行、四种图片放行、其余拒绝', () => {
  for (const ct of [undefined, null, '', '   ']) assert.equal(isAcceptableImageContentType(ct), true);
  for (const ct of ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'IMAGE/JPEG; charset=binary']) {
    assert.equal(isAcceptableImageContentType(ct), true, ct);
  }
  for (const ct of ['image/svg+xml', 'text/html', 'text/plain', 'application/json', 'application/octet-stream', 'image/avif']) {
    assert.equal(isAcceptableImageContentType(ct), false, ct);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 5. provider 纯解析器（fixture）
// ═══════════════════════════════════════════════════════════════════════
await test('parseBaiduImageJson：字段兼容 / https 优先 / 标题清洗 / 来源去端口', () => {
  const list = parseBaiduImageJson(BAIDU_JSON);
  assert.equal(list.length, 4, 'http-only 候选应被丢弃');
  const first = list[0];
  assert.equal(first.provider, 'baidu');
  assert.equal(first.imageUrl, 'https://img.example.com/1.jpg', 'replaceUrl.ObjURL 优先');
  assert.equal(first.thumbUrl, 'https://thumb.example.com/1.jpg');
  assert.equal(first.pageUrl, 'https://page.example.com/1');
  assert.equal(first.title, '猫咪 图 & 好图', 'HTML 实体与标签应清除');
  assert.equal(first.source, 'page.example.com', 'source 只保留 hostname（去端口）');
  assert.equal(first.width, 800);
  assert.equal(first.height, 600);
  assert.equal(first.bytes, 12345);

  assert.equal(list[1].imageUrl, 'https://thumb.example.com/2.jpg', 'http 的 replace/middle 丢弃后回退 thumbURL');
  assert.equal(list[2].imageUrl, 'https://thumb.example.com/3.jpg');
  assert.equal(list[2].width, 300);
  assert.equal(list[2].height, 200);
  assert.equal(list[2].source, 'page3.example.com');
  assert.equal(list[3].imageUrl, 'https://thumb.example.com/4.jpg', '加密 objURL 不可当 imageUrl');
  assert.notEqual(list[3].imageUrl, 'ENCRYPTED_OBJ_URL_HASH');
  assert.ok(String(list.note).includes('非 https'));

  assert.equal(parseBaiduImageJson(BAIDU_JSON, { limit: 2 }).length, 2);
});

await test('parseBaiduImageJson：JSON 损坏不崩溃（返回 []）', () => {
  assert.deepEqual(parseBaiduImageJson('not json at all'), []);
  assert.deepEqual(parseBaiduImageJson('{broken'), []);
  assert.deepEqual(parseBaiduImageJson(''), []);
  assert.deepEqual(parseBaiduImageJson(undefined), []);
  // JSONP 包裹也能解析
  const wrapped = `cb(${BAIDU_JSON});`;
  assert.equal(parseBaiduImageJson(wrapped).length, 4);
});

await test('parseBingImageHtml：实体反转义 / t 字段 / alt 兜底 / http 丢弃', () => {
  const list = parseBingImageHtml(BING_HTML);
  assert.equal(list.length, 2);
  assert.equal(list[0].provider, 'bing');
  assert.equal(list[0].imageUrl, 'https://img.example.com/b1.jpg');
  assert.equal(list[0].thumbUrl, 'https://thumb.example.com/b1.jpg');
  assert.equal(list[0].pageUrl, 'https://page.example.com/b1');
  assert.equal(list[0].title, '必应 & 一');
  assert.equal(list[0].source, 'page.example.com');
  assert.equal(list[1].imageUrl, 'https://img.example.com/b3.jpg');
  assert.equal(list[1].title, 'alt 三', 't 为空时用相邻 img alt');
  assert.ok(String(list.note).includes('非 https'));
  assert.equal(parseBingImageHtml(BING_HTML, { limit: 1 }).length, 1);
});

await test('parseOgImageHtml：og/twitter/img、相对 URL 解析、只保留 https、标题清洗', () => {
  const list = parseOgImageHtml(OG_HTML, OG_PAGE);
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((item) => item.imageUrl), [
    'https://page.example.com/img/og.png',
    'https://cdn.example.com/tw.jpg',
    'https://img.example.com/i1.jpg',
    'https://img.example.com/i2.jpg'
  ]);
  assert.ok(list.every((item) => item.provider === 'webpage-og'));
  assert.ok(list.every((item) => item.pageUrl === OG_PAGE));
  assert.ok(list.every((item) => item.source === 'page.example.com'));
  assert.equal(list[0].title, 'OG 标题 & 描述 尾');
  assert.ok(String(list.note).includes('非 https'));

  // <img src> 最多取前 10 个
  const many = Array.from({ length: 12 }, (_, index) => `<img src="https://img.example.com/n${index}.jpg">`).join('');
  assert.equal(parseOgImageHtml(many, OG_PAGE).length, 10);
  // 无 pageUrl 时相对地址无法解析，绝对 https 仍可用
  const noBase = parseOgImageHtml('<img src="/rel.png"><img src="https://img.example.com/abs.png">', '');
  assert.deepEqual(noBase.map((item) => item.imageUrl), ['https://img.example.com/abs.png']);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. 合并去重
// ═══════════════════════════════════════════════════════════════════════
await test('mergeCandidates：顺序保持、imageUrl/thumb/page+尺寸逐级去重、candidateId=1..N', () => {
  const merged = mergeCandidates([
    [
      { imageUrl: 'https://IMG.example.com/a.jpg', title: 'A', provider: 'baidu' },
      { imageUrl: 'https://img.example.com/a.jpg#frag', title: 'A-dup', provider: 'bing' }
    ],
    [
      { imageUrl: 'https://img.example.com/b.jpg', title: 'B', provider: 'bing' },
      { imageUrl: '', thumbUrl: 'https://thumb.example.com/t.jpg', title: 'T1' },
      { imageUrl: '', thumbUrl: 'https://thumb.example.com/t.jpg', title: 'T2' },
      { pageUrl: 'https://page.example.com/p', width: 10, height: 20 },
      { pageUrl: 'https://page.example.com/p', width: 10, height: 20 },
      { pageUrl: 'https://page.example.com/p', width: 30, height: 40 }
    ]
  ], { limit: 10 });
  assert.deepEqual(merged.map((item) => item.title), ['A', 'B', 'T1', '', '']);
  assert.deepEqual(merged.map((item) => item.candidateId), [1, 2, 3, 4, 5]);
  assert.ok(merged.every((item) => Number.isInteger(item.candidateId)));
  assert.equal(merged[0].provider, 'baidu');
  assert.equal(merged[1].provider, 'bing');
  assert.equal(merged[3].width, 10);
  assert.equal(merged[4].width, 30);
});

await test('mergeCandidates：limit 截断与空列表', () => {
  const lists = [[{ imageUrl: 'https://i/1.jpg' }, { imageUrl: 'https://i/2.jpg' }], [{ imageUrl: 'https://i/3.jpg' }]];
  assert.equal(mergeCandidates(lists, { limit: 2 }).length, 2);
  assert.deepEqual(mergeCandidates([], { limit: 5 }), []);
  assert.deepEqual(mergeCandidates(null, { limit: 5 }), []);
  assert.deepEqual(mergeCandidates([[{ title: '无 URL' }], [null, 3]], { limit: 5 }), []);
});

// ═══════════════════════════════════════════════════════════════════════
// 7. 默认抓取器（安全选项在联网前就生效）
// ═══════════════════════════════════════════════════════════════════════
await test('defaultImageFetchers：导出三件套，http / 非标准端口在联网前即拒绝', async () => {
  assert.equal(typeof defaultImageFetchers.fetchText, 'function');
  assert.equal(typeof defaultImageFetchers.fetchBuffer, 'function');
  assert.equal(typeof defaultImageFetchers.searchWeb, 'function');
  await assert.rejects(() => defaultImageFetchers.fetchText('http://example.com/x'), /https/);
  await assert.rejects(() => defaultImageFetchers.fetchBuffer('http://example.com/x.png'), /https/);
  await assert.rejects(() => defaultImageFetchers.fetchBuffer('https://example.com:8443/x.png'), /端口/);
});

// ═══════════════════════════════════════════════════════════════════════
// 8. 搜索服务（全部注入桩）
// ═══════════════════════════════════════════════════════════════════════
await test('service.search：基础链路（query 清洗 / provider 顺序 / 预览 / 缓存）', async () => {
  const fetchText = makeFetchText();
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const logs = [];
  const { service } = makeService({ fetchText, fetchBuffer, log: (line) => logs.push(line) });
  const result = await service.search({ query: '  猫咪 [CQ:image,file=x]  图 ', count: 3 });

  assert.equal(typeof result.searchId, 'string');
  assert.equal(result.searchId.length, 36);
  assert.deepEqual(result.candidates.map((item) => item.candidateId), [1, 2, 3]);
  assert.deepEqual(result.providers, [
    { id: 'baidu', ok: true, count: 4 },
    { id: 'bing', ok: true, count: 2 }
  ]);
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.every((item) => item.preview === 'ok'));
  assert.equal(result.candidates[0].title, '猫咪 图 & 好图');
  assert.equal(result.candidates[0].source, 'page.example.com');
  assert.equal(result.candidates[0].pageUrl, 'https://page.example.com/1');
  assert.equal(result.candidates[0].width, 800);
  assert.equal(result.candidates[0].bytes, VALID_PNG.length);
  assert.equal(result.previews.length, 3);
  for (const preview of result.previews) {
    assert.ok(Number.isInteger(preview.candidateId));
    assert.equal(preview.mimeType, 'image/png');
    assert.ok(typeof preview.dataBase64 === 'string' && preview.dataBase64.length > 0);
    assert.ok(!preview.dataBase64.startsWith('data:'));
  }

  // Baidu 反爬：先打首页拿 Set-Cookie，再带 cookie 打 acjson
  const homeCall = fetchText.calls.find((call) => call.url === 'https://image.baidu.com/');
  assert.ok(homeCall, '应先 GET Baidu 首页取 cookie');
  assert.equal(homeCall.options.headers.referer, 'https://image.baidu.com/');
  const baiduCall = fetchText.calls.find((call) => call.url.includes('/search/acjson'));
  assert.ok(baiduCall, '应请求 Baidu acjson');
  assert.equal(new URL(baiduCall.url).searchParams.get('word'), '猫咪 图');
  assert.equal(baiduCall.options.headers.referer, `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent('猫咪 图')}`);
  assert.equal(baiduCall.options.headers.cookie, 'BAIDUID=fixture-cookie; BDUSS=fixture-token');
  assert.equal(baiduCall.options.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(baiduCall.options.headers.accept, 'text/plain, */*; q=0.01');
  assert.equal(baiduCall.options.maxChars, 512000);
  assert.equal(baiduCall.options.timeoutMs, 10000);
  const bingCall = fetchText.calls.find((call) => call.url.includes('cn.bing.com/images/async'));
  assert.ok(bingCall.options.headers.referer.startsWith('https://cn.bing.com/images/search?q='));
  assert.equal(new URL(bingCall.url).searchParams.get('q'), '猫咪 图');

  const previewCall = fetchBuffer.calls[0];
  assert.equal(previewCall.options.maxBytes, 262144);
  assert.equal(previewCall.options.requireHttps, true);
  assert.deepEqual(previewCall.options.allowedPorts, ['443']);
  assert.equal(previewCall.options.timeoutMs, 10000);

  const cached = await service.getSearch(result.searchId);
  assert.equal(cached.searchId, result.searchId);
  assert.equal(cached.candidates.length, 3);
  assert.equal(cached.expiresAt - cached.createdAt, 10 * 60000);
  assert.equal(service.size(), 1);

  // 日志只含 searchId/provider/计数，不含查询词
  assert.ok(logs.length >= 2);
  assert.ok(logs.every((line) => !line.includes('猫咪')));
});

await test('service.search：providers 顺序来自配置且按序调用', async () => {
  const fetchText = makeFetchText();
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({ overrides: { providers: ['bing', 'baidu'] }, fetchText, fetchBuffer });
  const result = await service.search({ query: '猫咪', count: 3 });
  assert.deepEqual(result.providers.map((item) => item.id), ['bing', 'baidu']);
  assert.deepEqual(result.candidates.map((item) => item.title), ['必应 & 一', 'alt 三', '猫咪 图 & 好图']);
  const callOrder = fetchText.calls
    .filter((call) => call.url.includes('/search/acjson') || call.url.includes('cn.bing.com/images/async'))
    .map((call) => (call.url.includes('/search/acjson') ? 'baidu' : 'bing'));
  assert.deepEqual(callOrder, ['bing', 'baidu']);
});

await test('service.search：provider 抛错不致命，providers 记录 error 并继续下一个', async () => {
  const fetchText = makeFetchText({ fail: { baidu: '百度接口模拟失败' } });
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({ fetchText, fetchBuffer });
  const result = await service.search({ query: '猫咪', count: 5 });
  assert.equal(result.providers[0].id, 'baidu');
  assert.equal(result.providers[0].ok, false);
  assert.equal(result.providers[0].count, 0);
  assert.ok(result.providers[0].error.length <= 200);
  assert.ok(result.providers[0].error.includes('百度接口模拟失败'));
  assert.equal(result.providers[1].ok, true);
  assert.equal(result.candidates.length, 2, '仍继续使用 bing 的候选');
  assert.deepEqual(result.candidates.map((item) => item.candidateId), [1, 2]);
});

await test('service.search：0 结果返回 candidates:[] + note', async () => {
  const fetchText = makeFetchText({ baidu: '{"data":[]}', bing: '<html></html>' });
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({ fetchText, fetchBuffer });
  const result = await service.search({ query: '猫咪' });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.previews, []);
  // 0 条不是异常；Baidu 空结果的 provider note 会带进 note（task-3 起）
  assert.ok(result.note.startsWith('没有搜到可用的图片'), result.note);
  assert.equal(service.size(), 1, '空结果也写缓存，getSearch 可用');
  const cached = await service.getSearch(result.searchId);
  assert.deepEqual(cached.candidates, []);
});

await test('service.search：enabled=false → DISABLED；空 query → INVALID_ARGUMENT', async () => {
  const { service } = makeService({ overrides: { enabled: false }, fetchText: makeFetchText(), fetchBuffer: makeFetchBuffer(pngHandler) });
  await expectCode(() => service.search({ query: '猫咪' }), 'DISABLED', 'enabled=false');

  const { service: enabledService } = makeService({ fetchText: makeFetchText(), fetchBuffer: makeFetchBuffer(pngHandler) });
  await expectCode(() => enabledService.search({ query: '   ' }), 'INVALID_ARGUMENT', '空 query');
  await expectCode(() => enabledService.search({}), 'INVALID_ARGUMENT', 'undefined query');
  await expectCode(() => enabledService.search({ query: '[CQ:at,qq=1]' }), 'INVALID_ARGUMENT', 'CQ-only query');
});

await test('service.search：count 收敛到 [1, maxCandidates]', async () => {
  const data = { data: Array.from({ length: 20 }, (_, index) => ({ thumbURL: `https://thumb.example.com/m${index}.jpg`, middleURL: `https://img.example.com/m${index}.jpg` })) };
  const fetchText = makeFetchText({ baidu: JSON.stringify(data) });
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({ overrides: { providers: ['baidu'] }, fetchText, fetchBuffer });
  assert.equal((await service.search({ query: '猫咪', count: 999 })).candidates.length, 8, 'count 上限 = maxCandidates');
  assert.equal((await service.search({ query: '猫咪', count: 0 })).candidates.length, 1, 'count 下限 = 1');
  assert.equal((await service.search({ query: '猫咪' })).candidates.length, 8, 'count 缺省 = maxCandidates');

  const { service: small } = makeService({ overrides: { providers: ['baidu'], maxCandidates: 3 }, fetchText, fetchBuffer });
  const result = await small.search({ query: '猫咪', count: 100 });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.providers[0].count, 20, 'provider count 是合并前的数量');
});

await test('service.search：预览失败（类型/魔力字节/异常/超 previewBytes）不致命', async () => {
  const bigPreview = makePng(8, 8, 262145);
  const fetchBuffer = makeFetchBuffer((url) => {
    if (url.includes('/1.jpg') || url.endsWith('/1.jpg')) return { buffer: VALID_PNG, contentType: 'text/html' };
    if (url.includes('/2.jpg')) return { buffer: HTML_BYTES, contentType: 'image/png' };
    if (url.includes('/3.jpg')) throw new Error('下载失败模拟');
    return { buffer: bigPreview, contentType: 'image/png' };
  });
  const { service } = makeService({ overrides: { providers: ['baidu'] }, fetchText: makeFetchText(), fetchBuffer });
  const result = await service.search({ query: '猫咪', count: 4 });
  assert.deepEqual(result.candidates.map((item) => item.preview), ['failed', 'failed', 'failed', 'failed']);
  assert.deepEqual(result.previews, []);
  assert.equal(result.candidates[0].bytes, 12345, '预览失败时用 provider 元数据 bytes');
  assert.equal(result.candidates[1].bytes, 0, '没有元数据时用 0');
});

await test('service.search：缩略图下载并发 ≤3', async () => {
  let active = 0;
  let maxActive = 0;
  const fetchBuffer = makeFetchBuffer(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { buffer: VALID_PNG, contentType: 'image/png' };
  });
  const data = { data: Array.from({ length: 8 }, (_, index) => ({ thumbURL: `https://thumb.example.com/c${index}.jpg` })) };
  const { service } = makeService({ overrides: { providers: ['baidu'] }, fetchText: makeFetchText({ baidu: JSON.stringify(data) }), fetchBuffer });
  const result = await service.search({ query: '猫咪', count: 8 });
  assert.equal(result.candidates.length, 8);
  assert.equal(maxActive, 3, `缩略图并发应为 3，实际 ${maxActive}`);
});

await test('service.search：webpage-og 走 searchWeb + 页面抓取（最多 4 页、并发 ≤2）', async () => {
  const pages = new Map();
  const pageUrls = ['a', 'b', 'c', 'd'].map((id) => `https://page.example.com/${id}`);
  for (const page of pageUrls) pages.set(page, OG_HTML);
  let active = 0;
  let maxActive = 0;
  const fetchText = makeFetchText({ pages, delayMs: 2 });
  const originalFetchText = fetchText;
  const wrappedFetchText = async (url, options) => {
    if (url.startsWith('https://page.example.com/')) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
    }
    return originalFetchText(url, options);
  };
  const searchCalls = [];
  const searchWeb = async (query, options) => {
    searchCalls.push({ query, options });
    return [
      { title: 'a', url: pageUrls[0] },
      { title: 'a2', url: pageUrls[1] },
      { title: 'bad-http', url: 'http://page.example.com/x' },
      { title: 'bad-js', url: 'javascript:alert(1)' },
      { title: 'c', url: pageUrls[2] },
      { title: 'd', url: pageUrls[3] },
      { title: 'e', url: 'https://page.example.com/e' }
    ];
  };
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({ overrides: { providers: ['webpage-og'] }, fetchText: wrappedFetchText, fetchBuffer, searchWeb });
  const result = await service.search({ query: '猫咪' });

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].query, '猫咪');
  assert.equal(searchCalls[0].options.maxResults, 6);
  assert.equal(result.providers[0].id, 'webpage-og');
  assert.equal(result.providers[0].ok, true);
  // 4 个页面 × 同一套图片 URL，合并去重后只剩 4 个
  assert.equal(result.candidates.length, 4);
  assert.deepEqual(result.candidates.map((item) => item.title), ['OG 标题 & 描述 尾', 'OG 标题 & 描述 尾', 'OG 标题 & 描述 尾', 'OG 标题 & 描述 尾']);
  assert.equal(result.candidates[0].pageUrl, pageUrls[0]);
  assert.ok(maxActive <= 2, `og 页面并发应 ≤2，实际 ${maxActive}`);
  const pageTextCalls = fetchText.calls.filter((call) => call.url.startsWith('https://page.example.com/'));
  assert.equal(pageTextCalls.length, 4, '最多抓 4 个页面');
});

await test('service.search：og 单页失败被忽略；searchWeb 抛错记为 provider error', async () => {
  const pages = new Map([['https://page.example.com/a', OG_HTML]]);
  const fetchText = makeFetchText({ pages, fail: { page: '页面抓取失败' } });
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({
    overrides: { providers: ['webpage-og'] },
    fetchText,
    fetchBuffer,
    searchWeb: async () => [{ url: 'https://page.example.com/a' }, { url: 'https://page.example.com/b' }]
  });
  const partial = await service.search({ query: '猫咪' });
  assert.equal(partial.providers[0].ok, true);
  assert.equal(partial.candidates.length, 4, '可用页面仍产出候选');

  const { service: broken } = makeService({
    overrides: { providers: ['webpage-og'] },
    fetchText,
    fetchBuffer,
    searchWeb: async () => { throw new Error('搜索后端不可用'); }
  });
  const failedResult = await broken.search({ query: '猫咪' });
  assert.equal(failedResult.providers[0].ok, false);
  assert.ok(failedResult.providers[0].error.includes('搜索后端不可用'));
  assert.deepEqual(failedResult.candidates, []);
  assert.equal(failedResult.note, '没有搜到可用的图片');
});

// ═══════════════════════════════════════════════════════════════════════
// 9. prepareSend
// ═══════════════════════════════════════════════════════════════════════
const ORIGINAL_URLS = {
  1: 'https://img.example.com/1.jpg',
  2: 'https://thumb.example.com/2.jpg',
  3: 'https://thumb.example.com/3.jpg',
  4: 'https://thumb.example.com/4.jpg'
};

await test('prepareSend：成功路径（Content-Type / 尺寸 / sha256 / 下载参数）', async () => {
  const originalImages = new Map([
    [ORIGINAL_URLS[1], { buffer: VALID_PNG, contentType: 'image/png' }],
    [ORIGINAL_URLS[2], { buffer: VALID_JPEG, contentType: 'image/jpeg' }]
  ]);
  const { service, result, config, fetchBuffer } = await searchFixture({ originalImages });
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [1, 2] });
  assert.equal(send.selected.length, 2);
  assert.deepEqual(send.failed, []);
  assert.deepEqual(send.duplicates, []);
  assert.equal(send.truncated, false);
  assert.equal(send.note, undefined);

  const [first, second] = send.selected;
  assert.equal(first.candidateId, 1);
  assert.equal(first.mimeType, 'image/png');
  assert.equal(first.ext, 'png');
  assert.equal(first.width, 8);
  assert.equal(first.height, 8);
  assert.equal(first.bytes, VALID_PNG.length);
  assert.ok(Buffer.isBuffer(first.buffer));
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.source, 'page.example.com');
  assert.equal(first.pageUrl, 'https://page.example.com/1');
  assert.equal(first.provider, 'baidu');
  assert.equal(second.mimeType, 'image/jpeg');
  assert.equal(second.ext, 'jpg');
  assert.equal(second.width, 16);
  assert.equal(second.height, 12);

  const originalCall = fetchBuffer.calls.find((call) => call.url === ORIGINAL_URLS[1]);
  assert.equal(originalCall.options.maxBytes, config.maxBytes);
  assert.equal(originalCall.options.timeoutMs, config.requestTimeoutMs);
  assert.equal(originalCall.options.requireHttps, true);
  assert.deepEqual(originalCall.options.allowedPorts, ['443']);
});

await test('prepareSend(asSticker)：优先缩略图，并强制 QQ 表情规格（≤512KB / ≤1024px）', async () => {
  const { service, result, fetchBuffer } = await searchFixture();
  fetchBuffer.calls.length = 0; // 忽略检索阶段下载预览产生的调用
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [1], asSticker: true });
  assert.deepEqual(send.failed, []);
  assert.equal(send.selected.length, 1);
  const sticker = send.selected[0];
  assert.equal(sticker.sticker, true);
  assert.equal(sticker.candidateId, 1);
  assert.equal(sticker.bytes, VALID_PNG.length);
  // 表情模式必须先试 thumbUrl（候选 1 的 imageUrl 是 img.example.com，thumb 是 thumb.example.com）
  assert.equal(fetchBuffer.calls.length, 1);
  assert.equal(fetchBuffer.calls[0].url, 'https://thumb.example.com/1.jpg');
  assert.equal(fetchBuffer.calls[0].options.maxBytes, 512 * 1024);
  assert.equal(fetchBuffer.calls[0].options.requireHttps, true);
  assert.deepEqual(fetchBuffer.calls[0].options.allowedPorts, ['443']);
});

await test('prepareSend(asSticker)：缩略图/原图都超表情规格 → 记 failed 且不抛错；普通模式仍可发', async () => {
  const HUGE = makePng(2000, 10, 4096); // 宽 2000 > 1024，体积仍可下载
  const { service, result } = await searchFixture({
    originalImages: new Map([
      ['https://thumb.example.com/1.jpg', { buffer: HUGE, contentType: 'image/png' }],
      ['https://img.example.com/1.jpg', { buffer: HUGE, contentType: 'image/png' }]
    ])
  });
  const stickerSend = await service.prepareSend({ searchId: result.searchId, candidateIds: [1], asSticker: true });
  assert.equal(stickerSend.selected.length, 0);
  assert.equal(stickerSend.failed.length, 1);
  assert.match(String(stickerSend.failed[0].reason), /表情|尺寸/);
  const normalSend = await service.prepareSend({ searchId: result.searchId, candidateIds: [1], asSticker: false });
  assert.equal(normalSend.selected.length, 1);
  assert.equal(normalSend.selected[0].bytes, HUGE.length);
});

await test('prepareSend：未知 candidateId 记 failed 并继续；非法参数抛 INVALID_ARGUMENT', async () => {
  const { service, result } = await searchFixture({});
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [1, 99] });
  assert.equal(send.selected.length, 1);
  assert.deepEqual(send.failed, [{ candidateId: 99, reason: '候选不存在' }]);

  await expectCode(() => service.prepareSend({ searchId: result.searchId, candidateIds: [] }), 'INVALID_ARGUMENT', '空数组');
  await expectCode(() => service.prepareSend({ searchId: result.searchId, candidateIds: 'x' }), 'INVALID_ARGUMENT', '非数组');
  await expectCode(() => service.prepareSend({ searchId: result.searchId, candidateIds: [1.5] }), 'INVALID_ARGUMENT', '非整数');
  await expectCode(() => service.prepareSend({ searchId: result.searchId }), 'INVALID_ARGUMENT', '缺 candidateIds');
  await expectCode(() => service.prepareSend({ searchId: 'nope', candidateIds: [1] }), 'SEARCH_NOT_FOUND', '未知 searchId');
});

await test('prepareSend：maxPerMessage 截断（truncated=true，超出的静默忽略）', async () => {
  const originalImages = new Map([
    [ORIGINAL_URLS[1], { buffer: VALID_PNG, contentType: 'image/png' }],
    [ORIGINAL_URLS[2], { buffer: VALID_JPEG, contentType: 'image/jpeg' }],
    [ORIGINAL_URLS[3], { buffer: VALID_GIF, contentType: 'image/gif' }]
  ]);
  const { service, result } = await searchFixture({ overrides: { maxPerMessage: 2 }, originalImages });
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [1, 2, 3] });
  assert.equal(send.selected.length, 2);
  assert.equal(send.truncated, true);
  assert.deepEqual(send.failed, []);
  assert.deepEqual(send.selected.map((item) => item.candidateId), [1, 2]);
});

await test('prepareSend：sha256 相同 → duplicates，保留首个', async () => {
  const originalImages = new Map([
    [ORIGINAL_URLS[1], { buffer: VALID_PNG, contentType: 'image/png' }],
    [ORIGINAL_URLS[2], { buffer: VALID_PNG, contentType: 'image/png' }]
  ]);
  const { service, result } = await searchFixture({ originalImages });
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [1, 2] });
  assert.equal(send.selected.length, 1);
  assert.deepEqual(send.duplicates, [2]);
  assert.equal(send.failed.length, 0);
});

await test('prepareSend：maxPixels 拒绝（图片炸弹）', async () => {
  const originalImages = new Map([[ORIGINAL_URLS[3], { buffer: makePng(2000, 2000, 4096), contentType: 'image/png' }]]);
  const { service, result } = await searchFixture({ overrides: { maxPixels: 1000000 }, originalImages });
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [3] });
  assert.equal(send.selected.length, 0);
  assert.equal(send.failed.length, 1);
  assert.equal(send.failed[0].candidateId, 3);
  assert.ok(send.failed[0].reason.includes('像素'));
});

await test('prepareSend：maxBytes 拒绝（服务层再校验一次）', async () => {
  const oversized = makePng(8, 8, 262145);
  const originalImages = new Map([[ORIGINAL_URLS[3], { buffer: oversized, contentType: 'image/png' }]]);
  const { service, result } = await searchFixture({ overrides: { maxBytes: 262144 }, originalImages });
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [3] });
  assert.equal(send.selected.length, 0);
  assert.equal(send.failed.length, 1);
  assert.ok(send.failed[0].reason.includes('大小'));
});

await test('prepareSend：总字节上限从末尾移除并置 truncated + note', async () => {
  const big = 700000;
  const originalImages = new Map([
    [ORIGINAL_URLS[1], { buffer: makePng(8, 8, big), contentType: 'image/png' }],
    [ORIGINAL_URLS[2], { buffer: makePng(16, 8, big), contentType: 'image/png' }]
  ]);
  const { service, result } = await searchFixture({
    overrides: { maxBytes: 1048576, maxTotalBytesPerMessage: 1048576 },
    originalImages
  });
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [1, 2] });
  assert.equal(send.selected.length, 1);
  assert.equal(send.truncated, true);
  assert.ok(send.note.includes('总大小'));
  assert.equal(send.selected[0].candidateId, 1);
  assert.equal(send.failed.length, 0);
});

await test('prepareSend：单张失败（类型/非图片/无尺寸/下载异常）记 failed，全部失败也不抛错', async () => {
  const noDims = Buffer.from('89504e470d0a1a0a', 'hex'); // 只有 PNG 签名
  const originalImages = new Map([
    [ORIGINAL_URLS[1], { buffer: VALID_PNG, contentType: 'text/html' }],
    [ORIGINAL_URLS[2], { buffer: HTML_BYTES, contentType: 'image/png' }],
    [ORIGINAL_URLS[3], { buffer: noDims, contentType: 'image/png' }],
    [ORIGINAL_URLS[4], null]
  ]);
  const fetchText = makeFetchText();
  const fetchBuffer = makeFetchBuffer((url) => {
    if (url === ORIGINAL_URLS[4]) throw new Error('网络异常模拟');
    return originalImages.get(url);
  });
  const { service } = makeService({ overrides: { providers: ['baidu'], maxPerMessage: 4 }, fetchText, fetchBuffer });
  const result = await service.search({ query: '猫咪', count: 4 });
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [1, 2, 3, 4] });
  assert.deepEqual(send.selected, []);
  assert.equal(send.failed.length, 4);
  assert.deepEqual(send.failed.map((item) => item.candidateId), [1, 2, 3, 4]);
  assert.ok(send.failed[0].reason.includes('类型'));
  assert.ok(send.failed[1].reason.includes('图片'));
  assert.ok(send.failed[2].reason.includes('尺寸'));
  assert.ok(send.failed[3].reason.includes('网络'));
});

// ═══════════════════════════════════════════════════════════════════════
// 10. 缓存 TTL / size / clearExpired / reset
// ═══════════════════════════════════════════════════════════════════════
await test('getSearch：TTL 由可注入 now 控制，过期/不存在分别报错，clearExpired/reset 生效', async () => {
  let fakeNow = 1000;
  const { service, result } = await searchFixture({ now: () => fakeNow });
  assert.equal(service.size(), 1);
  assert.equal(service.clearExpired(), 0);

  const cached = await service.getSearch(result.searchId);
  assert.equal(cached.createdAt, 1000);
  assert.equal(cached.expiresAt, 1000 + 10 * 60000);

  fakeNow += 9 * 60000;
  assert.ok((await service.getSearch(result.searchId)).candidates.length > 0, '9 分钟后仍有效');

  fakeNow += 60000; // 正好到期
  await expectCode(() => service.getSearch(result.searchId), 'SEARCH_EXPIRED', 'TTL 到期');
  await expectCode(() => service.getSearch('does-not-exist'), 'SEARCH_NOT_FOUND', '未知 searchId');

  assert.equal(service.clearExpired(), 1);
  assert.equal(service.size(), 0);

  const { service: another } = await searchFixture({});
  assert.equal(another.size(), 1);
  another.reset();
  assert.equal(another.size(), 0);
});

// ═══════════════════════════════════════════════════════════════════════
// 11. task-3：Baidu cookie 反爬 / antiFlag / 预览兜底 / 占位图下限
// ═══════════════════════════════════════════════════════════════════════
const ANTI_FLAG_BODY = '{"antiFlag":1,"message":"Forbid spider access"}';

await test('defaultImageFetchers.fetchText：原样透传 safeFetch 结果（含 headers/set-cookie）', () => {
  // safeFetch 现在返回 { url, statusCode, truncated, contentType, headers, body }；
  // defaultImageFetchers.fetchText 直接 return 它，不做字段裁剪，Baidu cookie 流程依赖 headers。
  const source = defaultImageFetchers.fetchText.toString();
  assert.match(source, /return\s+safeFetch\(/);
});

await test('Baidu cookie：首页 Set-Cookie 被回放为 Cookie 请求头；5 分钟内复用、过期后重取', async () => {
  let fakeNow = 1_000_000;
  const fetchText = makeFetchText();
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({ overrides: { providers: ['baidu'] }, fetchText, fetchBuffer, now: () => fakeNow });
  const homeCalls = () => fetchText.calls.filter((call) => call.url === 'https://image.baidu.com/').length;

  await service.search({ query: '猫咪', count: 1 });
  assert.equal(homeCalls(), 1);
  const firstAcjson = fetchText.calls.find((call) => call.url.includes('/search/acjson'));
  assert.equal(firstAcjson.options.headers.cookie, 'BAIDUID=fixture-cookie; BDUSS=fixture-token');

  fetchText.calls.length = 0;
  fakeNow += 4 * 60000; // 5 分钟内
  await service.search({ query: '猫咪', count: 1 });
  assert.equal(homeCalls(), 0, '缓存期内不再请求首页');
  assert.equal(
    fetchText.calls.find((call) => call.url.includes('/search/acjson')).options.headers.cookie,
    'BAIDUID=fixture-cookie; BDUSS=fixture-token'
  );

  fetchText.calls.length = 0;
  fakeNow += 2 * 60000; // 累计 6 分钟 > 5 分钟
  await service.search({ query: '猫咪', count: 1 });
  assert.equal(homeCalls(), 1, 'cookie 过期后重新取首页');
});

await test('Baidu antiFlag：清 cookie 重试一次；重试成功则正常返回候选', async () => {
  const fetchText = makeFetchText({ baiduResponses: [ANTI_FLAG_BODY, BAIDU_JSON] });
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({ overrides: { providers: ['baidu'] }, fetchText, fetchBuffer });
  const result = await service.search({ query: '柴犬 表情包', count: 2 });
  assert.equal(result.providers[0].ok, true);
  assert.equal(result.providers[0].count, 4);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((candidate) => candidate.preview === 'ok'));
  assert.equal(fetchText.calls.filter((call) => call.url.includes('/search/acjson')).length, 2, 'antiFlag 后应重试一次');
  assert.equal(fetchText.calls.filter((call) => call.url === 'https://image.baidu.com/').length, 2, '重试前清 cookie 会重取首页');
});

await test('Baidu antiFlag/0 条持续：provider ok=true,count=0 不抛错，note 含可读原因', async () => {
  const fetchText = makeFetchText({ baiduResponses: [ANTI_FLAG_BODY, ANTI_FLAG_BODY] });
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({ overrides: { providers: ['baidu'] }, fetchText, fetchBuffer });
  const result = await service.search({ query: '柴犬', count: 3 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.providers[0].ok, true);
  assert.equal(result.providers[0].count, 0);
  assert.equal(result.providers[0].error, undefined);
  assert.ok(result.note.includes('没有搜到可用的图片'));
  assert.ok(result.note.includes('antiFlag'));
  assert.ok(!result.note.includes('fixture-cookie'), 'note 不得泄露 cookie');
  assert.equal(fetchText.calls.filter((call) => call.url.includes('/search/acjson')).length, 2);

  const emptyText = makeFetchText({ baidu: '{"data":[]}' });
  const { service: emptyService } = makeService({ overrides: { providers: ['baidu'] }, fetchText: emptyText, fetchBuffer });
  const emptyResult = await emptyService.search({ query: '猫咪', count: 3 });
  assert.equal(emptyResult.providers[0].ok, true);
  assert.equal(emptyResult.providers[0].count, 0);
  assert.ok(emptyResult.note.includes('没有返回结果'));
});

await test('Baidu 首页取 cookie 失败不致命：仍请求 acjson（不带 cookie）', async () => {
  const fetchText = makeFetchText({ fail: { baiduHome: '首页模拟失败' } });
  const fetchBuffer = makeFetchBuffer(pngHandler);
  const { service } = makeService({ overrides: { providers: ['baidu'] }, fetchText, fetchBuffer });
  const result = await service.search({ query: '猫咪', count: 1 });
  assert.equal(result.providers[0].ok, true);
  assert.equal(result.candidates.length, 1);
  const acjson = fetchText.calls.find((call) => call.url.includes('/search/acjson'));
  assert.equal(acjson.options.headers.cookie, undefined);
});

await test('预览兜底：thumbUrl 失败后改用 imageUrl（同一 previewBytes 上限）', async () => {
  const thumbUrl = 'https://thumb.example.com/1.jpg';
  const imageUrl = 'https://img.example.com/1.jpg';
  const fetchBuffer = makeFetchBuffer((url) => {
    if (url === thumbUrl) throw new Error('缩略图 CDN 被重置（模拟 ts*.mm.bing.net）');
    if (url === imageUrl) return { buffer: VALID_PNG, contentType: 'image/png' };
    return { buffer: VALID_PNG, contentType: 'image/png' };
  });
  const { service } = makeService({ overrides: { providers: ['baidu'] }, fetchText: makeFetchText(), fetchBuffer });
  const result = await service.search({ query: '猫咪', count: 1 });
  assert.equal(result.candidates[0].preview, 'ok');
  assert.equal(result.candidates[0].bytes, VALID_PNG.length, '成功兜底后 bytes 用实际下载结果');
  assert.equal(result.previews.length, 1);
  const urls = fetchBuffer.calls.map((call) => call.url);
  assert.ok(urls.includes(thumbUrl));
  assert.ok(urls.includes(imageUrl));
  assert.ok(urls.indexOf(thumbUrl) < urls.indexOf(imageUrl), '先试 thumbUrl 再试 imageUrl');
  for (const call of fetchBuffer.calls) assert.equal(call.options.maxBytes, 262144);
});

await test('占位图下限：preview 拒绝 <2048 字节 / 1×1，thumb 与 imageUrl 都试过仍失败', async () => {
  const fetchBuffer = makeFetchBuffer((url) => {
    if (url.includes('/1.jpg')) return { buffer: PNG_1X1, contentType: 'image/png' }; // 68B / 1×1
    return { buffer: makePng(16, 16, 1000), contentType: 'image/png' }; // 1000B / 16×16
  });
  const { service } = makeService({ overrides: { providers: ['baidu'] }, fetchText: makeFetchText(), fetchBuffer });
  const result = await service.search({ query: '猫咪', count: 2 });
  assert.deepEqual(result.candidates.map((candidate) => candidate.preview), ['failed', 'failed']);
  assert.deepEqual(result.previews, []);
  assert.equal(result.candidates[0].bytes, 12345, '预览失败仍回退 provider 元数据 bytes');
});

await test('占位图下限：prepareSend 拒绝 1×1 / <2048 字节，8×8+2048B 恰好通过', async () => {
  const minValid = makePng(8, 8, 2048);
  const originalImages = new Map([
    [ORIGINAL_URLS[1], { buffer: PNG_1X1, contentType: 'image/png' }],
    [ORIGINAL_URLS[2], { buffer: makePng(16, 16, 1000), contentType: 'image/png' }],
    [ORIGINAL_URLS[3], { buffer: minValid, contentType: 'image/png' }]
  ]);
  const { service, result } = await searchFixture({ originalImages });
  const send = await service.prepareSend({ searchId: result.searchId, candidateIds: [1, 2, 3] });
  assert.deepEqual(send.selected.map((item) => item.candidateId), [3]);
  assert.deepEqual(send.failed.map((item) => item.candidateId), [1, 2]);
  assert.ok(send.failed[0].reason.includes('占位'));
  assert.ok(send.failed[1].reason.includes('占位'));
  assert.equal(send.selected[0].width, 8);
  assert.equal(send.selected[0].height, 8);
  assert.equal(send.selected[0].bytes, 2048);
});

// ═══════════════════════════════════════════════════════════════════════
if (failures > 0) {
  console.error(`\n❌ 图片检索单测失败：${failures} 项失败 / ${passed + failures} 项`);
  process.exit(1);
}
console.log(`\n🎉 图片检索单测全部通过（${passed} 项）`);
