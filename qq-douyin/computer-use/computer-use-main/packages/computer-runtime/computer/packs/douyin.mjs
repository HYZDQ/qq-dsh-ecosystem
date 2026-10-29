// 抖音领域包（§7.2）：包裹现有 core.mjs 能力的领域描述层，不改 douyin_* 工具签名与语义——
// 阶段 A「先包一层」：动作清单/提示/附加限制在此声明，实际执行仍走既有 douyin_* 工具链。
import { DomainPack } from './domain-pack.mjs';

export class DouyinPack extends DomainPack {
  id = 'douyin';

  matches({ title = '', url = '' } = {}) {
    return /抖音|douyin/i.test(String(title)) || /douyin\.com/i.test(String(url));
  }

  observe(ctx = {}) {
    return {
      pack: this.id,
      title: ctx.title ?? '',
      note: '深度观察走 douyin_observe / douyin_status（既有领域工具）；本包负责归属判断与领域约束注入。',
    };
  }

  actions() {
    return [
      { name: 'open', description: '打开抖音窗口/导航（douyin_open）' },
      { name: 'browse', description: '刷视频上下切换（douyin_next / douyin_previous）' },
      { name: 'playback', description: '播放控制（douyin_play / douyin_pause）' },
      { name: 'memory', description: '记忆与回忆（douyin_remember / douyin_recall）' },
      { name: 'chat', description: '私信（douyin_chat_*，许可名单制）' },
      { name: 'watch', description: '自主观看/续火花/日报（douyin_watch_* / douyin_spark_* / douyin_report_*）' },
    ];
  }

  prompt() {
    return [
      '抖音领域约束（§7.2 现网硬约束）：',
      '1. 浏览器反检测补丁（navigator.webdriver、plugins）必须保留，否则接口返回空数据；禁止覆写 User-Agent（自定义 UA 会下发降级前端，评论编辑器/私信列表无法挂载）。',
      '2. 评论区懒加载：定位目标评论前先滚动触发渲染。',
      '3. 带 @ 的公开评论可能进审核队列：回读按「已提交成功」判定，不强求列表立即可见。',
      '4. 私信发送前二次核对对端 sec_uid，不一致即中止；分享卡片先卡片、间隔几秒再发文字。',
      '5. web 端无可用搜索接口：douyin_search 已移除，迁移不恢复。',
    ].join('\n');
  }

  policyExt() {
    return {
      deny: ['douyin_search'],
      requireConfirm: ['douyin_dm', 'douyin_share_card', 'douyin_comment_mention', 'douyin_comment_reply', 'douyin_forward_video'],
      note: '对外发送类动作受许可名单与 24h 收据去重约束（既有实现）。',
    };
  }
}
