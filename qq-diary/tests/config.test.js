// config.js：默认值合并、非法值回退、路径解析、只读 bridge 事实读取。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveConfiguredPath,
  readDshCredential,
  readJsonFile,
  loadBridgeFacts,
  readBridgeConsoleToken,
  readBridgeMode
} from '../src/config.js';
import { cleanupTempRoots, mkTempRoot, makeFakeBridge, writeJsonFile, writeTextFile } from './helpers.js';

after(cleanupTempRoots);

describe('loadConfig：默认值 / 合并 / 回退', () => {
  test('config.json 缺失 → 用默认值并给出 warnings', () => {
    const root = mkTempRoot();
    const { config, warnings, configFile } = loadConfig({ root });
    assert.equal(configFile, path.join(root, 'config.json'));
    assert.ok(warnings.some((item) => item.includes('未找到')), warnings.join('|'));
    assert.equal(config.writeAt, '22:00'); // v1.4 主人已定：默认写入时间 22:00
    assert.equal(config.timezone, 'Asia/Shanghai');
    assert.equal(config.maxContextChars, DEFAULT_CONFIG.maxContextChars);
    assert.equal(config.minDiaryChars, 200);
    assert.equal(config.maxDiaryChars, 400);
    assert.equal(config.model, DEFAULT_CONFIG.model);
    assert.equal(config.diaryDir, path.join(root, 'diaries'));
    assert.equal(config.diaryFile, 'diary.md');
    assert.equal(config.logDir, path.join(root, 'logs'));
    assert.equal(config.stateDir, path.join(root, 'state'));
    assert.equal(config.lockFile, path.join(root, 'state', 'daemon.pid'));
    assert.equal(config.indexFile, path.join(root, 'diaries', 'index.json'));
    assert.equal(config.backupDir, path.join(root, 'diaries', '.backup'));
    assert.deepEqual(config.notifyOwner.channels, ['snowluma', 'bridge']);
  });

  test('config.json 覆盖默认值（数字/字符串/嵌套）', () => {
    const root = mkTempRoot();
    writeJsonFile(path.join(root, 'config.json'), {
      writeAt: '22:15',
      timezone: 'UTC',
      model: 'my-model',
      maxDiaryChars: 500,
      minDiaryChars: 250,
      maxContextChars: 8000,
      includeGroups: false,
      includeOtherPrivates: true,
      notifyOwner: { maxChars: 120, channels: ['bridge'] }
    });
    const { config, warnings } = loadConfig({ root });
    assert.deepEqual(warnings, []);
    assert.equal(config.writeAt, '22:15');
    assert.equal(config.timezone, 'UTC');
    assert.equal(config.model, 'my-model');
    assert.equal(config.maxDiaryChars, 500);
    assert.equal(config.minDiaryChars, 250);
    assert.equal(config.maxContextChars, 8000);
    assert.equal(config.includeGroups, false);
    assert.equal(config.includeOtherPrivates, true);
    assert.equal(config.notifyOwner.maxChars, 120);
    assert.deepEqual(config.notifyOwner.channels, ['bridge']);
    // 未覆盖的嵌套字段仍保留默认值
    assert.equal(config.notifyOwner.template, DEFAULT_CONFIG.notifyOwner.template);
    assert.equal(config.notifyOwner.retryMax, DEFAULT_CONFIG.notifyOwner.retryMax);
  });

  test('diaryFile：默认 diary.md；合法 .md 文件名生效；带路径/非 .md 回退并 warning', () => {
    const custom = mkTempRoot();
    writeJsonFile(path.join(custom, 'config.json'), { diaryFile: 'my-diary.md' });
    const customConfig = loadConfig({ root: custom });
    assert.equal(customConfig.config.diaryFile, 'my-diary.md');
    assert.deepEqual(customConfig.warnings, []);

    const withPath = mkTempRoot();
    writeJsonFile(path.join(withPath, 'config.json'), { diaryFile: 'sub/dir/x.md' });
    const pathConfig = loadConfig({ root: withPath });
    assert.equal(pathConfig.config.diaryFile, 'x.md', '只取文件名，不允许带路径');
    assert.ok(pathConfig.warnings.some((item) => item.includes('diaryFile')), pathConfig.warnings.join('|'));

    const wrongExt = mkTempRoot();
    writeJsonFile(path.join(wrongExt, 'config.json'), { diaryFile: 'notes.txt' });
    const extConfig = loadConfig({ root: wrongExt });
    assert.equal(extConfig.config.diaryFile, 'diary.md');
    assert.ok(extConfig.warnings.some((item) => item.includes('diaryFile')), extConfig.warnings.join('|'));

    const empty = mkTempRoot();
    writeJsonFile(path.join(empty, 'config.json'), { diaryFile: '   ' });
    assert.equal(loadConfig({ root: empty }).config.diaryFile, 'diary.md');
  });

  test('非法 writeAt 回退 22:00 并 warning', () => {
    const root = mkTempRoot();
    writeJsonFile(path.join(root, 'config.json'), { writeAt: '25:99' });
    const { config, warnings } = loadConfig({ root });
    assert.equal(config.writeAt, '22:00');
    assert.ok(warnings.some((item) => item.includes('writeAt')), warnings.join('|'));
  });

  test('非法时区回退 Asia/Shanghai 并 warning', () => {
    const root = mkTempRoot();
    writeJsonFile(path.join(root, 'config.json'), { timezone: 'Mars/Base' });
    const { config, warnings } = loadConfig({ root });
    assert.equal(config.timezone, 'Asia/Shanghai');
    assert.ok(warnings.some((item) => item.includes('时区')), warnings.join('|'));
  });

  test('maxDiaryChars <= minDiaryChars 自动调整为 min+100 并 warning', () => {
    const root = mkTempRoot();
    writeJsonFile(path.join(root, 'config.json'), { minDiaryChars: 400, maxDiaryChars: 300 });
    const { config, warnings } = loadConfig({ root });
    assert.equal(config.minDiaryChars, 400);
    assert.equal(config.maxDiaryChars, 500);
    assert.ok(warnings.some((item) => item.includes('maxDiaryChars')), warnings.join('|'));
  });

  test('相对路径按项目根解析，绝对路径规范化', () => {
    const root = mkTempRoot();
    writeJsonFile(path.join(root, 'config.json'), {
      diaryDir: 'out/diaries',
      logDir: '../shared-logs',
      qqBridgeDir: 'rel-bridge'
    });
    const { config } = loadConfig({ root });
    assert.equal(config.diaryDir, path.resolve(root, 'out/diaries'));
    assert.equal(config.logDir, path.resolve(root, '../shared-logs'));
    assert.equal(config.qqBridgeDir, path.resolve(root, 'rel-bridge'));
  });

  test('config.json 内容损坏 / 顶层不是对象 → 用默认值 + warning', () => {
    const badRoot = mkTempRoot();
    writeTextFile(path.join(badRoot, 'config.json'), '{ not json');
    const bad = loadConfig({ root: badRoot });
    assert.equal(bad.config.writeAt, '22:00');
    assert.ok(bad.warnings.length >= 1);

    const arrRoot = mkTempRoot();
    writeJsonFile(path.join(arrRoot, 'config.json'), [1, 2, 3]);
    const arr = loadConfig({ root: arrRoot });
    assert.ok(arr.warnings.some((item) => item.includes('顶层')));
    assert.equal(arr.config.writeAt, '22:00');
  });

  test('notifyOwner.channels 过滤非法值；全非法时回退默认', () => {
    const root = mkTempRoot();
    writeJsonFile(path.join(root, 'config.json'), { notifyOwner: { channels: ['bridge', 'bad', 'snowluma'] } });
    const filtered = loadConfig({ root });
    assert.deepEqual(filtered.config.notifyOwner.channels, ['bridge', 'snowluma']);

    const root2 = mkTempRoot();
    writeJsonFile(path.join(root2, 'config.json'), { notifyOwner: { channels: ['nope'] } });
    const fallback = loadConfig({ root: root2 });
    assert.deepEqual(fallback.config.notifyOwner.channels, ['snowluma', 'bridge']);
    assert.ok(fallback.warnings.some((item) => item.includes('channels')));
  });

  test('模板缺占位符 → warning，但保留原文', () => {
    const root = mkTempRoot();
    writeJsonFile(path.join(root, 'config.json'), { notifyOwner: { template: '固定文案' } });
    const { config, warnings } = loadConfig({ root });
    assert.equal(config.notifyOwner.template, '固定文案');
    assert.ok(warnings.some((item) => item.includes('占位符')));
  });

  test('指定 file 时优先读该文件', () => {
    const root = mkTempRoot();
    const custom = path.join(root, 'custom.json');
    writeJsonFile(custom, { writeAt: '08:05' });
    const { config, configFile } = loadConfig({ root, file: custom });
    assert.equal(configFile, path.resolve(custom));
    assert.equal(config.writeAt, '08:05');
  });
});

describe('resolveConfiguredPath / 凭据 / JSON 读取', () => {
  test('resolveConfiguredPath：空串用默认、相对按根、绝对保留', () => {
    const root = mkTempRoot();
    assert.equal(resolveConfiguredPath('', root, 'diaries'), path.join(root, 'diaries'));
    assert.equal(resolveConfiguredPath('  ', root, 'logs'), path.join(root, 'logs'));
    assert.equal(resolveConfiguredPath('sub/dir', root, 'x'), path.resolve(root, 'sub/dir'));
    const absolute = path.join(root, 'absolute');
    assert.equal(resolveConfiguredPath(absolute, root, 'x'), path.normalize(absolute));
  });

  test('readDshCredential：从 $DSH_HOME/.credentials.yaml 的 refs 取值', () => {
    const dshHome = mkTempRoot();
    writeTextFile(
      path.join(dshHome, '.credentials.yaml'),
      'refs:\n  DEEPSEEK_API_KEY: dsh-key-from-yaml\n  OTHER: other-value\n'
    );
    assert.equal(readDshCredential('DEEPSEEK_API_KEY', { dshHome }), 'dsh-key-from-yaml');
    assert.equal(readDshCredential('MISSING', { dshHome }), '');
    assert.equal(readDshCredential('', { dshHome }), '');
    assert.equal(readDshCredential('DEEPSEEK_API_KEY', { dshHome: path.join(dshHome, 'nope') }), '');
  });

  test('readJsonFile：缺失 = missing、损坏 = 错误信息、BOM 可读', () => {
    const dir = mkTempRoot();
    const missing = readJsonFile(path.join(dir, 'none.json'));
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'missing');

    const broken = path.join(dir, 'broken.json');
    writeTextFile(broken, '{ broken');
    const bad = readJsonFile(broken);
    assert.equal(bad.ok, false);
    assert.ok(bad.error && bad.error !== 'missing');

    const bom = path.join(dir, 'bom.json');
    writeTextFile(bom, '\uFEFF{"a":1}');
    const ok = readJsonFile(bom);
    assert.equal(ok.ok, true);
    assert.equal(ok.data.a, 1);
  });
});

describe('qq-bridge 只读事实', () => {
  test('loadBridgeFacts：ownerQQ / snowluma / consolePort / allow 归一', () => {
    const root = mkTempRoot();
    const bridgeDir = makeFakeBridge(root, {
      ownerQQ: 10001,
      snowluma: { httpUrl: 'http://127.0.0.1:3100/', accessToken: '  tok-abc  ' },
      consolePort: 9999
    });
    const facts = loadBridgeFacts(bridgeDir);
    assert.equal(facts.ok, true);
    assert.equal(facts.error, null);
    assert.equal(facts.ownerQQ, 10001);
    assert.equal(facts.snowluma.httpUrl, 'http://127.0.0.1:3100');
    assert.equal(facts.snowluma.accessToken, 'tok-abc');
    assert.equal(facts.consolePort, 9999);
    assert.deepEqual(facts.allow.private, [10001]);
    assert.deepEqual(facts.allow.groups, [30001]);
  });

  test('loadBridgeFacts：目录缺 config.json → ok:false + missing；非法字段降级', () => {
    const root = mkTempRoot();
    const missing = loadBridgeFacts(path.join(root, 'no-bridge'));
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'missing');
    assert.equal(missing.ownerQQ, null);
    assert.equal(missing.consolePort, 3100);

    const dir = path.join(root, 'bridge');
    writeJsonFile(path.join(dir, 'config.json'), {
      ownerQQ: 'not-a-number',
      snowluma: 'nope',
      consolePort: 'oops',
      allow: { private: ['10001', 'bad'], groups: [30001, 'bad'] }
    });
    const degraded = loadBridgeFacts(dir);
    assert.equal(degraded.ok, true);
    assert.equal(degraded.ownerQQ, null);
    assert.equal(degraded.snowluma.httpUrl, '');
    assert.equal(degraded.consolePort, 3100);
    assert.deepEqual(degraded.allow.private, [10001]);
    assert.deepEqual(degraded.allow.groups, [30001]);
  });

  test('readBridgeConsoleToken：读并 trim；缺失返回空串', () => {
    const root = mkTempRoot();
    const bridgeDir = makeFakeBridge(root);
    assert.equal(readBridgeConsoleToken(bridgeDir).length > 0, true);
    assert.equal(readBridgeConsoleToken(path.join(root, 'nope')), '');
  });

  test('readBridgeMode：mode.json + social-v2 的 paused', () => {
    const root = mkTempRoot();
    const bridgeDir = makeFakeBridge(root);
    const notReady = readBridgeMode(bridgeDir);
    assert.equal(notReady.ready, false);
    assert.equal(notReady.mode, '');
    assert.equal(notReady.paused, null);

    writeJsonFile(path.join(bridgeDir, 'state', 'mode.json'), { mode: 'reserved2' });
    writeJsonFile(path.join(bridgeDir, 'state', 'social-v2.json'), { paused: true, conversations: {} });
    const ready = readBridgeMode(bridgeDir);
    assert.equal(ready.ready, true);
    assert.equal(ready.mode, 'reserved2');
    assert.equal(ready.paused, true);
  });
});
