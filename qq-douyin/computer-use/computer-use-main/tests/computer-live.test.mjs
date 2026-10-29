// 真机验收（COMPUTER_LIVE=1 才执行）：打开记事本 → 输入 → 保存，全部经由 computer_* 工具与真实 windows-mcp 驱动。
// 前置：已安装 uv（uvx 在 PATH 或 DOUYIN_COMPUTER_UVX 指定绝对路径），桌面会话未锁屏。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ComputerRuntime } from '../computer/runtime.mjs';
import { defaultPolicy } from '../computer/policy.mjs';

const live = process.env.COMPUTER_LIVE === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function confirmExec(runtime, name, args, actor) {
  const first = await runtime.execute(name, args, { actor });
  assert.equal(first.needsConfirm, true, `首次调用应返回 needsConfirm：${JSON.stringify(first)}`);
  const second = await runtime.execute(name, { ...args, confirmToken: first.confirmToken }, { actor });
  assert.equal(second.ok, true, `携带令牌的调用应成功：${JSON.stringify(second)}`);
  assert.ok(second.receiptId, `写动作必须有收据：${JSON.stringify(second)}`);
  return second;
}

test('验收：打开记事本 → 输入 → 保存（真实桌面，仅 COMPUTER_LIVE=1）', { skip: !live, timeout: 300_000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-live-'));
  const policy = {
    ...defaultPolicy(),
    apps: ['notepad', 'notepad.exe', 'C:\\Windows\\System32\\notepad.exe', '记事本'],
    control: { channel: 'private', adminIds: ['acceptance-owner'] },
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  const runtime = new ComputerRuntime({ stateDir });
  const actor = { channel: 'private', id: 'acceptance-owner' };
  try {
    // 0. 9.3 红线：群聊/非管理员发起桌面写操作一律 NOT_ADMIN。
    const group = await runtime.execute('computer_click', { label: 0 }, { actor: { channel: 'group', id: 'acceptance-owner' } });
    assert.equal(group.code, 'NOT_ADMIN', JSON.stringify(group));
    const stranger = await runtime.execute('computer_click', { label: 0 }, { actor: { channel: 'private', id: '999' } });
    assert.equal(stranger.code, 'NOT_ADMIN', JSON.stringify(stranger));

    // 1. 打开记事本（启动名多候选；单实例应用可能复用已有窗口）。
    // 安全规则：只操作「无标题/Untitled」窗口（优先本次新打开的），绝不触碰用户已有文件窗口。
    const baseline = await runtime.execute('computer_windows', { action: 'list' });
    const baselineHandles = new Set((baseline.windows ?? []).filter((item) => /记事本|notepad/i.test(item.app)).map((item) => item.handle));
    const pickUntitled = (list) => (list.windows ?? [])
      .filter((item) => /记事本|notepad/i.test(item.app) && /^无标题|Untitled/i.test(item.app))
      .sort((a, b) => Number(baselineHandles.has(a.handle)) - Number(baselineHandles.has(b.handle)))[0] ?? null;
    let launched = null;
    let lastList = baseline;
    for (const name of ['C:\\Windows\\System32\\notepad.exe', 'notepad.exe', 'notepad', '记事本']) {
      const first = await runtime.execute('computer_windows', { action: 'launch', name }, { actor });
      if (!first.needsConfirm) { console.log(`[launch 跳过] ${name}: ${JSON.stringify(first)}`); continue; }
      const second = await runtime.execute('computer_windows', { action: 'launch', name, confirmToken: first.confirmToken }, { actor });
      console.log(`[launch] ${name}: ${JSON.stringify(second)}`);
      for (let i = 0; i < 4; i++) {
        await sleep(1500);
        lastList = await runtime.execute('computer_windows', { action: 'list' });
        if (pickUntitled(lastList)) { launched = name; break; }
      }
      if (launched) break;
    }

    // 2. 只选无标题窗口（优先本次新打开的），确保在前台后再观察并定位编辑区。
    const notepadWindow = pickUntitled(lastList);
    assert.ok(notepadWindow, `未找到可安全操作的无标题记事本窗口，窗口列表：${JSON.stringify(lastList.windows?.map((item) => item.app))}`);
    let observed = await runtime.execute('computer_observe', {});
    if (observed.activeWindow?.handle !== notepadWindow.handle) {
      await confirmExec(runtime, 'computer_windows', { action: 'switch', name: notepadWindow.app }, actor);
      await sleep(800);
      observed = await runtime.execute('computer_observe', {});
    }
    assert.equal(observed.ok, true, JSON.stringify(observed));
    assert.equal(observed.activeWindow?.handle, notepadWindow.handle, `切换窗口失败：${JSON.stringify(observed.activeWindow)}`);
    const editor = observed.elements.find((item) => /编辑|文本|Document|Edit/i.test(`${item.role} ${item.name}`))
      ?? observed.elements.find((item) => item.focused);
    assert.ok(editor, `未定位到编辑区：${JSON.stringify(observed.elements)}`);

    // 3. 输入验收文本（两段式确认 + 收据回读）。
    const marker = `电脑操控验收 ${Date.now()}`;
    const typed = await confirmExec(runtime, 'computer_type', { text: marker, elementId: editor.id, replace: true }, actor);

    // 4. ctrl+s → 另存为 → 文件名输入完整路径 → 回车保存。
    await confirmExec(runtime, 'computer_key', { keys: 'ctrl+s' }, actor);
    await sleep(1500);
    const dialog = await runtime.execute('computer_observe', {});
    const nameField = dialog.elements.find((item) => /文件名|文件名称|File name/i.test(item.name))
      ?? dialog.elements.find((item) => item.focused);
    assert.ok(nameField, `未定位到文件名输入框：${JSON.stringify(dialog.elements)}`);
    const savePath = path.join(os.tmpdir(), `computer-p0-acceptance-${Date.now()}.txt`);
    await confirmExec(runtime, 'computer_type', { text: savePath, elementId: nameField.id, replace: true }, actor);
    await confirmExec(runtime, 'computer_key', { keys: 'enter' }, actor);
    await sleep(2000);

    // 5. 回读核实：文件真实落盘且含验收文本；收据已核实。
    assert.ok(fs.existsSync(savePath), `保存失败，文件不存在：${savePath}`);
    const content = fs.readFileSync(savePath, 'utf8');
    assert.ok(content.includes(marker), `保存内容不符：${content.slice(0, 100)}`);
    const receipts = runtime.audit.recent(20);
    assert.ok(receipts.some((item) => item.tool === 'computer_type' && item.verified === true), JSON.stringify(receipts));
    assert.equal(typed.ok, true);

    console.log(`[验收通过] 启动=${launched} 保存=${savePath} 收据数=${receipts.length}`);
  } finally {
    await runtime.dispose();
  }
});

// ── P1 真机验收：任务运行时 + 跨应用 ────────────────────────────────────────

function liveSetup(apps) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-live-'));
  const policy = {
    ...defaultPolicy(),
    apps,
    control: { channel: 'private', adminIds: ['acceptance-owner'] },
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  const runtime = new ComputerRuntime({ stateDir });
  return { stateDir, runtime, actor: { channel: 'private', id: 'acceptance-owner' } };
}

async function launchApp(runtime, actor, candidates, titlePattern, switchNames = []) {
  let lastList = null;
  for (const name of candidates) {
    const first = await runtime.execute('computer_windows', { action: 'launch', name }, { actor });
    if (!first.needsConfirm) continue;
    const second = await runtime.execute('computer_windows', { action: 'launch', name, confirmToken: first.confirmToken }, { actor });
    console.log(`[launch] ${name}: ${JSON.stringify(second)}`);
    // 冷启动（Office/商店应用）可能 20 秒以上，轮询窗口放宽到 30 秒。
    for (let i = 0; i < 12; i++) {
      await sleep(2500);
      lastList = await runtime.execute('computer_windows', { action: 'list' });
      const win = (lastList.windows ?? []).find((item) => titlePattern.test(item.app));
      if (win) return win;
    }
  }
  // ④ switch 激活兜底（§4.3）：explorer 类 shell 进程在 tasklist 进程表失明（MainWindowTitle 取不到），
  // UIA 列表又偶发漏行——用驱动 switch（内部 EnumWindows 全量）激活后，焦点窗口段实测不漏。
  for (const name of switchNames) {
    const first = await runtime.execute('computer_windows', { action: 'switch', name }, { actor });
    if (!first.needsConfirm) continue;
    const second = await runtime.execute('computer_windows', { action: 'switch', name, confirmToken: first.confirmToken }, { actor });
    console.log(`[switch-fallback] ${name}: ${JSON.stringify(second)}`);
    if (!second.ok) continue;
    await sleep(800);
    const observed = await runtime.execute('computer_observe', {});
    const focus = observed.activeWindow;
    if (focus?.title && titlePattern.test(focus.title)) {
      return { app: focus.title, title: focus.title, handle: focus.handle, focused: true, source: 'uia-focus' };
    }
  }
  throw new Error(`未能启动 ${titlePattern}，最后窗口列表：${JSON.stringify(lastList?.windows?.map((item) => item.app) ?? [])}`);
}

async function focusWindow(runtime, actor, win) {
  let observed = await runtime.execute('computer_observe', {});
  if (observed.activeWindow?.handle !== win.handle) {
    await confirmExec(runtime, 'computer_windows', { action: 'switch', name: win.app }, actor);
    await sleep(800);
    observed = await runtime.execute('computer_observe', {});
  }
  return observed;
}

// 元素查找只在目标窗口内进行：微信/QQ 悬浮窗等其他窗口的 UIA 元素会混进清单（现网踩坑，防误点）。
function inActiveWindow(observed) {
  const title = observed.activeWindow?.title;
  return (observed.elements ?? []).filter((item) => !title || item.window === title);
}

function findElement(observed, pattern) {
  assert.equal(observed.ok, true, `观察失败：${JSON.stringify(observed)}`);
  assert.ok(Array.isArray(observed.elements), `观察结果缺 elements：${JSON.stringify(observed).slice(0, 300)}`);
  return inActiveWindow(observed).find((item) => pattern.test(`${item.name} ${item.role}`)) ?? null;
}

async function clickElement(runtime, actor, pattern, { required = true } = {}) {
  const observed = await runtime.execute('computer_observe', {});
  const element = findElement(observed, pattern);
  if (!element) {
    if (!required) return null;
    throw new Error(`未找到元素 ${pattern}：${JSON.stringify(observed.elements.map((item) => item.name))}`);
  }
  return confirmExec(runtime, 'computer_click', { elementId: element.id }, actor);
}

// 按钮精确匹配（名称完全一致，大小写不敏感）：中/英 UI 的计算器按钮名都收进候选表。
async function clickButton(runtime, actor, names) {
  const observed = await runtime.execute('computer_observe', {});
  assert.equal(observed.ok, true, `观察失败：${JSON.stringify(observed)}`);
  const wanted = names.map((name) => name.toLowerCase());
  const element = inActiveWindow(observed).find((item) => wanted.includes(String(item.name).trim().toLowerCase()));
  if (!element) throw new Error(`未找到按钮 ${names.join('/')}，现有元素：${JSON.stringify(inActiveWindow(observed).map((item) => item.name))}`);
  return confirmExec(runtime, 'computer_click', { elementId: element.id }, actor);
}

// 打字到当前焦点元素（地址栏、重命名框、Excel 单元格等）：先观察拿焦点 label 再输入。
async function typeIntoFocused(runtime, actor, text, { replace = false } = {}) {
  const observed = await runtime.execute('computer_observe', {});
  assert.equal(observed.ok, true, `观察失败：${JSON.stringify(observed)}`);
  const focused = inActiveWindow(observed).find((item) => item.focused)
    ?? inActiveWindow(observed).find((item) => /编辑|文本|Edit|Document/i.test(`${item.name} ${item.role}`));
  if (!focused) throw new Error(`未找到可输入的焦点元素：${JSON.stringify(inActiveWindow(observed).map((item) => item.name))}`);
  return confirmExec(runtime, 'computer_type', { text, elementId: focused.id, replace }, actor);
}

test('验收 P1：计算器任务（7×8=56）含暂停/恢复，任务可收口', { skip: !live, timeout: 300_000 }, async () => {
  const { runtime, actor } = liveSetup([
    'calc.exe', '计算器', 'Calculator', 'C:\\Windows\\System32\\calc.exe',
    'notepad.exe', 'C:\\Windows\\System32\\notepad.exe', 'notepad', '记事本',
    'explorer.exe', 'C:\\Windows\\explorer.exe',
    'EXCEL.EXE', 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
  ]);
  try {
    const started = await runtime.execute('computer_task_start', {
      goal: '用计算器计算 7×8 并核对显示结果 56',
      budget: { maxSteps: 120, maxWrites: 60, maxWallMs: 600_000 },
    }, { actor });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.status, 'running');

    const win = await launchApp(runtime, actor,
      ['C:\\Windows\\System32\\calc.exe', 'calc.exe', '计算器', 'Calculator'],
      /计算器|Calculator/i,
      ['计算器', 'Calculator']);
    assert.ok(win, '未能启动计算器');
    await focusWindow(runtime, actor, win);

    // 先清空（可能是复用的旧计算器窗口），再点 7 × 8；按钮名精确匹配，中英 UI 都覆盖。
    await clickButton(runtime, actor, ['C', '清空', 'Clear', '清除']);
    await clickButton(runtime, actor, ['7', '七', 'Seven']);
    await clickButton(runtime, actor, ['乘以', '乘', '×', '*', 'x', 'Multiply']);
    await clickButton(runtime, actor, ['8', '八', 'Eight']);

    // 暂停/恢复（§6.2）：暂停期间 checkpoint 保留，恢复后继续。
    const paused = await runtime.execute('computer_task_pause', {}, { actor });
    assert.equal(paused.status, 'paused', JSON.stringify(paused));
    const resumed = await runtime.execute('computer_task_resume', {}, { actor });
    assert.equal(resumed.status, 'running');
    assert.ok(resumed.completedSteps >= 3, `checkpoint 应记录已完成步骤：${JSON.stringify(resumed)}`);

    await clickButton(runtime, actor, ['等于', 'Equals', '=']);

    // 回读核实：计算器 Ctrl+C 把显示值复制到剪贴板，用 computer_clipboard 读回（机器可验证）。
    await confirmExec(runtime, 'computer_key', { keys: 'ctrl+c' }, actor);
    const clip = await confirmExec(runtime, 'computer_clipboard', { action: 'read' }, actor);
    assert.ok(String(clip.text).includes('56'), `计算器显示值不是 56：${JSON.stringify(clip.text)}`);

    const stopped = await runtime.execute('computer_task_stop', { completed: true }, { actor });
    assert.equal(stopped.status, 'done');
    assert.ok(stopped.receiptId);
    assert.ok(stopped.used.writes >= 4);
    console.log(`[验收通过] 计算器任务 ${stopped.taskId} 步数=${stopped.used.steps} 写=${stopped.used.writes}`);
  } finally {
    await runtime.dispose();
  }
});

test('验收 P1：资源管理器归档 + WPS 表格汇总跨应用任务', { skip: !live, timeout: 420_000 }, async () => {
  const stamp = Date.now();
  const archiveDir = path.join(os.tmpdir(), `computer-p1-archive-${stamp}`);
  const xlsxPath = path.join(os.tmpdir(), `computer-p1-summary-${stamp}.xlsx`);
  const { runtime, actor } = liveSetup([
    'explorer.exe', 'C:\\Windows\\explorer.exe',
    'et.exe', 'WPS 表格', 'WPS Office',
    'C:\\Users\\YourUser\\AppData\\Local\\Kingsoft\\WPS Office\\12.1.0.29161\\office6\\et.exe',
    'C:\\Users\\YourUser\\AppData\\Local\\Kingsoft\\WPS Office\\12.1.0.28505\\office6\\et.exe',
  ]);
  try {
    const started = await runtime.execute('computer_task_start', {
      goal: `用资源管理器在 TEMP 新建归档文件夹 ${path.basename(archiveDir)}，再用 WPS 表格建汇总表保存为 ${path.basename(xlsxPath)}`,
      budget: { maxSteps: 180, maxWrites: 80, maxWallMs: 600_000 },
    }, { actor });
    assert.equal(started.ok, true, JSON.stringify(started));

    // ── 资源管理器：打开 TEMP → 新建文件夹 ──
    const explorer = await launchApp(runtime, actor, ['explorer.exe', 'C:\\Windows\\explorer.exe'], /文件资源管理器|Explorer/i, ['文件资源管理器', '资源管理器']);
    assert.ok(explorer, '未能启动资源管理器');
    await focusWindow(runtime, actor, explorer);
    await confirmExec(runtime, 'computer_key', { keys: 'ctrl+l' }, actor);
    await typeIntoFocused(runtime, actor, os.tmpdir(), { replace: true });
    await confirmExec(runtime, 'computer_key', { keys: 'enter' }, actor);
    await sleep(1500);
    await confirmExec(runtime, 'computer_key', { keys: 'ctrl+shift+n' }, actor);
    await typeIntoFocused(runtime, actor, path.basename(archiveDir), { replace: true });
    await confirmExec(runtime, 'computer_key', { keys: 'enter' }, actor);
    await sleep(1200);
    assert.ok(fs.existsSync(archiveDir), `资源管理器未创建归档文件夹：${archiveDir}`);

    // ── WPS 表格（用户无 Excel 授权，改用 WPS）：只操作自动化新打开的工作簿 ──
    // 三源合并后进程源窗口没有 handle，用 handle ?? pid ?? 标题 作窗口身份键。
    const winKey = (item) => item?.handle ?? item?.pid ?? item?.app;
    const ET_EXE = 'C:\\Users\\YourUser\\AppData\\Local\\Kingsoft\\WPS Office\\12.1.0.29161\\office6\\et.exe';
    const preExcel = await runtime.execute('computer_windows', { action: 'list' });
    // 只认工作簿窗口：WPS home 启动页标题是「WPS Office - WPS Office」，绝不能当工作簿操作（现网踩坑）。
    const sheetTitle = /工作簿|Book\d|\.xlsx/i;
    const baselineExcel = new Map((preExcel.windows ?? []).filter((item) => sheetTitle.test(item.app)).map((item) => [winKey(item), item.app]));
    // 只接受「基线之外的新工作簿」，绝不碰用户已打开的文件。
    const pollSheet = async () => {
      for (let i = 0; i < 12; i += 1) {
        await sleep(2500);
        const list = await runtime.execute('computer_windows', { action: 'list' });
        const fresh = (list.windows ?? []).find((item) => sheetTitle.test(item.app) && !baselineExcel.has(winKey(item)));
        if (fresh) return fresh;
      }
      return null;
    };
    // 驱动 App launch et.exe 只会打开 WPS home 启动页；spawn et.exe 才直开空白工作簿（2026-10-26 探针实测）。
    const firstLaunch = await runtime.execute('computer_windows', { action: 'launch', name: ET_EXE }, { actor });
    if (firstLaunch.needsConfirm) {
      await runtime.execute('computer_windows', { action: 'launch', name: ET_EXE, confirmToken: firstLaunch.confirmToken }, { actor });
    }
    let excel = await pollSheet();
    if (!excel) {
      console.log('[spawn兜底] 驱动 launch 未出工作簿，spawn et.exe 直开');
      spawn(ET_EXE, [], { detached: true, stdio: 'ignore' }).unref();
      excel = await pollSheet();
    }
    if (!excel) {
      // 最后手段：在用户已开工作簿里 ctrl+n 新建（新文档，不改用户文件），再等新窗。
      const anySheet = (preExcel.windows ?? []).find((item) => sheetTitle.test(item.app));
      if (anySheet) {
        await confirmExec(runtime, 'computer_windows', { action: 'switch', name: anySheet.app }, actor);
        await confirmExec(runtime, 'computer_key', { keys: 'ctrl+n' }, actor);
        excel = await pollSheet();
      }
    }
    assert.ok(excel, `未找到自动化新打开的 WPS 工作簿（拒绝操作用户已打开的文件），基线：${JSON.stringify([...baselineExcel.values()])}`);
    await focusWindow(runtime, actor, excel);
    await clickElement(runtime, actor, /空白表格|空白工作簿|新建空白|Blank (spreadsheet|workbook)/i, { required: false });
    await sleep(1500);
    // 工作簿网格与名称框是自绘控件（UIA 无名/不可见，§4.1 自绘盲区）：按 UIA 坐标点 A1 再输入（探针实测 232,389）。
    await confirmExec(runtime, 'computer_type', { text: `电脑操控验收汇总 ｜ 归档文件夹 ${path.basename(archiveDir)}`, x: 232, y: 389 }, actor);
    await confirmExec(runtime, 'computer_key', { keys: 'enter' }, actor);
    await sleep(800);
    // F12 另存为：WPS 弹「文件名称(N)」组合框，填完整路径回车即落盘（探针实测无需点保存按钮）。
    await confirmExec(runtime, 'computer_key', { keys: 'f12' }, actor);
    let dialog = null;
    for (let i = 0; i < 8; i += 1) {
      await sleep(1500);
      dialog = await runtime.execute('computer_observe', {});
      if (findElement(dialog, /文件名称|文件名|File name/i)) break;
    }
    const nameField = findElement(dialog, /文件名称|文件名|File name/i);
    assert.ok(nameField, `未定位到文件名输入框：${JSON.stringify(inActiveWindow(dialog).map((item) => item.name))}`);
    await confirmExec(runtime, 'computer_type', { text: xlsxPath, elementId: nameField.id, replace: true }, actor);
    await confirmExec(runtime, 'computer_key', { keys: 'enter' }, actor);
    await sleep(3500);
    if (!fs.existsSync(xlsxPath)) {
      // 可能弹格式/云同步确认框：找确认按钮点掉再校验。
      const confirmBtn = findElement(await runtime.execute('computer_observe', {}), /^(保存|确定|是|保存到本地)$/);
      if (confirmBtn) {
        await confirmExec(runtime, 'computer_click', { elementId: confirmBtn.id }, actor);
        await sleep(3000);
      }
    }
    assert.ok(fs.existsSync(xlsxPath), `Excel 未保存汇总表：${xlsxPath}`);

    const stopped = await runtime.execute('computer_task_stop', { completed: true }, { actor });
    assert.equal(stopped.status, 'done');
    const receipts = runtime.audit.recent(30);
    assert.ok(receipts.filter((item) => item.receiptId).length >= 8, JSON.stringify(receipts.length));
    console.log(`[验收通过] 跨应用任务 ${stopped.taskId} 归档=${archiveDir} 汇总=${xlsxPath}`);
  } finally {
    await runtime.dispose();
  }
});
