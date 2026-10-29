// context.js：上下文采集（私聊优先预算、群聊采样、脱敏、时间窗、降级）与角色加载。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import {
  readJsonFileSafe,
  classifyConversation,
  cleanMessageText,
  isPlaceholderOnly,
  normalizeMessages,
  pickEvenly,
  fitLines,
  loadRole,
  readActivityLog,
  collectContext
} from '../src/context.js';
import {
  cleanupTempRoots,
  createProject,
  conversation,
  msg,
  countMatches,
  mkTempRoot,
  writeTextFile,
  writeJsonFile,
  FIXED_NOW,
  FIXED_TODAY,
  OWNER_QQ,
  GROUP_ID
} from './helpers.js';

after(cleanupTempRoots);

const collect = (project, extra = {}) =>
  collectContext({ config: project.config, facts: project.facts, dateKey: FIXED_TODAY, now: project.now, ...extra });

describe('collectContext：正常路径与预算', () => {
  test('owner 私聊 + 群聊都能进上下文，私聊在群聊前面，总长 ≤ maxContextChars', () => {
    const project = createProject({
      social: {
        paused: false,
        conversations: {
          [`private:${OWNER_QQ}`]: conversation([msg('主人私聊 alpha', 60)]),
          [`group:${GROUP_ID}`]: conversation([msg('群聊内容 beta', 30)])
        }
      }
    });
    const context = collect(project);
    assert.equal(context.empty, false);
    assert.ok(context.text.includes('alpha'), context.text);
    assert.ok(context.text.includes('beta'), context.text);
    const ownerIndex = context.text.indexOf('【主人私聊】');
    const groupIndex = context.text.indexOf('【群聊');
    assert.ok(ownerIndex >= 0, '应包含主人私聊段落');
    assert.ok(groupIndex > ownerIndex, '私聊段落应排在群聊之前');
    assert.ok(context.chars <= project.config.maxContextChars);
    assert.equal(context.stats.ownerPrivateMessages, 1);
    assert.equal(context.stats.groups, 1);
    assert.equal(context.stats.windowKind ?? context.stats.kind, 'rolling');
  });

  test('私聊优先：maxContextChars 很小时私聊仍占主要预算，群聊被裁', () => {
    const ownerMessages = [];
    for (let index = 0; index < 20; index += 1) {
      ownerMessages.push(msg(`p-msg-${String(index).padStart(2, '0')} 今天主人和我说了很多很多话，我认真听着。`, 60 - index));
    }
    const groupMessages = [];
    for (let index = 0; index < 40; index += 1) {
      groupMessages.push(msg(`g-msg-${String(index).padStart(2, '0')} 群里在聊一些无关紧要的小事。`, 40 - index * 0.5));
    }
    const project = createProject({
      config: { maxContextChars: 500, privateShare: 0.6 },
      social: {
        conversations: {
          [`private:${OWNER_QQ}`]: conversation(ownerMessages),
          [`group:${GROUP_ID}`]: conversation(groupMessages)
        }
      }
    });
    const context = collect(project);
    assert.equal(context.empty, false);
    assert.ok(context.stats.privateChars > 0, `privateChars=${context.stats.privateChars}`);
    assert.ok(context.stats.privateChars >= 200, `privateChars=${context.stats.privateChars}`);
    assert.ok(countMatches(context.text, /p-msg-\d{2}/g) > 0);
    assert.ok(countMatches(context.text, /g-msg-\d{2}/g) < 40, '群聊消息应被裁掉一部分');
    assert.ok(context.chars <= 500, `chars=${context.chars}`);
  });

  test('群聊很多消息时等距采样：条数变少且保留最新一条', () => {
    const groupMessages = [];
    for (let index = 0; index < 100; index += 1) {
      groupMessages.push(msg(`m-${String(index).padStart(3, '0')}`, 100 - index));
    }
    const project = createProject({
      config: { maxContextChars: 1000 },
      social: { conversations: { [`group:${GROUP_ID}`]: conversation(groupMessages) } }
    });
    const context = collect(project);
    const picked = countMatches(context.text, /m-\d{3}/g);
    assert.ok(picked > 0, context.text);
    assert.ok(picked < 100, `应被采样，实际 ${picked} 条`);
    assert.ok(picked >= 20, `采样条数 ${picked} 偏少`);
    assert.ok(context.text.includes('m-099'), '必须保留最新一条');
    assert.ok(context.text.includes('【群聊'));
  });

  test('其他私聊默认排除（includeOtherPrivates=false）；打开后出现', () => {
    const social = {
      conversations: {
        [`private:${OWNER_QQ}`]: conversation([msg('主人私聊内容', 30)]),
        'private:20002': conversation([msg('other-secret-text-9', 20)])
      }
    };
    const excluded = collect(createProject({ social }));
    assert.ok(!excluded.text.includes('other-secret-text-9'), excluded.text);
    assert.equal(excluded.stats.otherPrivatesExcluded, 1);

    const included = collect(createProject({ config: { includeOtherPrivates: true }, social }));
    assert.ok(included.text.includes('other-secret-text-9'), included.text);
    assert.equal(included.stats.otherPrivatesExcluded, 0);
  });

  test('纯媒体 / 空文本消息被过滤，但计入 media 统计', () => {
    const project = createProject({
      social: {
        conversations: {
          [`private:${OWNER_QQ}`]: conversation([
            msg('[图片]', 10, { hasMedia: true }),
            msg('', 20, { hasMedia: true }),
            msg('[视频]', 15),
            msg('真正内容 gamma', 30)
          ])
        }
      }
    });
    const context = collect(project);
    assert.ok(context.text.includes('gamma'), context.text);
    assert.ok(!context.text.includes('[图片]'), context.text);
    assert.equal(context.stats.media, 2);
    assert.equal(context.stats.messages, 1);
  });

  test('超大上下文会被裁剪到 maxContextChars 以内', () => {
    const longText = '很长的一段聊天内容，'.repeat(10);
    const ownerMessages = [];
    const groupMessages = [];
    for (let index = 0; index < 30; index += 1) {
      ownerMessages.push(msg(`${index} ${longText}`, 60 - index));
      groupMessages.push(msg(`g${index} ${longText}`, 40 - index * 0.5));
    }
    const project = createProject({
      config: { maxContextChars: 500 },
      social: {
        conversations: {
          [`private:${OWNER_QQ}`]: conversation(ownerMessages),
          [`group:${GROUP_ID}`]: conversation(groupMessages)
        }
      }
    });
    const context = collect(project);
    assert.equal(context.empty, false);
    assert.ok(context.chars <= 500, `chars=${context.chars}`);
    // 硬裁剪后 privateChars 必须同步收窄，不能超过最终文本长度
    assert.ok(context.stats.privateChars <= context.chars, `privateChars=${context.stats.privateChars} > chars=${context.chars}`);
  });

  test('单条消息按码点截断，不切断 emoji 代理对', () => {
    const project = createProject({
      config: { maxMessageChars: 20 },
      social: {
        conversations: {
          [`private:${OWNER_QQ}`]: conversation([msg(`${'😀'.repeat(25)} 尾巴`, 10)])
        }
      }
    });
    const context = collect(project);
    assert.equal(countMatches(context.text, /😀/g), 20);
    assert.ok(context.text.includes('…'));
    // 不应出现孤立代理项（截半的 emoji）
    const loneSurrogate = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;
    assert.equal(loneSurrogate.test(context.text), false, '不应出现孤立代理项');
  });

  test('支持旧日期（整日窗口），窗口外老消息不进入上下文', () => {
    const now = new Date('2026-10-23T12:00:00+08:00');
    const project = createProject({
      social: {
        conversations: {
          [`group:${GROUP_ID}`]: {
            recentMessages: [
              { time: Date.parse('2026-10-20T10:00:00+08:00'), text: '窗口前 old-before' },
              { time: Date.parse('2026-10-21T10:00:00+08:00'), text: '窗口内 in-window-1' },
              { time: Date.parse('2026-10-21T23:59:00+08:00'), text: '窗口内 in-window-2' },
              { time: Date.parse('2026-10-22T10:00:00+08:00'), text: '窗口后 old-after' }
            ]
          }
        }
      }
    });
    const context = collectContext({ config: project.config, facts: project.facts, dateKey: '2026-10-21', now });
    assert.ok(context.text.includes('in-window-1'), context.text);
    assert.ok(context.text.includes('in-window-2'), context.text);
    assert.ok(!context.text.includes('old-before'), context.text);
    assert.ok(!context.text.includes('old-after'), context.text);
    assert.equal(context.stats.windowStart, Date.parse('2026-10-21T00:00:00+08:00'));
    assert.equal(context.stats.windowEnd, Date.parse('2026-10-22T00:00:00+08:00'));
    assert.equal(context.stats.kind, 'fullDay');
  });

  test('脱敏：消息里的路径 / token 被替换成占位符', () => {
    const raw = String.raw`文件在 C:\Users\x\a.txt 里，token: abc123 别外传`;
    const project = createProject({
      social: { conversations: { [`private:${OWNER_QQ}`]: conversation([msg(raw, 10)]) } }
    });
    const context = collect(project);
    assert.ok(!context.text.includes('Users'), context.text);
    assert.ok(!context.text.includes('abc123'), context.text);
    assert.ok(context.text.includes('[路径]'), context.text);
    assert.ok(context.text.includes('[已隐藏]'), context.text);
  });
});

describe('collectContext：降级路径', () => {
  test('social-v2.json 缺失 → empty:true，不抛异常，stats 字段完整', () => {
    const project = createProject();
    assert.doesNotThrow(() => collect(project));
    const context = collect(project);
    assert.equal(context.empty, true);
    assert.equal(context.chars, 0);
    assert.equal(context.text, '');
    assert.ok(context.errors.length >= 1);
    const stats = context.stats;
    for (const field of [
      'windowStart',
      'windowEnd',
      'kind',
      'conversations',
      'messages',
      'media',
      'ownerPrivateMessages',
      'groups',
      'otherPrivatesExcluded',
      'activityLines',
      'topics',
      'impressions',
      'chars',
      'budget',
      'privateChars'
    ]) {
      assert.ok(Object.hasOwn(stats, field), `空上下文 stats 缺少字段 ${field}`);
    }
    assert.equal(stats.privateChars, 0);
    assert.equal(stats.chars, 0);
    assert.equal(stats.budget, project.config.maxContextChars);
    assert.equal(stats.ownerPrivateMessages, 0);
    assert.equal(stats.groups, 0);
    assert.equal(stats.topics, 0);
    assert.ok(context.errors.some((item) => item.includes('missing') || item.includes('缺失')));
  });

  test('social-v2.json 损坏 → empty:true 且 errors 有内容', () => {
    const project = createProject();
    writeTextFile(project.socialPath, '{ 这不是合法 JSON');
    const context = collect(project);
    assert.equal(context.empty, true);
    assert.ok(context.errors.length >= 1);
    assert.ok(context.errors.some((item) => item.includes('读取失败')));
  });

  test('未来日期 → 降级为 empty 且记录错误（不抛异常）', () => {
    const project = createProject();
    const context = collectContext({
      config: project.config,
      facts: project.facts,
      dateKey: '2026-10-24',
      now: FIXED_NOW
    });
    assert.equal(context.empty, true);
    assert.ok(context.errors.some((item) => item.includes('未来')));
  });

  test('无任何消息（会话为空）→ empty:true', () => {
    const project = createProject({ social: { conversations: { [`group:${GROUP_ID}`]: conversation([]) } } });
    const context = collect(project);
    assert.equal(context.empty, true);
    assert.equal(context.chars, 0);
  });
});

describe('context 辅助函数', () => {
  test('classifyConversation：owner / group / 其他私聊 / 忽略', () => {
    assert.equal(classifyConversation(`private:${OWNER_QQ}`, OWNER_QQ), 'owner');
    assert.equal(classifyConversation('group:30001', OWNER_QQ), 'group');
    assert.equal(classifyConversation('private:20002', OWNER_QQ), 'excludedPrivate');
    assert.equal(classifyConversation('private:20002', OWNER_QQ, true), 'otherPrivate');
    assert.equal(classifyConversation('', OWNER_QQ), 'ignored');
    assert.equal(classifyConversation('weird:1', OWNER_QQ), 'ignored');
  });

  test('cleanMessageText / isPlaceholderOnly', () => {
    assert.equal(cleanMessageText('  a   b  '), 'a b');
    assert.equal(cleanMessageText('[表情12]'), '[表情]');
    assert.equal(cleanMessageText('[动画表情]'), '[表情]');
    assert.equal(cleanMessageText('[转发消息 id=abc]'), '[转发消息]');
    assert.equal(isPlaceholderOnly('[图片]'), true);
    assert.equal(isPlaceholderOnly('[图片][表情]'), true);
    assert.equal(isPlaceholderOnly(''), true);
    assert.equal(isPlaceholderOnly('真消息'), false);
  });

  test('normalizeMessages：时间窗过滤 + owner 的 who 归一', () => {
    const conversationData = {
      recentMessages: [
        { time: 1000, text: '早' },
        { time: 2000, text: '我发的', isSelf: true },
        { time: 3000, text: '超窗', isSelf: false }
      ]
    };
    const { messages } = normalizeMessages(conversationData, { start: 0, end: 3000, who: 'owner' });
    assert.deepEqual(messages.map((item) => item.text), ['早', '我发的']);
    assert.deepEqual(messages.map((item) => item.who), ['主人', '我']);
  });

  test('pickEvenly：覆盖首尾、等距、count=1 保最新', () => {
    const list = Array.from({ length: 10 }, (_, index) => ({ time: index }));
    assert.deepEqual(pickEvenly(list, 3).map((item) => item.time), [0, 5, 9]);
    assert.deepEqual(pickEvenly(list, 1).map((item) => item.time), [9]);
    assert.equal(pickEvenly(list, 100).length, 10);
  });

  test('fitLines：预算内从最新往前装，超小预算至少保留最新一条', () => {
    const messages = [
      { time: 1, text: 'a' },
      { time: 2, text: 'b' }
    ];
    const render = (item) => `${item.time}:${item.text}`;
    const all = fitLines(messages, 100, render);
    assert.deepEqual(all.lines, ['1:a', '2:b']);
    const tiny = fitLines(messages, 3, render);
    assert.equal(tiny.lines.length, 1);
    assert.ok(tiny.lines[0].endsWith('b'));
  });

  test('readJsonFileSafe：缺失 / 损坏 / 正常（用注入 sleep 跳过等待）', () => {
    const root = mkTempRoot();
    const missing = readJsonFileSafe(path.join(root, 'none.json'), { sleep: () => {} });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'missing');

    const broken = path.join(root, 'broken.json');
    fs.writeFileSync(broken, '{ nope', 'utf8');
    const bad = readJsonFileSafe(broken, { sleep: () => {} });
    assert.equal(bad.ok, false);
    assert.ok(bad.error);

    const good = path.join(root, 'good.json');
    writeJsonFile(good, { hello: '世界' });
    const ok = readJsonFileSafe(good, { sleep: () => {} });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.hello, '世界');
  });

  test('readActivityLog：读取尾部行；缺失返回 missing', () => {
    const root = mkTempRoot();
    const bridgeDir = path.join(root, 'qq-bridge');
    writeTextFile(path.join(bridgeDir, 'state', 'qq-activity.log'), 'line1\nline2\nline3\n');
    const tail = readActivityLog({ qqBridgeDir: bridgeDir, lines: 2 });
    assert.equal(tail.ok, true);
    assert.deepEqual(tail.lines, ['line2', 'line3']);

    const missing = readActivityLog({ qqBridgeDir: path.join(root, 'nope'), lines: 2 });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'missing');
  });
});

describe('collectContext：话题 / 印象 / 活动日志 / 开关', () => {
  test('activeTopics、pendingThoughts、memberImpressions、qq-activity.log 都进入上下文', () => {
    const project = createProject({
      social: {
        conversations: {
          [`private:${OWNER_QQ}`]: {
            recentMessages: [msg('主人说晚安', 30)],
            activeTopics: [{ text: '周末去哪里玩', participants: ['阿蓝', '小莓'] }],
            pendingThoughts: [{ text: '想问问主人明天有没有空' }],
            memberImpressions: { 小莓: { traits: ['爱笑', '嘴硬心软'] } }
          }
        }
      }
    });
    writeTextFile(
      path.join(project.bridgeDir, 'state', 'qq-activity.log'),
      `${FIXED_TODAY} 12:00 主人让我记得早点睡\n${FIXED_TODAY} 18:00 群里的消息变少了\n`
    );
    const context = collect(project);
    assert.ok(context.text.includes('【近期话题】'), context.text);
    assert.ok(context.text.includes('周末去哪里玩'), context.text);
    assert.ok(context.text.includes('想问问主人明天有没有空'), context.text);
    assert.ok(context.text.includes('阿蓝、小莓'), context.text);
    assert.ok(context.text.includes('【我记住的人】'), context.text);
    assert.ok(context.text.includes('小莓：爱笑；嘴硬心软'), context.text);
    assert.ok(context.text.includes('【最近活动】'), context.text);
    assert.ok(context.stats.topics >= 1);
    assert.ok(context.stats.impressions >= 1);
    assert.ok(context.stats.activityLines >= 1);
  });

  test('includeGroups=false → 群聊不进入上下文', () => {
    const project = createProject({
      config: { includeGroups: false },
      social: {
        conversations: {
          [`private:${OWNER_QQ}`]: conversation([msg('主人私聊的内容', 30)]),
          [`group:${GROUP_ID}`]: conversation([msg('群聊不该出现的内容', 20)])
        }
      }
    });
    const context = collect(project);
    assert.ok(context.text.includes('主人私聊的内容'));
    assert.ok(!context.text.includes('群聊不该出现的内容'), context.text);
    assert.equal(context.stats.groups, 1);
  });

  test('maxMessageChars 会截断单条过长消息', () => {
    const project = createProject({
      config: { maxMessageChars: 20 },
      social: {
        conversations: {
          [`private:${OWNER_QQ}`]: conversation([msg('甲'.repeat(200), 10)])
        }
      }
    });
    const context = collect(project);
    assert.ok(!context.text.includes('甲'.repeat(30)), '超长消息应被截断');
    assert.ok(context.text.includes('…'), context.text);
    assert.ok(countMatches(context.text, /甲/g) <= 21);
  });
});

describe('loadRole', () => {
  test('正常：current-role.json + roles/<role>.md', () => {
    const project = createProject();
    const role = loadRole({ qqBridgeDir: project.bridgeDir, maxRoleChars: 3000 });
    assert.equal(role.role, '蓝莓球');
    assert.equal(role.ok, true);
    assert.ok(role.roleText.includes('蓝莓球'));
    assert.equal(role.mode, 'reserved2');
    assert.deepEqual(role.errors, []);
  });

  test('缺失 current-role.json / roles 文件 → 降级为「助手」且不抛', () => {
    const emptyDir = mkTempRoot();
    const role = loadRole({ qqBridgeDir: emptyDir, maxRoleChars: 3000 });
    assert.equal(role.role, '助手');
    assert.equal(role.ok, false);
    assert.equal(role.roleText, '');
    assert.ok(role.errors.length >= 1);
  });

  test('有 role 但没有角色文件 → 保留 role，roleText 为空、ok:false', () => {
    const root = mkTempRoot();
    const bridgeDir = path.join(root, 'qq-bridge');
    writeJsonFile(path.join(bridgeDir, 'state', 'current-role.json'), { role: '不存在的角色' });
    const role = loadRole({ qqBridgeDir: bridgeDir });
    assert.equal(role.role, '不存在的角色');
    assert.equal(role.ok, false);
    assert.ok(role.errors.some((item) => item.includes('roles')));
  });

  test('「人格分裂」双槽位：日记固定读私聊卡（roles.private），忽略群聊卡', () => {
    const root = mkTempRoot();
    const bridgeDir = path.join(root, 'qq-bridge');
    writeJsonFile(path.join(bridgeDir, 'state', 'current-role.json'), {
      split: true,
      role: '私聊卡',
      roles: { group: '群聊卡', private: '私聊卡' },
    });
    writeTextFile(path.join(bridgeDir, 'roles', '私聊卡.md'), '# 私聊卡\n私聊人设内容');
    writeTextFile(path.join(bridgeDir, 'roles', '群聊卡.md'), '# 群聊卡\n群聊人设内容');
    const role = loadRole({ qqBridgeDir: bridgeDir });
    assert.equal(role.role, '私聊卡', '日记应读私聊槽');
    assert.ok(role.roleText.includes('私聊人设内容'));
    assert.ok(!role.roleText.includes('群聊人设内容'), '群聊卡不应进日记');
    assert.equal(role.ok, true);
  });

  test('「人格分裂」双槽位但私聊槽为空 → 回退 role 字段（兼容镜像）', () => {
    const root = mkTempRoot();
    const bridgeDir = path.join(root, 'qq-bridge');
    writeJsonFile(path.join(bridgeDir, 'state', 'current-role.json'), {
      split: true,
      role: '私聊卡',
      roles: { group: '群聊卡', private: null },
    });
    writeTextFile(path.join(bridgeDir, 'roles', '私聊卡.md'), '# 私聊卡\n私聊人设内容');
    const role = loadRole({ qqBridgeDir: bridgeDir });
    assert.equal(role.role, '私聊卡');
    assert.ok(role.roleText.includes('私聊人设内容'));
  });
});
