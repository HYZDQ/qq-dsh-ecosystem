// 通用浏览器领域包（§7.3 P1 / B 方案）：任意网站的 DOM 级操作（computer_browser_*）。
// 硬约束继承 §7.2 现网经验：反检测补丁保留、禁止覆写 UA、懒加载先滚动、登录态不搬家（复用已开标签页）。
import { DomainPack } from './domain-pack.mjs';

export class BrowserPack extends DomainPack {
  id = 'browser';

  matches({ title = '', url = '' } = {}) {
    return /Edge|Chrome|Firefox|浏览器|Browser/i.test(String(title)) || /^https?:\/\//i.test(String(url));
  }

  observe(ctx = {}) {
    return {
      pack: this.id,
      title: ctx.title ?? '',
      note: 'DOM 级观察走 computer_browser_observe（ref 跨观察稳定）；桌面 GUI 层看不到页面内部。',
    };
  }

  actions() {
    return [
      { name: 'observe', description: 'DOM 结构化观察（computer_browser_observe）' },
      { name: 'open', description: '导航 http(s)（computer_browser_open）' },
      { name: 'click', description: '点击元素（computer_browser_click）' },
      { name: 'fill', description: '填写表单（computer_browser_fill）' },
      { name: 'download', description: '触发下载并核验落盘（computer_browser_download）' },
    ];
  }

  prompt() {
    return [
      '通用浏览器领域约束（§7.2/§7.3 现网硬约束）：',
      '1. 反检测补丁（navigator.webdriver、plugins）必须保留；禁止覆写 User-Agent——自定义 UA 会下发降级前端。',
      '2. 登录态不搬家：只操作用户已登录的专用浏览器标签页，不另开无痕/新配置。',
      '3. 懒加载页面先滚动触发渲染再定位元素；ref 来自 computer_browser_observe，执行前会重新解析。',
      '4. 网页写受 domains 域名白名单（fail-closed）与标题黑名单约束，确认令牌与收据同桌面写。',
    ].join('\n');
  }

  policyExt() {
    return {
      deny: ['ua-override', 'incognito'],
      requireConfirm: ['computer_browser_open', 'computer_browser_click', 'computer_browser_fill', 'computer_browser_download'],
      note: '目标白名单用 policy.domains（域名后缀匹配），与桌面 apps 白名单同为 fail-closed。',
    };
  }
}
