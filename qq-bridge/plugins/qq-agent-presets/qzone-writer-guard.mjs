// qzone-writer 专用硬边界：该会话只负责起草正文，禁止调用任何工具。
//
// 与 qq-tool-restrict 的区别：
// - qq-tool-restrict 是聊天预设的“允许 QQ MCP + 拒绝本地工具”白名单；
// - 本守卫不做白名单，而是执行期**无条件拒绝所有工具**。qzone-writer 的 agent.cordis.yml
//   不挂载任何 MCP/本地工具行；即使全局 MCP 工具仍出现在 schema 里，只要模型尝试调用，
//   这里就会返回错误字符串，桥接侧不会收到任何工具动作。
export const name = 'qzone-writer-guard'

export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.guard(() => 'qzone-writer 会话禁止调用任何工具，只能直接输出正文')
}
