// logger.js：脱敏规则、文件日志、secret 打码、contentHash 稳定性。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { redactText, maskSecrets, contentHash, createLogger } from '../src/logger.js';
import { cleanupTempRoots, mkTempRoot, FIXED_NOW } from './helpers.js';

after(cleanupTempRoots);

describe('redactText', () => {
  test('抹掉 Windows 盘符路径 / Unix 常见目录 / UNC 路径', () => {
    const windows = redactText('日志文件在 C:\\path\\x 里面');
    assert.ok(!windows.includes('C:\\path'), windows);
    assert.ok(windows.includes('[路径]'));

    const spaced = redactText('路径 C:\\Users\\x\\a.txt 结束');
    assert.ok(!spaced.includes('Users'), spaced);
    assert.ok(spaced.includes('[路径]'));

    const unix = redactText('打开 /home/user/secret.txt 看看');
    assert.ok(!unix.includes('/home/user'), unix);
    assert.ok(unix.includes('[路径]'));

    const unc = redactText('共享 \\\\server\\share\\file.txt 坏了');
    assert.ok(!unc.includes('server'), unc);
    assert.ok(unc.includes('[路径]'));
  });

  test('抹掉 sk- 密钥 / 32 位以上十六进制', () => {
    const key = redactText('key=sk-abcdefgh12345678');
    assert.ok(!key.includes('sk-abcdefgh12345678'), key);
    assert.ok(key.includes('[密钥]'));

    const hex = 'a'.repeat(32);
    const token = redactText(`token 是 ${hex}`);
    assert.ok(!token.includes(hex), token);
    assert.ok(token.includes('[令牌]'));
  });

  test('抹掉 token=... / token: ... 等凭据赋值', () => {
    const url = redactText('https://x/y?token=supersecret123&a=1');
    assert.ok(!url.includes('supersecret123'), url);
    assert.ok(!url.includes('token=supersecret123'), url);
    assert.ok(url.includes('[已隐藏]') || url.includes('token=***'), url);

    const assign = redactText('配置 token: abc123def');
    assert.ok(!assign.includes('abc123def'), assign);
    assert.ok(assign.includes('[已隐藏]'));

    const passwd = redactText('password=my-password-123');
    assert.ok(!passwd.includes('my-password-123'), passwd);
  });

  test('enabled=false 原样返回', () => {
    const raw = 'C:\\path\\x token=abc123';
    assert.equal(redactText(raw, { enabled: false }), raw);
    assert.notEqual(redactText(raw), raw);
  });
});

describe('maskSecrets', () => {
  test('已知敏感串被替换；短于 8 字符的忽略', () => {
    assert.equal(maskSecrets('前缀 SECRET-abcdef-123456 后缀', ['SECRET-abcdef-123456']), '前缀 *** 后缀');
    assert.equal(maskSecrets('abc', ['abc']), 'abc');
    assert.equal(maskSecrets('nothing here', ['zzzzzzzzzz']), 'nothing here');
    assert.equal(maskSecrets('a SECRET-b SECRET-a', ['SECRET-a']), 'a SECRET-b ***');
  });
});

describe('contentHash', () => {
  test('稳定、12 位十六进制、不同内容不同哈希', () => {
    const a = contentHash('今天很开心。');
    const b = contentHash('今天很开心。');
    const c = contentHash('今天不开心。');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{12}$/);
    assert.match(contentHash(null), /^[0-9a-f]{12}$/);
  });
});

describe('createLogger', () => {
  test('落盘文件名 qq-diary-YYYY-MM-DD.log，内容带时区时间戳', () => {
    const logDir = mkTempRoot();
    const logger = createLogger({ logDir, timeZone: 'Asia/Shanghai', now: () => FIXED_NOW, echo: false });
    logger.info('普通一行');
    logger.warn('警告一行');
    const file = path.join(logDir, 'qq-diary-2026-10-23.log');
    assert.ok(fs.existsSync(file));
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /\[23:35:00\] \[INFO\] 普通一行/);
    assert.match(content, /\[23:35:00\] \[WARN\] 警告一行/);
    assert.equal(logger.fileFor(FIXED_NOW), file);
  });

  test('注册 secret 后日志里不出现该串', () => {
    const logDir = mkTempRoot();
    const logger = createLogger({ logDir, now: () => FIXED_NOW, echo: false, secrets: ['known-secret-token-1'] });
    logger.info('启动，key=known-secret-token-1');
    logger.addSecret('later-secret-token-2');
    logger.info('后来又拿到 later-secret-token-2');
    const content = fs.readFileSync(logger.fileFor(FIXED_NOW), 'utf8');
    assert.ok(!content.includes('known-secret-token-1'), content);
    assert.ok(!content.includes('later-secret-token-2'), content);
    assert.ok(content.includes('***'));
    assert.equal(logger.secrets.includes('later-secret-token-2'), true);
  });

  test('redactText 也作用于日志正文（路径/密钥）', () => {
    const logDir = mkTempRoot();
    const logger = createLogger({ logDir, now: () => FIXED_NOW, echo: false });
    logger.info('文件 C:\\Users\\me\\diary.md 和 key sk-abcdefgh12345678');
    const content = fs.readFileSync(logger.fileFor(FIXED_NOW), 'utf8');
    assert.ok(!content.includes('Users'), content);
    assert.ok(!content.includes('sk-abcdefgh12345678'), content);
    assert.ok(content.includes('[路径]'));
    assert.ok(content.includes('[密钥]'));
  });

  test('minLevel 过滤 debug；多行消息压成一行', () => {
    const logDir = mkTempRoot();
    const logger = createLogger({ logDir, now: () => FIXED_NOW, echo: false, minLevel: 'info' });
    logger.debug('不该出现');
    logger.info('第一行\n第二行');
    const content = fs.readFileSync(logger.fileFor(FIXED_NOW), 'utf8');
    assert.ok(!content.includes('不该出现'));
    assert.ok(content.includes('第一行 ⏎ 第二行'));
  });

  test('logDir 为空时只回显不落盘；echo=false 时不打印', () => {
    const echoLogger = createLogger({ logDir: '', now: () => FIXED_NOW, echo: false });
    assert.equal(echoLogger.fileFor(), '');
    assert.doesNotThrow(() => echoLogger.info('无目录写入'));
  });
});
