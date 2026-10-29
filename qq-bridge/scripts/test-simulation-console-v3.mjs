// GEN3 P2.5 灰度与回滚契约：控制台面板静态结构 + 桥接热生效/合并/一键回 V2 语义。
// 面板是动态渲染的，所以这里同时钉住「schema 生成物的每种类型都有对应渲染分支」，
// 避免以后新增参数类型时前端悄悄渲染成一个不可编辑的文本框。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
const generated = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'simulation', 'generated', 'console-fields.json'), 'utf8'));

const NEW_IDS = ['v3StatusHead', 'v3RollbackBtn', 'v3SaveBtn', 'v3ConfigMsg', 'v3Fields', 'v3CanaryInput', 'v3CanaryAdd', 'v3CanaryList'];

const ADMIN = { 'x-console-token': 'fixture-console-token' };

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: response.statusCode, body: data, json });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

// ── 1. 控制台静态契约 ────────────────────────────────────────────────────────
test('控制台：三代仿真页同时注册 data-view 与 data-page，且两个集合完全相等', () => {
  const views = [...new Set([...html.matchAll(/data-view="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
  const pages = [...new Set([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(views.includes('social-v3'), '侧边导航缺少 data-view="social-v3"');
  assert.ok(pages.includes('social-v3'), '内容区缺少 data-page="social-v3"');
  assert.deepEqual(views, pages, 'data-view 与 data-page 必须一一对应');
});

test('控制台：三代面板新增 DOM id 唯一，且没有改动既有 id', () => {
  const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  for (const id of NEW_IDS) {
    const count = ids.filter((value) => value === id).length;
    assert.equal(count, 1, `${id} 应恰好出现 1 次，实际 ${count} 次`);
  }
  const dups = [...new Set(ids.filter((value, index) => ids.indexOf(value) !== index))];
  assert.deepEqual(dups, [], `存在重复 DOM id：${dups.join(', ')}`);
  // 既有页面/控件仍在（只追加不改旧 id）
  for (const legacy of ['section-social-v2', 'v2AgentPreset', 'voiceList', 'section-slang']) {
    assert.ok(ids.includes(legacy), `既有 id 被删：${legacy}`);
  }
});

test('控制台：面板引用三个灰度/回滚端点，且主 script 可解析', () => {
  assert.match(html, /\/api\/socialV3\/config/, '缺少 /api/socialV3/config');
  assert.match(html, /\/api\/socialV3\/rollback/, '缺少 /api/socialV3/rollback');
  assert.match(html, /\/api\/socialV3\/canary/, '缺少 /api/socialV3/canary');
  assert.match(html, /function loadSocialV3Config|async function loadSocialV3Config/, '缺少 loadSocialV3Config');
  assert.match(html, /getElementById\('v3RollbackBtn'\)\.addEventListener/, '一键回 V2 按钮未绑定事件');
  assert.match(html, /getElementById\('v3SaveBtn'\)\.addEventListener/, '保存按钮未绑定事件');
  assert.match(html, /getElementById\('v3CanaryAdd'\)\.addEventListener/, '加入灰度按钮未绑定事件');
  assert.match(html, /if \(page === 'social-v3'[^)]*loadSocialV3Config/, '切页逻辑未接入懒加载');

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length);
  assert.doesNotThrow(() => new Function(scripts[0]), '主 script 语法必须可解析');
});

test('生成物：console-fields 的每种类型在面板渲染代码里都有分支', () => {
  const types = [...new Set(generated.fields.map((field) => field.type))];
  assert.ok(types.length >= 5, `生成物类型过少：${types.join(',')}`);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const type of types) {
    assert.match(html, new RegExp(`case\\s*'${escape(type)}'`), `渲染代码缺少 ${type} 分支`);
  }
  for (const field of generated.fields) {
    assert.ok(field.id && field.path && field.group && field.label, `生成物字段不完整：${field.path}`);
  }
});

// ── 2. 后端：热生效 / 深合并 / 一键回 V2 ──────────────────────────────────────
test('总览「当前运行模式」卡片接入三代状态：/api/status 带 socialV3 摘要，metricMode 显示三代', async () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  // 后端数据源：完整 /api/status 响应必须带 simV3StatusSummary()（agent 受限视图不带）
  assert.match(bridgeSrc, /socialV3:\s*simV3StatusSummary\(\)/, '/api/status 缺少 socialV3 摘要');
  // 前端显示链：refresh → describeSimV3 → updateOverview 第三参 → metricMode 三分支
  assert.match(html, /describeSimV3\(s\.socialV3/, 'refresh() 未把 socialV3 传给 describeSimV3');
  assert.match(html, /updateOverview\(s, modeLabel, describeSimV3/, 'updateOverview 未接收三代状态');
  assert.match(html, /function describeSimV3\(/, '缺少 describeSimV3');
  assert.match(html, /metricMode'\)\.textContent = '三代仿真'/, 'metricMode 未在启用时显示「三代仿真」');
  assert.match(html, /metricRole'\)\.textContent = simV3\.tag/, 'metricRole 未显示灰度阶段');
  // 未启用时保持原模式名（describeSimV3 返回 null 的分支）
  assert.match(html, /if \(!v3 \|\| !v3\.enabled\) return null;/, 'describeSimV3 未启用分支缺失');

  // 端到端：真起控制台服务，GET /api/status 必须带回 socialV3 摘要（默认全关）
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/status', { headers: ADMIN });
      assert.equal(res.status, 200);
      assert.ok(res.json.socialV3, '/api/status 响应缺少 socialV3 字段');
      assert.equal(res.json.socialV3.enabled, false, '默认应为关闭（完全走 V2）');
      assert.equal(typeof res.json.socialV3.mode, 'string');
    });
  } finally { await h.close(); }
});
test('控制台：模式行有「三代仿真」直切卡片，并按 socialV3 状态高亮', () => {
  assert.ok(html.includes('data-mode="gen3"'), '模式行缺少 data-mode="gen3" 卡片');
  assert.match(html, /<strong>三代仿真<\/strong>/, '卡片标题缺失');
  assert.match(html, /id="modeHint"/, '缺少模式切换提示位');
  assert.match(html, /s\.socialV3 && s\.socialV3\.enabled && s\.mode === 'reserved2'/, '模式行未按三代状态高亮');
  assert.match(html, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/, '模式行需为 5 列布局');
  // 提示必须按「当前状态」反复渲染：改完灰度模式/名单后不能残留旧警告
  assert.match(html, /function renderModeHint\(v3\)/, '缺统一的模式提示渲染函数');
  assert.match(html, /renderModeHint\(s\.socialV3\)/, '5 秒轮询必须更新模式提示');
  assert.match(html, /renderModeHint\(r\.status\)/, '读取/保存三代配置后必须更新模式提示');
  assert.doesNotMatch(html, /wasGen3/, '不得再用一次性的模式提示逻辑');
});

test('applySimV3Config：原地换值立即改变模块闸门与 canary 判定（无需重启）', async () => {
  const h = await bridgeHarness();
  try {
    const live = h.simV3Cfg;
    assert.equal(live.enabled, false, '默认关闭，完全走 V2');
    assert.equal(h.simV3.moduleOn('memory'), false);

    const { value } = await import('../src/simulation/config.js').then((m) => m.normalizeSocialV3({
      enabled: true,
      mode: 'canary',
      modules: { memory: true },
      canaryGroups: ['group:456']
    }));
    h.applySimV3Config(value);

    assert.equal(live.enabled, true, '热生效必须是原地写回同一个 simV3Cfg 对象');
    assert.equal(h.simV3.moduleOn('memory'), true, '模块闸门应立即放开');
    assert.equal(h.simV3.canaryAllowed('group:456'), true, '灰度名单内的会话应立即生效');
    assert.equal(h.simV3.canaryAllowed('group:999'), false, '名单外会话不受影响');
    assert.equal(h.cfg.socialV3.enabled, true, 'cfg.socialV3 要同步，供后续落盘/读取');

    h.applySimV3Config({ ...value, enabled: false });
    assert.equal(h.simV3.moduleOn('memory'), false, '关闭总开关后模块闸门立刻回到 V2 行为');
    assert.equal(h.simV3.canaryAllowed('group:456'), false, '关闭后不再有任何灰度命中');
  } finally { await h.close(); }
});

test('mode 语义：shadow 永不生效；canary 只看名单；记忆另受只读锁约束', async () => {
  const h = await bridgeHarness();
  try {
    const { normalizeSocialV3 } = await import('../src/simulation/config.js');
    // ① shadow + 名单：任何模块都不生效（只记录）
    const shadow = normalizeSocialV3({
      enabled: true, mode: 'shadow', modules: { memory: true, rhythm: true },
      canaryGroups: ['group:456'], shadowReadOnly: true
    }).value;
    h.applySimV3Config(shadow);
    assert.equal(h.simV3.canaryAllowed('group:456'), false, 'shadow 即使有名单也不生效');
    assert.equal(h.simMemoryCanaryActive(), false);

    // ② canary + 名单 + 只读锁：行为模块生效，但记忆不落盘/不注入
    const locked = normalizeSocialV3({
      enabled: true, mode: 'canary', modules: { memory: true, rhythm: true },
      canaryGroups: ['group:456'], shadowReadOnly: true
    }).value;
    h.applySimV3Config(locked);
    assert.equal(h.simV3.canaryAllowed('group:456'), true, 'canary+名单应放行非记忆模块');
    assert.equal(h.modePreset('group:456', 'reserved2', h.cfg), 'qq-chat-v3', 'canary 会话应使用三代预设');
    assert.equal(h.modePreset('group:999', 'reserved2', h.cfg), 'qq-chat-v2', '名单外会话仍用二代预设');
    assert.equal(h.simMemoryCanaryActive(), false, '只读锁开启时记忆仍不可写');
    assert.equal(h.simMemoryOn('group:456'), false);

    // ③ 关闭只读锁 + canary + 名单：记忆才进入可写状态。
    // 直接改 live 配置对象（不走 applySimV3Config），避免测试触发真实 mnemon 预热/对齐。
    const open = normalizeSocialV3({
      enabled: true, mode: 'canary', modules: { memory: true, rhythm: true },
      canaryGroups: ['group:456'], shadowReadOnly: false
    }).value;
    Object.assign(h.simV3Cfg, JSON.parse(JSON.stringify(open)));
    h.simV3.active = true;
    h.simV3.mode = 'canary';
    assert.equal(h.simMemoryCanaryActive(), true, '关闭只读锁后记忆进入 canary 可写');
    assert.equal(h.simMemoryOn('group:456'), true);
    assert.equal(h.simMemoryOn('group:999'), false, '名单外会话仍不可写');

    // ④ 一键回 V2：记忆立刻只读
    h.applySimV3Config({ ...open, enabled: false });
    assert.equal(h.simMemoryCanaryActive(), false, '回 V2 后记忆立即只读');
  } finally { await h.close(); }
});

test('灰度名单变化不退役已有会话：老会话钉住旧 preset，新会话才用 v3', async () => {
  const h = await bridgeHarness();
  try {
    const { normalizeSocialV3 } = await import('../src/simulation/config.js');
    const key = 'group:456';
    h.state.sessions[key] = 'session-pinned-v2';
    h.state.sessionPolicies[key] = JSON.stringify(['reserved2', 'qq-chat-v2', null]);
    const { value } = normalizeSocialV3({
      enabled: true, mode: 'on', modules: { rhythm: true },
      canaryGroups: [key, 'group:789'], shadowReadOnly: true
    });
    h.applySimV3Config(value);
    assert.equal(h.modePreset(key, 'reserved2', h.cfg), 'qq-chat-v2', '已有会话必须沿用创建时的 preset');
    assert.equal(h.modePreset('group:789', 'reserved2', h.cfg), 'qq-chat-v3', '新会话才使用三代预设');
    assert.equal(h.state.sessions[key], 'session-pinned-v2', '改灰度名单不得退役已有会话');
    assert.equal(h.state.sessionPolicies[key], JSON.stringify(['reserved2', 'qq-chat-v2', null]));
  } finally { await h.close(); }
});

test('config.json 的 socialV3 必须在启动时读回（重启不丢总开关/名单/模块）', async () => {
  const h = await bridgeHarness({
    config: {
      socialV3: {
        enabled: true, mode: 'on', shadowReadOnly: true,
        modules: { rhythm: true }, canaryGroups: ['group:456']
      }
    }
  });
  try {
    assert.equal(h.simV3Cfg.enabled, true, '总开关必须从 config.json 读回');
    assert.equal(h.simV3Cfg.mode, 'on');
    assert.equal(h.simV3Cfg.modules.rhythm, true);
    assert.deepEqual([...h.simV3Cfg.canaryGroups], ['group:456']);
  } finally { await h.close(); }
});

test('mergeSimV3Input：对象深合并、数组整体替换、缺省字段保留', async () => {
  const h = await bridgeHarness();
  try {
    const base = { mode: 'shadow', canaryGroups: ['group:1'], attention: { speakThreshold: 0.6, silentThreshold: 0.3 }, modules: { memory: true } };
    const merged = h.mergeSimV3Input(base, { attention: { speakThreshold: 0.8 }, canaryGroups: ['group:2', 'group:3'] });
    assert.equal(merged.attention.speakThreshold, 0.8, '嵌套字段被 patch 覆盖');
    assert.equal(merged.attention.silentThreshold, 0.3, '未提到的嵌套字段必须保留');
    assert.deepEqual(merged.canaryGroups, ['group:2', 'group:3'], '数组必须整体替换，不能拼接');
    assert.equal(merged.modules.memory, true, '未提到的模块开关必须保留');
    assert.equal(merged.mode, 'shadow', '未提到的顶层字段必须保留');
    assert.deepEqual(base.canaryGroups, ['group:1'], '合并不得改动传入的 base');
  } finally { await h.close(); }
});

test('一键回 V2：只翻 enabled，其余参数原样保留并落盘', async () => {
  const h = await bridgeHarness();
  try {
    const { normalizeSocialV3 } = await import('../src/simulation/config.js');
    const { value } = normalizeSocialV3({
      enabled: true,
      mode: 'canary',
      canaryGroups: ['group:456'],
      modules: { memory: true, affect: true },
      attention: { speakThreshold: 0.7 }
    });
    h.applySimV3Config(value);

    const { status } = h.saveSimV3Patch({ enabled: false });
    assert.equal(status.enabled, false, '回 V2 后总开关必须关闭');
    assert.equal(h.simV3.moduleOn('memory'), false, '关闭后模块闸门立即失效');
    assert.equal(h.simV3Cfg.mode, 'canary', 'mode 必须保留，便于恢复灰度');
    assert.deepEqual([...h.simV3Cfg.canaryGroups], ['group:456'], '灰度名单必须保留');
    assert.equal(h.simV3Cfg.modules.memory, true, '模块开关必须保留');
    assert.equal(h.simV3Cfg.modules.affect, true, '模块开关必须保留');
    assert.equal(h.simV3Cfg.attention.speakThreshold, 0.7, '阈值参数必须保留');
    assert.equal(status.canaryEffective, true, '名单仍在，摘要照实显示 canary 可恢复');

    const onDisk = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
    assert.equal(onDisk.socialV3.enabled, false, 'config.json 必须落盘');
    assert.deepEqual(onDisk.socialV3.canaryGroups, ['group:456'], '落盘时其余参数保留');
  } finally { await h.close(); }
});

test('端点：GET 字段、canary 按群开关、rollback 回 V2、agent token 拒绝', async () => {
  const h = await bridgeHarness();
  try {
    await withServer(h, async (port) => {
      const got = await call(port, '/api/socialV3/config', { headers: ADMIN });
      assert.equal(got.status, 200);
      assert.equal(got.json.ok, true);
      assert.ok(Array.isArray(got.json.fields) && got.json.fields.length >= 40, '面板字段应来自 schema 全量投影');
      assert.ok(got.json.fields.some((field) => field.id === 'v3Enabled' && field.type === 'boolean'), '字段投影要带 DOM id');
      assert.deepEqual(got.json.canaryGroups, [], '默认灰度名单为空');

      // 只读期（默认 shadow + 只读锁）：手动巩固必须被拒绝，不能偷偷写盘
      const memDenied = await call(port, '/api/socialV3/memory/consolidate', { method: 'POST', headers: ADMIN, body: {} });
      assert.equal(memDenied.status, 409, '只读期手动巩固必须 409');
      assert.equal(memDenied.json.ok, false);

      h.applySimV3Config({ ...h.simV3Cfg, enabled: true, mode: 'canary', modules: { ...h.simV3Cfg.modules, memory: true }, canaryGroups: [] });
      const added = await call(port, '/api/socialV3/canary', { method: 'POST', headers: ADMIN, body: { key: 'group:0456', on: true } });
      assert.equal(added.status, 200);
      assert.equal(added.json.key, 'group:456', 'key 必须归一化后再入名单');
      assert.equal(added.json.status.canaryGroupCount, 1);

      const removed = await call(port, '/api/socialV3/canary', { method: 'POST', headers: ADMIN, body: { key: 'group:456', on: false } });
      assert.equal(removed.status, 200);
      assert.equal(removed.json.status.canaryGroupCount, 0);

      const empty = await call(port, '/api/socialV3/canary', { method: 'POST', headers: ADMIN, body: { key: '  ', on: true } });
      assert.equal(empty.status, 400, '空 key 必须 400');
      assert.equal(empty.json.ok, false);

      const patch = await call(port, '/api/socialV3/config', {
        method: 'POST', headers: ADMIN, body: { canaryGroups: ['group:456'], mode: 'canary', futureThing: 1 }
      });
      assert.equal(patch.status, 200);
      assert.equal(patch.json.ok, true);
      assert.deepEqual(patch.json.unknown, ['futureThing'], '未知字段要原样回报但不阻断');
      assert.equal(patch.json.status.mode, 'canary');

      const rolled = await call(port, '/api/socialV3/rollback', { method: 'POST', headers: ADMIN, body: {} });
      assert.equal(rolled.status, 200);
      assert.equal(rolled.json.status.enabled, false);
      assert.deepEqual([...h.simV3Cfg.canaryGroups], ['group:456'], '一键回 V2 不得清掉灰度名单');

      const asAgent = { ...ADMIN, 'x-agent-token': 'fixture-agent-token', 'x-agent-call': '1' };
      const denied = await call(port, '/api/socialV3/config', { headers: asAgent });
      assert.equal(denied.status, 403, 'agent token 不得读写三代配置');

      // 模式行直切三代：gen3 = reserved2 底座 + socialV3 启用；切回二代则关闭（参数/名单保留）
      const gen3 = await call(port, '/api/mode', { method: 'POST', headers: ADMIN, body: { mode: 'gen3', closedAgentPreset: '' } });
      assert.equal(gen3.status, 200);
      assert.equal(gen3.json.ok, true);
      assert.equal(gen3.json.mode, 'reserved2', 'gen3 的底座必须是 reserved2');
      assert.equal(gen3.json.simulatedMode, 'gen3');
      assert.equal(gen3.json.socialV3.enabled, true, 'gen3 必须启用 socialV3');
      assert.equal(h.getMode(), 'reserved2');
      assert.equal(h.simV3Cfg.enabled, true);
      assert.deepEqual([...h.simV3Cfg.canaryGroups], ['group:456'], '切三代不得清掉灰度名单');

      const back = await call(port, '/api/mode', { method: 'POST', headers: ADMIN, body: { mode: 'reserved2', closedAgentPreset: '' } });
      assert.equal(back.status, 200);
      assert.equal(back.json.mode, 'reserved2');
      assert.equal(back.json.socialV3.enabled, false, '切回二代必须关闭 socialV3');
      assert.equal(h.simV3Cfg.enabled, false);
      assert.deepEqual([...h.simV3Cfg.canaryGroups], ['group:456'], '关闭后名单仍保留，便于随时切回');

      const invalid = await call(port, '/api/mode', { method: 'POST', headers: ADMIN, body: { mode: 'gen4' } });
      assert.equal(invalid.status, 400, '未知模式必须 400');
    });
  } finally { await h.close(); }
});
