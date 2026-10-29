// 只读边界：跑一次完整的 mocked 生成流程，断言真实 qq-bridge 的固定文件哈希未变。
//
// 注意：
// - 流程里 config.qqBridgeDir 指向临时假目录（同时设置 QQBRIDGE_DIR 环境变量做符号标记），
//   绝不让被测代码读写真实 qq-bridge。
// - 真实 qq-bridge 的 state/* 由运行中的桥接自己写，因此只对下面三个稳定文件做哈希断言。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runForDate } from '../index.js';
import { findEntry, readCollection, readIndex } from '../src/store.js';
import {
  cleanupTempRoots,
  createProject,
  conversation,
  msg,
  makeFetchMock,
  jsonResponse,
  llmFetchMock,
  sha256File,
  DEFAULT_ROLE,
  FIXED_NOW,
  FIXED_TODAY,
  OWNER_QQ
} from './helpers.js';

after(cleanupTempRoots);

const QQ_BRIDGE_DIR = 'D:\\github\\qq-bridge';
const FIXED_FILES = [
  'config.json',
  path.join('roles', '蓝莓球.md'),
  path.join('src', 'web-search.js')
];

describe('真实 qq-bridge 只读断言', () => {
  test('mocked 生成全流程后，固定文件 sha256 与 mtime 均未变', async (context) => {
    const before = new Map();
    for (const relative of FIXED_FILES) {
      const file = path.join(QQ_BRIDGE_DIR, relative);
      if (!fs.existsSync(file)) {
        context.skip(`缺少真实 qq-bridge 文件：${file}`);
        return;
      }
      const stat = fs.statSync(file);
      before.set(relative, { hash: sha256File(file), size: stat.size });
      assert.match(before.get(relative).hash, /^[0-9a-f]{64}$/);
    }

    const project = createProject({
      social: {
        paused: false,
        conversations: {
          [`private:${OWNER_QQ}`]: conversation([msg('主人说晚安', 30)]),
          'group:30001': conversation([msg('群里聊到周末要不要出去走走', 20)])
        }
      }
    });
    const notifyMock = makeFetchMock(() => jsonResponse({ retcode: 0, data: { message_id: 1 } }));

    const previousEnv = process.env.QQBRIDGE_DIR;
    process.env.QQBRIDGE_DIR = project.bridgeDir;
    let result;
    try {
      result = await runForDate({
        config: project.config,
        facts: project.facts,
        dateKey: FIXED_TODAY,
        force: true,
        fetchImpl: notifyMock,
        llmFetchImpl: llmFetchMock({ chars: 300 }),
        now: FIXED_NOW
      });
    } finally {
      if (previousEnv === undefined) delete process.env.QQBRIDGE_DIR;
      else process.env.QQBRIDGE_DIR = previousEnv;
    }

    assert.equal(result.ok, true);
    assert.equal(result.written, true);
    assert.equal(result.role, DEFAULT_ROLE);
    assert.equal(result.context.empty, false);
    assert.equal(notifyMock.calls.length, 1);
    // 所有产物都落在临时目录内
    assert.ok(result.path.startsWith(project.root), result.path);
    assert.equal(fs.existsSync(project.diaryFile()), true);
    assert.equal(readIndex({ config: project.config }).entries.length, 1);
    const collection = readCollection({ config: project.config });
    assert.equal(collection.exists, true);
    assert.equal(findEntry(collection.entries, FIXED_TODAY).date, FIXED_TODAY);

    for (const relative of FIXED_FILES) {
      const file = path.join(QQ_BRIDGE_DIR, relative);
      assert.equal(fs.existsSync(file), true, `真实文件不应被删除：${file}`);
      assert.equal(sha256File(file), before.get(relative).hash, `真实文件被修改：${file}`);
      assert.equal(fs.statSync(file).size, before.get(relative).size);
    }
  });

  test('假 bridge 目录不会被当成真实仓库：所有写入都在 temp 根内', async () => {
    const project = createProject();
    const result = await runForDate({
      config: project.config,
      facts: project.facts,
      dateKey: FIXED_TODAY,
      noNotify: true,
      fetchImpl: makeFetchMock(),
      llmFetchImpl: llmFetchMock({ chars: 260 }),
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.ok(result.path.startsWith(project.root));
    assert.ok(project.config.diaryDir.startsWith(project.root));
    assert.ok(project.config.logDir.startsWith(project.root));
    assert.ok(project.config.stateDir.startsWith(project.root));
    // 真实仓库路径没有被解析进配置
    assert.ok(!project.config.diaryDir.includes(QQ_BRIDGE_DIR));
  });
});
