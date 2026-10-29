// 通用浏览器驱动（§7.3 browser 包 / B 方案）：把现有 Playwright CDP 通道抽象成 DOM 级观察与动作。
// 复用用户已登录的专用浏览器标签页（dsh-doyourweb 思路：登录态不搬家），不启动新浏览器、不覆写 UA（§7.2 硬约束）。
// 元素引用 ref 跨观察稳定（tag|name|href|序号 哈希派生，同 UIA 稳定 id 语义）；点击走原生 element.click()
//（§5.1 现网教训：部分 Web 控件不认派发鼠标事件）。包与工具只经此驱动触达页面，不直接持有键鼠。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './policy.mjs';

const EXTRACT_JS = `(() => {
  const els = [];
  const seen = new Map();
  const all = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[onclick]'));
  for (const el of all.slice(0, 300)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const tag = el.tagName.toLowerCase();
    const name = String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 80);
    const href = String(el.getAttribute('href') || '').slice(0, 200);
    const type = String(el.getAttribute('type') || '');
    const key = tag + '|' + name + '|' + href;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    els.push({ tag, name, href, type, occurrence, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  }
  return { url: location.href, title: document.title, elements: els };
})()`;

const FIND_JS = (tag, name, href, occurrence) => `(() => {
  const all = Array.from(document.querySelectorAll('${tag},button,input,select,textarea,a,[role="button"],[role="link"],[onclick]'));
  const seen = new Map();
  for (const el of all) {
    if (el.tagName.toLowerCase() !== ${JSON.stringify(tag)}) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const n = String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 80);
    const h = String(el.getAttribute('href') || '').slice(0, 200);
    const key = el.tagName.toLowerCase() + '|' + n + '|' + h;
    const occurrenceNow = seen.get(key) ?? 0;
    seen.set(key, occurrenceNow + 1);
    if (n === ${JSON.stringify(name)} && h === ${JSON.stringify(href)} && occurrenceNow === ${Number(occurrence)}) return true;
  }
  return false;
})()`;

function refOf({ tag, name, href, occurrence }) {
  return `b-${createHash('sha256').update([tag, name, href, occurrence].join('|')).digest('hex').slice(0, 10)}`;
}

export class BrowserDriver {
  // getPage({ match }) → Playwright Page；默认复用现有专用浏览器（core.mjs 的 connectExistingBrowser）。
  constructor({ getController, getPage, stateDir, now = Date.now, timeoutMs = 15_000 } = {}) {
    Object.assign(this, { getController, getPage, stateDir, now, timeoutMs });
  }

  async #pages() {
    if (this.getPage) {
      const page = await this.getPage({});
      return page ? [page] : [];
    }
    const controller = typeof this.getController === 'function' ? await this.getController() : this.getController;
    if (!controller?.connectExistingBrowser) throw fail('BROWSER_UNAVAILABLE', '未接浏览器通道（需要宿主提供专用浏览器连接）。', '先打开抖音专用浏览器或检查宿主接线。');
    const connection = await controller.connectExistingBrowser();
    if (!connection?.isConnected?.()) throw fail('BROWSER_UNAVAILABLE', '专用浏览器未连接。', '先打开抖音专用浏览器（登录态复用），再重试。');
    return connection.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed());
  }

  // match: { urlPattern?, titlePattern? } 选目标页；都不给 = 第一个可见页。
  async #pick(match = {}) {
    const pages = await this.#pages();
    if (!pages.length) throw fail('BROWSER_UNAVAILABLE', '没有可用的浏览器标签页。', '先打开专用浏览器并登录。');
    const urlPattern = match.urlPattern ? new RegExp(match.urlPattern) : null;
    const titlePattern = match.titlePattern ? new RegExp(match.titlePattern) : null;
    const hit = pages.find((page) => {
      const url = page.url?.() ?? '';
      const title = () => page.title?.() ?? '';
      try {
        return (!urlPattern || urlPattern.test(url)) && (!titlePattern || titlePattern.test(title()));
      } catch { return false; }
    });
    if (!hit) throw fail('ELEMENT_NOT_FOUND', `没有匹配的标签页（url=${match.urlPattern ?? '*'} title=${match.titlePattern ?? '*'}）。`, '先 computer_browser_observe 查看现有页面。');
    return hit;
  }

  // 结构化观察（L0）：页面 URL/标题 + 交互元素（ref 跨观察稳定）。
  async observe(match = {}) {
    const page = await this.#pick(match);
    const data = await page.evaluate(EXTRACT_JS).catch((error) => {
      throw fail('BROWSER_UNAVAILABLE', `页面读取失败：${error?.message ?? error}`);
    });
    return {
      ok: true,
      perceptionPath: 'dom',
      url: data.url,
      title: data.title,
      elements: data.elements.map((item) => ({
        ref: refOf(item), tag: item.tag, name: item.name, href: item.href || undefined, type: item.type || undefined,
        point: [item.x, item.y],
      })),
      truncated: data.elements.length >= 300,
    };
  }

  // 导航（L1）：只允许 http(s)，跟随现有会话（登录态不搬家）。
  async open({ url, match } = {}) {
    const target = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(target)) throw fail('INPUT_UNSUPPORTED', '只允许 http(s) 链接。');
    const page = await this.#pick(match);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs }).catch((error) => {
      throw fail('ACTION_TIMEOUT', `导航失败：${error?.message ?? error}`);
    });
    const after = await this.observe(match).catch(() => null);
    return { ok: true, perceptionPath: 'dom', url: page.url(), title: await page.title().catch(() => ''), elements: after?.elements?.length ?? 0 };
  }

  async #locate(page, ref) {
    const data = await page.evaluate(EXTRACT_JS).catch(() => null);
    const item = data?.elements?.find((el) => refOf(el) === ref);
    if (!item) throw fail('ELEMENT_NOT_FOUND', `元素已失效（ref 不在当前页面）：${ref}`, '重新 computer_browser_observe 后再试。');
    return item;
  }

  // 点击（L1）：原生 element.click()（派发鼠标事件不可靠，§5.1 现网教训）。
  async click({ ref, match } = {}) {
    const page = await this.#pick(match);
    const item = await this.#locate(page, ref);
    const clicked = await page.evaluate(FIND_JS(item.tag, item.name, item.href, item.occurrence).replace('return true;', 'el.click(); return true;')).catch(() => false);
    if (!clicked) throw fail('ELEMENT_NOT_FOUND', `点击未命中元素：${ref}`);
    return { ok: true, perceptionPath: 'dom', clicked: true, ref, name: item.name };
  }

  // 表单填写（L1）：设值 + 派发 input/change（React 等受控组件兼容）。
  async fill({ ref, text, match, replace = true } = {}) {
    const page = await this.#pick(match);
    const item = await this.#locate(page, ref);
    const value = String(text ?? '');
    const ok = await page.evaluate(`(() => {
      ${FIND_JS(item.tag, item.name, item.href, item.occurrence).replace('return true;', `
        if (${replace} === true) el.value = ''; 
        el.value = (el.value || '') + ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;`)}
    })()`).catch(() => false);
    if (!ok) throw fail('ELEMENT_NOT_FOUND', `未找到可填写元素：${ref}`);
    return { ok: true, perceptionPath: 'dom', filled: true, ref, length: value.length };
  }

  // 下载（L1）：点击触发 → 等 download 事件 → 存 stateDir/downloads 并核验落盘。
  async download({ ref, match, filename } = {}) {
    const page = await this.#pick(match);
    const item = await this.#locate(page, ref);
    const dir = path.join(this.stateDir ?? '.', 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    const result = await Promise.race([
      (async () => {
        const downloadPromise = page.waitForEvent('download', { timeout: this.timeoutMs }).catch(() => null);
        const clicked = await page.evaluate(FIND_JS(item.tag, item.name, item.href, item.occurrence).replace('return true;', 'el.click(); return true;')).catch(() => false);
        if (!clicked) throw fail('ELEMENT_NOT_FOUND', `未命中下载目标：${ref}`);
        const download = await downloadPromise;
        if (!download) return { ok: false, code: 'ELEMENT_NOT_FOUND', message: '点击后未捕获下载事件。' };
        const suggested = filename || download.suggestedFilename?.() || `download-${Date.now()}`;
        const target = path.join(dir, String(suggested).replace(/[\\/:*?"<>|]/g, '_'));
        await download.saveAs(target).catch(() => {});
        const saved = fs.existsSync(target);
        return saved
          ? { ok: true, perceptionPath: 'dom', file: target, bytes: fs.statSync(target).size }
          : { ok: false, code: 'VERIFY_FAILED', message: '下载事件有但文件未落盘。' };
      })(),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'ACTION_TIMEOUT', message: `下载超时（>${this.timeoutMs}ms）。` }), this.timeoutMs + 2_000)),
    ]);
    if (!result.ok) throw fail(result.code ?? 'ACTION_TIMEOUT', result.message ?? '下载失败。');
    return result;
  }
}
