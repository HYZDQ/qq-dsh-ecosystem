// 真机验收（COMPUTER_LIVE=1）：computer_* 方案全面操作抖音网页版。
// 安全边界：只做浏览与页面内导航（切换栏目/刷视频/搜索），绝不点赞/评论/发弹幕/私信。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerRuntime } from '../computer/runtime.mjs';
import { defaultPolicy } from '../computer/policy.mjs';

const live = process.env.COMPUTER_LIVE === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-douyin-'));
  const policy = {
    ...defaultPolicy(),
    apps: ['msedge.exe', 'Microsoft Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    control: { channel: 'private', adminIds: ['acceptance-owner'] },
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  return { stateDir, runtime: new ComputerRuntime({ stateDir }), actor: { channel: 'private', id: 'acceptance-owner' } };
}

async function confirmExec(runtime, name, args, actor) {
  const first = await runtime.execute(name, args, { actor });
  assert.equal(first.needsConfirm, true, `首次调用应返回 needsConfirm：${JSON.stringify(first)}`);
  const second = await runtime.execute(name, { ...args, confirmToken: first.confirmToken }, { actor });
  assert.equal(second.ok, true, `携带令牌的调用应成功：${JSON.stringify(second)}`);
  assert.ok(second.receiptId, `写动作必须有收据：${JSON.stringify(second)}`);
  return second;
}

function findByName(observed, name) {
  return observed.elements.find((item) => String(item.name).trim() === name) ?? null;
}

// windows-mcp 的窗口列表偶发/系统性漏行（现网已多次踩坑）：
// 一级：列表重试；二级：系统进程表拿标题，用 switch 按标题激活（走另一套 Windows API）。
async function findWindow(runtime, pattern, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const list = await runtime.execute('computer_windows', { action: 'list' });
    const win = (list.windows ?? []).find((item) => pattern.test(item.app));
    if (win) return win;
    await sleep(1200);
  }
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }'], { encoding: 'utf8', timeout: 15000 });
    const title = out.split('\n').map((line) => line.trim()).find((line) => pattern.test(line));
    if (title) return { app: title, handle: null, via: 'process-table' };
  } catch { /* 兜底也失败就返回 null */ }
  return null;
}

test('验收：电脑网页版抖音全面测试（观察/导航/刷视频/坐标点击/搜索）', { skip: !live, timeout: 420_000 }, async () => {
  const { runtime, actor } = setup();
  try {
    const started = await runtime.execute('computer_task_start', {
      goal: '网页版抖音浏览验收：观察性能、栏目切换、刷视频、图标坐标点击、搜索输入',
      budget: { maxSteps: 200, maxWrites: 80, maxWallMs: 600_000 },
    }, { actor });
    assert.equal(started.ok, true, JSON.stringify(started));

    // 1. 定位抖音窗口（没有就启动 Edge 并导航过去）
    let win = await findWindow(runtime, /抖音|douyin/i);
    if (!win) {
      let first = await runtime.execute('computer_windows', { action: 'launch', name: 'msedge.exe' }, { actor });
      if (first.needsConfirm) await runtime.execute('computer_windows', { action: 'launch', name: 'msedge.exe', confirmToken: first.confirmToken }, { actor });
      await sleep(3000);
      const keyFirst = await runtime.execute('computer_key', { keys: 'ctrl+l' }, { actor });
      await runtime.execute('computer_key', { keys: 'ctrl+l', confirmToken: keyFirst.confirmToken }, { actor });
      const obs0 = await runtime.execute('computer_observe', {});
      const addr = obs0.elements.find((item) => item.focused) ?? obs0.elements.find((item) => /地址/.test(String(item.name)));
      assert.ok(addr, '未定位到地址栏');
      await confirmExec(runtime, 'computer_type', { text: 'https://www.douyin.com/recommend=1', elementId: addr.id, replace: true }, actor);
      await confirmExec(runtime, 'computer_key', { keys: 'enter' }, actor);
      for (let i = 0; i < 6 && !win; i++) {
        await sleep(2500);
        win = await findWindow(runtime, /抖音|douyin/i, 2);
      }
    }
    assert.ok(win, '未找到抖音窗口');
    await confirmExec(runtime, 'computer_windows', { action: 'switch', name: win.app }, actor);
    await sleep(1000);
    // 悬浮置顶窗口会抢 UIA 焦点：切换后核实焦点确实在抖音，不在则重切。
    let focused = await runtime.execute('computer_observe', {});
    for (let i = 0; i < 3 && !/抖音|douyin/i.test(focused.activeWindow?.title ?? ''); i++) {
      await confirmExec(runtime, 'computer_windows', { action: 'switch', name: win.app }, actor);
      await sleep(1200);
      focused = await runtime.execute('computer_observe', {});
    }
    assert.match(focused.activeWindow?.title ?? '', /抖音|douyin/i, `切换后焦点不在抖音：${focused.activeWindow?.title}`);

    // 2. 观察性能与关键控件识别（对照截图：左栏导航、弹幕输入框、话题标签）
    const t0 = Date.now();
    const obs = await runtime.execute('computer_observe', {});
    const observeMs = Date.now() - t0;
    assert.equal(obs.ok, true, JSON.stringify(obs).slice(0, 300));
    assert.ok(observeMs < 5000, `观察耗时 ${observeMs}ms 超过 5 秒`);
    for (const key of ['推荐', '精选', '关注']) assert.ok(findByName(obs, key), `未识别导航「${key}」`);
    assert.ok((obs.elements ?? []).some((item) => /弹幕/.test(String(item.name))), '未识别弹幕输入框');
    console.log(`[观察] 耗时=${observeMs}ms 元素数=${obs.elements.length}`);

    // 3. 栏目切换：精选 → 推荐（页面内导航）
    await confirmExec(runtime, 'computer_click', { elementId: findByName(obs, '精选').id }, actor);
    await sleep(1500);
    const obs2 = await runtime.execute('computer_observe', {});
    assert.equal(obs2.ok, true);
    await confirmExec(runtime, 'computer_click', { elementId: findByName(obs2, '推荐').id ?? findByName(obs, '推荐').id }, actor);
    await sleep(1500);
    console.log('[导航] 精选/推荐 切换完成');

    // 4. 刷视频：向下切一条，验证内容变化（对比话题标签集合）
    const hashtags = (o) => (o.elements ?? []).filter((item) => /^#/.test(String(item.name))).map((item) => item.name).sort().join(',');
    let before = hashtags(await runtime.execute('computer_observe', {}));
    let switched = false;
    for (let i = 0; i < 3 && !switched; i++) {
      await confirmExec(runtime, 'computer_key', { keys: 'down' }, actor);
      await sleep(2000);
      const after = hashtags(await runtime.execute('computer_observe', {}));
      if (after && after !== before) { switched = true; before = after; }
    }
    assert.ok(switched, '连按三次向下未检测到视频内容变化');
    console.log('[刷视频] 内容变化已核实，当前话题：', before);

    // 5. 图标按钮盲区的坐标点击路径：点击视频区域中央（暂停/播放切换），截图留证。
    // 注：windows-mcp 的图像捕获在本机会挂起（>70s 无响应），computer_screen 尽力而为，
    // 失败时用测试脚手架的系统截图留证；点击本体以收据+回读核实为准。
    const center = await runtime.execute('computer_observe', {});
    const w = center.activeWindow?.width ?? 2582;
    const h = center.activeWindow?.height ?? 1622;
    const clicked = await confirmExec(runtime, 'computer_click', { x: Math.round(w * 0.55), y: Math.round(h * 0.5) }, actor);
    assert.equal(clicked.verified, true);
    await sleep(800);
    const saved = path.join(os.tmpdir(), `douyin-acceptance-${Date.now()}.png`);
    const screen = await runtime.execute('computer_screen', {});
    if ((screen.frames ?? []).length > 0) {
      fs.writeFileSync(saved, Buffer.from(screen.frames[0].data, 'base64'));
      console.log('[坐标点击] 完成，截图证据(computer_screen)：', saved);
    } else {
      const { execFileSync } = await import('node:child_process');
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save('${saved.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()`;
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 20000 });
      assert.ok(fs.existsSync(saved), '截图留证两条路径都失败');
      console.log('[坐标点击] 完成，截图证据(脚手架兜底，windows-mcp 截图挂起)：', saved);
    }

    // 6. 搜索输入链路：搜索框输入关键词并回车（只读浏览）
    const feed = await runtime.execute('computer_observe', {});
    const searchBox = (feed.elements ?? []).find((item) => /搜索你感兴趣|搜索内容/.test(String(item.name)))
      ?? (feed.elements ?? []).find((item) => item.role === '编辑' && /搜索/.test(String(item.name)));
    assert.ok(searchBox, `未定位搜索框：${JSON.stringify((feed.elements ?? []).map((e) => e.name))}`);
    await confirmExec(runtime, 'computer_type', { text: '猫咪', elementId: searchBox.id, replace: true }, actor);
    await confirmExec(runtime, 'computer_key', { keys: 'enter' }, actor);
    await sleep(2500);
    const searched = await runtime.execute('computer_observe', {});
    assert.equal(searched.ok, true);
    console.log('[搜索] 已执行，当前窗口：', searched.activeWindow?.title, '元素数：', searched.elements.length);

    // 7. 任务收口：全部写动作有收据
    const stopped = await runtime.execute('computer_task_stop', { completed: true }, { actor });
    assert.equal(stopped.status, 'done');
    const receipts = runtime.audit.recent(30).filter((item) => item.receiptId);
    assert.ok(receipts.length >= 8, `收据不足：${receipts.length}`);
    console.log(`[验收通过] 抖音网页版全面测试，收据 ${receipts.length} 张`);
  } finally {
    await runtime.dispose();
  }
});
