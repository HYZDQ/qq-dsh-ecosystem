// index.js · CLI 纯函数与只读命令：parseArgs / runList / runCheck / runDaemon / main 帮助。
// 日记存储为单文件合集（diaries/diary.md）。runDaemon 只用临时目录 + 注入时钟，测完立即 stop；
// 不启动真实常驻进程、不发真实网络请求。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseArgs, runList, runCheck, runDaemon, main } from '../index.js';
import { upsertEntry, rebuildIndex, readCollection, findEntry, diaryFilePath } from '../src/store.js';
import {
  cleanupTempRoots,
  createProject,
  conversation,
  msg,
  makeFetchMock,
  jsonResponse,
  llmBody,
  llmFetchMock,
  flushMicrotasks,
  readJsonFileSync,
  writeJsonFile,
  diaryText,
  FIXED_NOW,
  FIXED_TODAY,
  OWNER_QQ
} from './helpers.js';

after(cleanupTempRoots);

async function silenceConsole(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const value = await fn();
    return { value, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function entryFor(dateKey, summary = '摘要') {
  return { date: dateKey, weekday: '星期五', role: '蓝莓球', summary, body: `${dateKey} 的正文。` };
}

describe('parseArgs', () => {
  test('默认是常驻模式（migrate=false）', () => {
    const opts = parseArgs([]);
    assert.equal(opts.mode, 'daemon');
    assert.equal(opts.migrate, false);
    assert.equal(opts.force, false);
    assert.equal(opts.dryRun, false);
    assert.equal(opts.date, '');
    assert.deepEqual(opts.unknown, []);
    assert.equal(parseArgs().mode, 'daemon');
    assert.equal(parseArgs(null).mode, 'daemon');
  });

  test('--once / --date / --date=', () => {
    assert.equal(parseArgs(['--once']).mode, 'once');
    const bySpace = parseArgs(['--date', '2026-10-21']);
    assert.equal(bySpace.mode, 'date');
    assert.equal(bySpace.date, '2026-10-21');
    const byEquals = parseArgs(['--date=2026-10-21']);
    assert.equal(byEquals.mode, 'date');
    assert.equal(byEquals.date, '2026-10-21');
    const dangling = parseArgs(['--date']);
    assert.equal(dangling.mode, 'date');
    assert.equal(dangling.date, '');
  });

  test('布尔开关（含短参数与 --migrate）', () => {
    const opts = parseArgs(['--force', '--dry-run', '-n', '--llm', '--no-notify', '--verbose', '-v', '--quiet', '-q']);
    assert.equal(opts.force, true);
    assert.equal(opts.dryRun, true);
    assert.equal(opts.withLlm, true);
    assert.equal(opts.noNotify, true);
    assert.equal(opts.verbose, true);
    assert.equal(opts.quiet, true);
    assert.equal(parseArgs(['--list']).list, true);
    assert.equal(parseArgs(['--check']).check, true);
    assert.equal(parseArgs(['--no-llm']).liveLlm, false);
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
    // --migrate 不改变 mode（main 里先处理迁移再决定后续动作）
    const migrate = parseArgs(['--migrate']);
    assert.equal(migrate.migrate, true);
    assert.equal(migrate.mode, 'daemon');
  });

  test('未配 --once/--date 时，--force/--dry-run/--llm/--no-notify 自动按单次执行', () => {
    assert.equal(parseArgs(['--force']).mode, 'once');
    assert.equal(parseArgs(['--dry-run']).mode, 'once');
    assert.equal(parseArgs(['--llm']).mode, 'once');
    assert.equal(parseArgs(['--no-notify']).mode, 'once');
    assert.equal(parseArgs(['--date', '2026-10-21', '--force']).mode, 'date');
    assert.equal(parseArgs(['--once', '--force']).mode, 'once');
    assert.equal(parseArgs(['--list']).mode, 'daemon');
    assert.equal(parseArgs(['--check']).mode, 'daemon');
  });

  test('未知参数收集到 unknown', () => {
    assert.deepEqual(parseArgs(['--nope', '-x', 'raw']).unknown, ['--nope', '-x', 'raw']);
  });
});

describe('runList（列合集，按日期升序）', () => {
  test('列出合集里的日记并返回 0', async () => {
    const project = createProject();
    upsertEntry({ config: project.config, entry: entryFor('2026-10-23', '23 号摘要'), now: FIXED_NOW });
    upsertEntry({ config: project.config, entry: entryFor('2026-10-21', '21 号摘要'), now: FIXED_NOW });
    rebuildIndex({ config: project.config, now: FIXED_NOW });
    const { value, logs } = await silenceConsole(() => runList({ config: project.config, logger: null }));
    assert.equal(value, 0);
    const output = logs.join('\n');
    assert.ok(output.includes(`日记合集：${diaryFilePath(project.config)}`), output);
    assert.ok(output.includes('共 2 篇（按日期升序）'), output);
    assert.ok(output.includes('index.json 正常（2 条）'), output);
    assert.ok(output.indexOf('2026-10-21') < output.indexOf('2026-10-23'), '应按日期升序');
  });

  test('合集不存在时返回 0（空列表）', async () => {
    const project = createProject();
    const { value, logs } = await silenceConsole(() => runList({ config: project.config, logger: null }));
    assert.equal(value, 0);
    const output = logs.join('\n');
    assert.ok(output.includes('共 0 篇'), output);
    assert.ok(output.includes('日记合集：'), output);
  });

  test('index.json 损坏时提示异常但仍是 0', async () => {
    const project = createProject();
    upsertEntry({ config: project.config, entry: entryFor('2026-10-23'), now: FIXED_NOW });
    fs.writeFileSync(project.config.indexFile, '{ broken', 'utf8');
    const { value, logs } = await silenceConsole(() => runList({ config: project.config, logger: null }));
    assert.equal(value, 0);
    assert.ok(logs.join('\n').includes('异常'));
  });
});

describe('runCheck（离线，liveLlm=false）', () => {
  function checkFetchMock() {
    return makeFetchMock((record) => {
      const url = String(record.url);
      if (url.includes('/get_login_info')) return jsonResponse({ retcode: 0, data: { user_id: OWNER_QQ, nickname: '小号' } });
      if (url.endsWith('/api/status')) return jsonResponse({ mode: 'reserved2', socialV2Paused: false });
      throw new Error(`不应发其他请求：${url}`);
    });
  }

  test('临时项目 + 假 fetch → 无 FAIL 项，含「日记合集 / 旧格式文件」检查', async () => {
    const project = createProject({
      social: {
        conversations: {
          [`private:${OWNER_QQ}`]: conversation([msg('主人说晚安', 30)])
        }
      }
    });
    upsertEntry({ config: project.config, entry: entryFor(FIXED_TODAY), now: FIXED_NOW });
    const fetchMock = checkFetchMock();
    const result = await runCheck({
      config: project.config,
      facts: project.facts,
      logger: null,
      warnings: [],
      fetchImpl: fetchMock,
      liveLlm: false,
      now: FIXED_NOW
    });
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((item) => item.level === 'fail')));
    assert.equal(result.checks.some((item) => item.level === 'fail'), false);
    const names = result.checks.map((item) => item.name);
    for (const expected of [
      'config.json',
      'qq-bridge 目录',
      'qq-bridge/config.json',
      'qq-bridge 事实',
      '目录可写',
      'LLM key',
      '通知通道 snowluma',
      '通知通道 bridge',
      '今天日记',
      '日记合集',
      '旧格式文件',
      '下次写入',
      '通知队列'
    ]) {
      assert.ok(names.includes(expected), `缺少检查项 ${expected}`);
    }
    const collectionCheck = result.checks.find((item) => item.name === '日记合集');
    assert.equal(collectionCheck.ok, true);
    assert.ok(collectionCheck.detail.includes('1 篇'), collectionCheck.detail);
    assert.ok(collectionCheck.detail.includes(FIXED_TODAY), collectionCheck.detail);
    const todayCheck = result.checks.find((item) => item.name === '今天日记');
    assert.ok(todayCheck.detail.includes('已写入合集'), todayCheck.detail);
    const legacyCheck = result.checks.find((item) => item.name === '旧格式文件');
    assert.equal(legacyCheck.level, 'ok');
    assert.ok(legacyCheck.detail.includes('无'), legacyCheck.detail);
    assert.equal(result.checks.find((item) => item.name === 'LLM 活体').level, 'warn');
    assert.equal(result.checks.find((item) => item.name === '目录可写').ok, true);
    // 只做了两个探测请求（snowluma 登录信息 + 控制台状态）
    assert.equal(fetchMock.calls.length, 2);
  });

  test('存在旧格式文件 → 「旧格式文件」warn，但不产生 FAIL', async () => {
    const project = createProject();
    fs.mkdirSync(project.config.diaryDir, { recursive: true });
    fs.writeFileSync(path.join(project.config.diaryDir, '2026-10-21.md'), '---\ndate: \'2026-10-21\'\n---\n\n旧。\n', 'utf8');
    const result = await runCheck({
      config: project.config,
      facts: project.facts,
      logger: null,
      warnings: [],
      fetchImpl: checkFetchMock(),
      liveLlm: false,
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    const legacyCheck = result.checks.find((item) => item.name === '旧格式文件');
    assert.equal(legacyCheck.level, 'warn');
    assert.ok(legacyCheck.detail.includes('1 个'), legacyCheck.detail);
  });
});

describe('runDaemon：被存活实例占锁时直接退出（不启动定时器/常驻进程）', () => {
  test('已有存活 pid 持锁 → skipped:true，不注册进程监听、不改锁文件', async () => {
    const project = createProject();
    const lockFile = project.config.lockFile;
    writeJsonFile(lockFile, { pid: process.ppid, startedAt: '2026-10-23T10:00:00+08:00' });

    const listenersBefore = {
      exit: process.listenerCount('exit'),
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM')
    };
    const notifyMock = makeFetchMock(() => {
      throw new Error('被锁时不应发通知');
    });
    const result = await runDaemon({
      config: project.config,
      facts: project.facts,
      logger: null,
      fetchImpl: notifyMock,
      now: () => FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'locked');
    assert.equal(result.holder.pid, process.ppid);
    assert.equal(readJsonFileSync(lockFile).pid, process.ppid);
    assert.equal(notifyMock.calls.length, 0);
    assert.equal(process.listenerCount('exit'), listenersBefore.exit);
    assert.equal(process.listenerCount('SIGINT'), listenersBefore.SIGINT);
    assert.equal(process.listenerCount('SIGTERM'), listenersBefore.SIGTERM);
  });
});

describe('runDaemon：注入时钟下的启动补写 + stop 释放锁（temp 目录，立即停止）', () => {
  test('启动时已过 writeAt → 触发一次补写；stop 后清锁并停表', async () => {
    const project = createProject({
      config: { writeAt: '23:30', maxRetries: 0 },
      social: {
        conversations: {
          [`private:${OWNER_QQ}`]: conversation([msg('主人说晚安', 30)])
        }
      }
    });
    const fetchMock = makeFetchMock((record) => {
      const url = String(record.url);
      if (url.endsWith('/messages')) return jsonResponse(llmBody({ chars: 300 }));
      if (url.includes('/send_private_msg')) return jsonResponse({ retcode: 0, data: { message_id: 1 } });
      throw new Error(`runDaemon 不应发其他请求：${url}`);
    });

    let daemon = null;
    try {
      daemon = await runDaemon({
        config: project.config,
        facts: project.facts,
        logger: null,
        fetchImpl: fetchMock,
        now: () => FIXED_NOW
      });
      assert.equal(daemon.ok, true);
      assert.equal(daemon.running, true);
      assert.equal(fs.existsSync(project.config.lockFile), true);

      // 启动瞬间 tick 已过 23:30，onDue 是 async 的：等它把合集写出来
      const hasToday = () => Boolean(findEntry(readCollection({ config: project.config }).entries, FIXED_TODAY));
      for (let attempt = 0; attempt < 200 && !hasToday(); attempt += 1) {
        await flushMicrotasks();
      }
      assert.equal(hasToday(), true, '启动补写应写出今天日记');
      assert.equal(findEntry(readCollection({ config: project.config }).entries, FIXED_TODAY).date, FIXED_TODAY);
      assert.ok(fetchMock.calls.some((call) => String(call.url).endsWith('/messages')), '应调用模型');
      assert.ok(
        fetchMock.calls.some((call) => String(call.url).includes('/send_private_msg')),
        '写完后应按配置通知 owner（假 fetch）'
      );
    } finally {
      daemon?.stop();
    }
    assert.equal(fs.existsSync(project.config.lockFile), false, 'stop 后应释放单实例锁');
    assert.equal(daemon.scheduler.snapshot().stopped, true);
  });
});

describe('main 的纯参数分支（不读写真实项目文件）', () => {
  test('--help → 0，--unknown → 2', async () => {
    const help = await silenceConsole(() => main(['--help']));
    assert.equal(await help.value, 0);
    assert.ok(help.logs.join('\n').includes('用法'));

    const unknown = await silenceConsole(() => main(['--definitely-unknown']));
    assert.equal(await unknown.value, 2);
    assert.ok(unknown.errors.join('\n').includes('未知参数'));
  });
});
