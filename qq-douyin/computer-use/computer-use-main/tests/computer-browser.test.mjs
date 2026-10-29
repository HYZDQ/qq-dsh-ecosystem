// B 方案（computer_browser_*）单测：domains fail-closed 白名单、驱动 DOM 语义、ref 稳定、
// runtime 全流程（L0 免确认 / L1 两段式 + 收据 / 闸门拒绝路径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBrowserDomainAllowed, checkBrowserWriteAllowed, defaultPolicy } from '../computer/policy.mjs';
import { BrowserDriver } from '../computer/browser-driver.mjs';
import { ComputerRuntime } from '../computer/runtime.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const actor = { channel: 'private', id: '12345' };

function fakePage({ startUrl = 'https://www.douyin.com/video/1', startTitle = '抖音 - 测试' } = {}) {
  const state = { url: startUrl, title: startTitle };
  const calls = [];
  const elements = [
    { tag: 'button', name: '点赞', href: '', type: '', occurrence: 0, x: 10, y: 20 },
    { tag: 'input', name: '搜索', href: '', type: 'text', occurrence: 0, x: 30, y: 40 },
    { tag: 'button', name: '点赞', href: '', type: '', occurrence: 1, x: 50, y: 60 },
  ];
  return {
    calls, state,
    url: () => state.url,
    title: async () => state.title,
    isClosed: () => false,
    async evaluate(js) {
      calls.push(String(js));
      if (String(js).includes('location.href')) return { url: state.url, title: state.title, elements };
      return true;
    },
    async goto(next) { calls.push(`goto:${next}`); state.url = next; },
    async waitForEvent() { return null; },
  };
}

test('domains 白名单（§6.3 目标白名单）：空=拒绝，后缀匹配，解析失败拒绝', () => {
  const base = { ...defaultPolicy(), domains: [] };
  assert.throws(() => checkBrowserDomainAllowed(base, 'https://www.douyin.com/'), (e) => e.code === 'TARGET_NOT_ALLOWED');
  const ok = { ...defaultPolicy(), domains: ['douyin.com'] };
  assert.equal(checkBrowserDomainAllowed(ok, 'https://www.douyin.com/video/1'), true);
  assert.equal(checkBrowserDomainAllowed(ok, 'https://live.douyin.com/'), true);
  assert.throws(() => checkBrowserDomainAllowed(ok, 'https://evil.com/'), (e) => e.code === 'TARGET_NOT_ALLOWED');
  assert.throws(() => checkBrowserDomainAllowed(ok, 'not-a-url'), (e) => e.code === 'TARGET_NOT_ALLOWED');
});

test('网页写闸门：STOP 急停与标题黑名单同样生效', () => {
  const stateDir = tmp('browser-gate-');
  fs.mkdirSync(stateDir, { recursive: true });
  const policy = { ...defaultPolicy(), domains: ['douyin.com'] };
  assert.equal(checkBrowserWriteAllowed(policy, stateDir, { title: '抖音', url: 'https://www.douyin.com/' }), true);
  assert.throws(() => checkBrowserWriteAllowed(policy, stateDir, { title: '网上银行', url: 'https://www.douyin.com/' }), (e) => e.code === 'TITLE_DENIED');
  fs.writeFileSync(path.join(stateDir, 'STOP'), 'x');
  assert.throws(() => checkBrowserWriteAllowed(policy, stateDir, { title: '抖音', url: 'https://www.douyin.com/' }), (e) => e.code === 'COMPUTER_DISABLED');
});

test('BrowserDriver：ref 跨观察稳定，click/fill 走原生 evaluate，open 只收 http(s)', async () => {
  const page = fakePage();
  const driver = new BrowserDriver({ getPage: async () => page, stateDir: tmp('browser-drv-') });
  const first = await driver.observe({});
  const second = await driver.observe({});
  assert.equal(first.perceptionPath, 'dom');
  assert.deepEqual(first.elements.map((el) => el.ref), second.elements.map((el) => el.ref), 'ref 跨观察稳定');
  assert.notEqual(first.elements[0].ref, first.elements[2].ref, '同名不同序号是不同元素');

  const clicked = await driver.click({ ref: first.elements[0].ref });
  assert.equal(clicked.clicked, true);
  assert.ok(page.calls.some((js) => String(js).includes('el.click()')), '点击走原生 element.click()');

  const filled = await driver.fill({ ref: first.elements[1].ref, text: '你好' });
  assert.equal(filled.filled, true);
  assert.ok(page.calls.some((js) => String(js).includes('dispatchEvent')));

  await assert.rejects(() => driver.open({ url: 'javascript:alert(1)' }), (e) => e.code === 'INPUT_UNSUPPORTED');
  await driver.open({ url: 'https://www.douyin.com/user/1' });
  assert.equal(page.state.url, 'https://www.douyin.com/user/1');
});

test('runtime：observe L0 免确认；click L1 两段式 + 收据；闸门拒绝路径', async () => {
  const stateDir = tmp('browser-rt-');
  const policy = { ...defaultPolicy(), domains: ['douyin.com'], control: { channel: 'private', adminIds: ['12345'] } };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  const page = fakePage();
  const runtime = new ComputerRuntime({
    stateDir,
    driverFactory: () => { throw new Error('网页测试不应启动桌面驱动'); },
    sessionProbe: () => false,
    browserDriver: new BrowserDriver({ getPage: async () => page, stateDir }),
  });

  const observed = await runtime.execute('computer_browser_observe', {});
  assert.equal(observed.ok, true);
  assert.equal(observed.elements.length, 3);
  assert.equal(observed.needsConfirm, undefined, 'L0 观察免确认');

  const ref = observed.elements[0].ref;
  const first = await runtime.execute('computer_browser_click', { ref }, { actor });
  assert.equal(first.needsConfirm, true, JSON.stringify(first));
  const done = await runtime.execute('computer_browser_click', { ref, confirmToken: first.confirmToken }, { actor });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.ok(done.receiptId, 'L1 必有收据');
  assert.equal(done.verified, true);

  // 闸门：非管理员 / 域名不在白名单
  const group = await runtime.execute('computer_browser_click', { ref }, { actor: { channel: 'group', id: '12345' } });
  assert.equal(group.code, 'NOT_ADMIN');
  const offSite = await runtime.execute('computer_browser_open', { url: 'https://evil.com/' }, { actor });
  assert.equal(offSite.code, 'TARGET_NOT_ALLOWED', JSON.stringify(offSite));
  await runtime.dispose();

  // domains 空 = 全拒（fail-closed）
  const dir2 = tmp('browser-rt2-');
  const p2 = { ...defaultPolicy(), domains: [], control: { channel: 'private', adminIds: ['12345'] } };
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'policy.json'), JSON.stringify(p2));
  const rt2 = new ComputerRuntime({
    stateDir: dir2, driverFactory: () => { throw new Error('不应启动'); }, sessionProbe: () => false,
    browserDriver: new BrowserDriver({ getPage: async () => fakePage(), stateDir: dir2 }),
  });
  const denied = await rt2.execute('computer_browser_click', { ref: 'b-x' }, { actor });
  assert.equal(denied.code, 'TARGET_NOT_ALLOWED');
  await rt2.dispose();
});
