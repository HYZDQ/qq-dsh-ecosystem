// 领域包（§7）单测：归属判断、领域提示、L1 计划越权自检、packs.json 启用清单、观察注解。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainPack, PACK_ALLOWED_TOOLS } from '../computer/packs/domain-pack.mjs';
import { DouyinPack } from '../computer/packs/douyin.mjs';
import { ExplorerPack } from '../computer/packs/explorer.mjs';
import { OfficePack } from '../computer/packs/office.mjs';
import { PackRegistry } from '../computer/packs/registry.mjs';
import { ComputerRuntime } from '../computer/runtime.mjs';
import { defaultPolicy } from '../computer/policy.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('抖音包：标题/URL 归属判断，提示含现网硬约束，搜索不恢复', () => {
  const pack = new DouyinPack();
  assert.equal(pack.matches({ title: '抖音 - 个人 - Microsoft Edge' }), true);
  assert.equal(pack.matches({ title: '任意窗口', url: 'https://www.douyin.com/video/1' }), true);
  assert.equal(pack.matches({ title: '记事本' }), false);
  const prompt = pack.prompt();
  for (const key of ['User-Agent', '懒加载', 'sec_uid', '审核']) assert.ok(prompt.includes(key), `提示缺约束：${key}`);
  assert.ok(pack.policyExt().deny.includes('douyin_search'));
  assert.ok(pack.policyExt().requireConfirm.includes('douyin_dm'));
});

test('explorer 包：动作计划只产出 L1 工具，未知动作拒绝', () => {
  const pack = new ExplorerPack();
  assert.equal(pack.matches({ title: 'Temp - 文件资源管理器' }), true);
  assert.equal(pack.matches({ title: '记事本' }), false);
  const nav = pack.plan('navigate', { path: 'C:\\Temp' });
  assert.deepEqual(nav.map((step) => step.tool), ['computer_key', 'computer_type', 'computer_key', 'computer_wait']);
  assert.equal(DomainPack.assertPlanAllowed(nav), true);
  const folder = pack.plan('newFolder', { name: 'archive' });
  assert.equal(DomainPack.assertPlanAllowed(folder), true);
  assert.ok(folder.some((step) => step.tool === 'computer_type' && step.args.text === 'archive'));
  assert.throws(() => pack.plan('delete', {}), (error) => error.code === 'ELEMENT_NOT_FOUND');
  // 越权计划（触达 L2/L3）必须被自检拦下（§7.1 结构约束）。
  assert.throws(() => DomainPack.assertPlanAllowed([{ tool: 'computer_shell', args: {} }]), (error) => error.code === 'TOOLSET_LEAK');
  for (const step of [...nav, ...folder]) assert.ok(PACK_ALLOWED_TOOLS.includes(step.tool));
});

test('office 包：文档窗口归属、配方计划只用 L1，提示含真机实测流程', () => {
  const pack = new OfficePack();
  assert.equal(pack.matches({ title: '工作簿1 - WPS Office' }), true);
  assert.equal(pack.matches({ title: '报告.docx - Word' }), true);
  assert.equal(pack.matches({ title: '记事本' }), false);
  const cell = pack.plan('inputCell', { text: '汇总', x: 232, y: 389 });
  assert.equal(DomainPack.assertPlanAllowed(cell), true);
  const save = pack.plan('saveAs', {});
  assert.deepEqual(save.map((step) => step.tool), ['computer_key', 'computer_wait']);
  assert.ok(pack.prompt().includes('文件名称'), '提示要含另存为实测配方');
  assert.throws(() => pack.plan('inputCell', { text: 'x' }), (error) => error.code === 'ELEMENT_NOT_FOUND');
});

test('packs.json 启用清单：缺失默认全启，显式启用生效，损坏 fail-closed 全关', () => {
  const dir = tmp('packs-');
  assert.equal(new PackRegistry({ stateDir: dir }).list().length, 4);
  fs.writeFileSync(path.join(dir, 'packs.json'), JSON.stringify({ enabled: ['douyin'] }));
  const only = new PackRegistry({ stateDir: dir });
  assert.deepEqual(only.list().map((item) => item.id), ['douyin']);
  fs.writeFileSync(path.join(dir, 'packs.json'), '{broken');
  assert.equal(new PackRegistry({ stateDir: dir }).list().length, 0);
});

test('观察注解：命中包给领域提示，未命中返回 null', () => {
  const dir = tmp('packs-hint-');
  const registry = new PackRegistry({ stateDir: dir });
  const douyin = registry.hintFor({ title: '抖音 - Microsoft Edge' });
  assert.equal(douyin.pack, 'douyin');
  assert.ok(douyin.hint.includes('User-Agent'));
  assert.equal(registry.hintFor({ title: '记事本' }), null);
});

test('runtime 集成：computer_observe 返回 domain 领域注解', async () => {
  const stateDir = tmp('packs-runtime-');
  const policy = { ...defaultPolicy(), apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['12345'] } };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  const sample = `
    Focused Window:
    Name              Depth  Status       Width    Height     Handle
--------------  -------  ---------  -------  --------  ---------
抖音 - Microsoft Edge    12  Maximized     1200      800  12345678

    Opened Windows:
    Name                            Depth  Status       Width    Height     Handle
------------------------------  -------  ---------  -------  --------  ---------
抖音 - Microsoft Edge                    12  Maximized     1200      800  12345678

    List of Interactive Elements:
    # id|window|control_type|name|coords|metadata
0|抖音 - Microsoft Edge|按钮|点赞|(600,400)|{"has_focused": 1}

    List of Scrollable Elements:
    No scrollable elements`;
  const driver = {
    child: { pid: 1 }, restarts: 0,
    async callTool() { return { ok: true, text: sample, frames: [] }; },
    async close() {},
  };
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });
  const observed = await runtime.execute('computer_observe', {});
  assert.equal(observed.domain?.pack, 'douyin');
  assert.ok(observed.domain?.hint.includes('sec_uid'));
  await runtime.dispose();
});
