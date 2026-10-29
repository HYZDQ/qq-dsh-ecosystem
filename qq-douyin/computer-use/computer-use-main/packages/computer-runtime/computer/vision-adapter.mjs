// visionLocate 视觉模型适配器（§4.1 接线）：把截图 + 目标描述发给多模态模型，解析回 { x, y, gone? }。
// 模型通道复用 DSH 模型路由（llm.stream + attachments.saveImages，同 native-watch-decision 的消息形态）：
// 不读凭据、不存历史；模型须支持图片输入（inputModalities 含 image），否则明确报错不硬试。
// 输出约定（写进 prompt）：只回 JSON——{"x":<n>,"y":<n>} 或 {"gone":true} 或 {"none":true}，坐标为截图物理像素。
import { randomUUID } from 'node:crypto';

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export function parseLocateReply(text) {
  const match = /\{[\s\S]*?\}/.exec(String(text ?? ''));
  if (!match) return null;
  let parsed = null;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.gone === true) return { gone: true };
  const x = Number(parsed.x), y = Number(parsed.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x: Math.round(x), y: Math.round(y) };
  return null;
}

export function pngSize(data) {
  try {
    const buf = Buffer.from(String(data), 'base64');
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { return null; }
}

export function createVisionLocate({ llm, attachments, agent, maxTokens = 200, maxFrameBytes = 2_000_000 } = {}) {
  const header = agent?.session?.requestHeader?.()?.config;
  const provider = header?.provider ?? agent?.options?.provider;
  const model = header?.model ?? agent?.options?.model;
  if (!provider || !model || typeof llm?.stream !== 'function' || typeof llm?.resolveModelInfo !== 'function') return null;
  if (typeof attachments?.saveImages !== 'function') return null;

  return async function locate({ frame, target, signal } = {}) {
    const dataUrl = `data:${frame?.mimeType || 'image/png'};base64,${frame?.data || ''}`;
    const match = DATA_URL.exec(dataUrl);
    if (!match) throw new Error('视觉定位截图格式无效。');
    const data = Buffer.from(match[2], 'base64');
    if (!data.length || data.length > maxFrameBytes || data.toString('base64') !== match[2]) throw new Error('视觉定位截图超出限制或编码无效。');
    const info = await llm.resolveModelInfo(provider, model, signal);
    if (!info?.inputModalities?.includes('image')) throw new Error('当前模型不支持图片输入，视觉兜底不可用。');

    const size = pngSize(frame?.data) ?? {};
    const prompt = [
      `这是 Windows 桌面截图${size.width ? `（${size.width}×${size.height} 物理像素）` : ''}，请找到目标：「${target}」。`,
      '目标可能是图标、按钮、文字或输入框；先在图里扫一遍再下结论，不要只看局部。',
      '只输出一个 JSON，不要任何其他文字：',
      '找到目标中心点时输出 {"x":像素x,"y":像素y}（截图像素坐标，x 向右 y 向下）；',
      '确定目标已消失时输出 {"gone":true}；确实找不到时输出 {"none":true}。',
    ].join('\n');
    const refs = await attachments.saveImages([{ data, mediaType: match[1] }]);
    if (!Array.isArray(refs) || refs.length !== 1 || !refs[0]?.attachmentId) throw new Error('DSH 未保存视觉定位截图附件。');
    const messages = [{
      id: randomUUID(), role: 'user',
      content: [{ type: 'text', text: prompt }, { type: 'image', attachment: refs[0] }],
      source: { kind: 'plugin', plugin: 'douyin-browser', form: 'snapshot', sections: [] },
    }];

    let text = '';
    for await (const chunk of llm.stream({ provider, model, messages, maxTokens, signal, sessionId: agent.session.id })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !text) text += chunk.block.text;
      if (text.length > 4_000) throw new Error('视觉定位回复超长。');
    }
    return parseLocateReply(text);
  };
}
