// 感知层（P0）：把 windows-mcp Snapshot 的文本报告解析为结构化观察（§4.2）。
// perceptionPath：UIA 控件树为主（use_ui_tree），DOM/OCR/视觉为 P3 降级项。
// 元素提供两种 id：stableId 跨观察稳定（写动作用它重新解析），label 仅当次观察有效（传给驱动）。
import { createHash } from 'node:crypto';

const WINDOW_ROW = /^(.*?\S)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

function stableIdOf(window, role, name, point) {
  return `e-${createHash('sha256').update([window ?? '', role ?? '', name ?? '', point?.[0] ?? '', point?.[1] ?? ''].join('|')).digest('hex').slice(0, 10)}`;
}

function parsePoint(coords) {
  const match = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/.exec(String(coords ?? ''));
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function splitSection(text, header, nextHeader) {
  const start = text.indexOf(header);
  if (start < 0) return '';
  const from = start + header.length;
  const end = nextHeader ? text.indexOf(nextHeader, from) : -1;
  return text.slice(from, end < 0 ? undefined : end);
}

function parseWindowRows(section) {
  const windows = [];
  for (const line of section.split('\n')) {
    const match = WINDOW_ROW.exec(line.trim());
    if (!match || /^-{3,}/.test(line.trim()) || /Name\s+Depth/.test(line)) continue;
    windows.push({
      title: match[1].trim(), depth: Number(match[2]), status: match[3],
      width: Number(match[4]), height: Number(match[5]), handle: Number(match[6]),
    });
  }
  return windows;
}

function parseElementRows(section) {
  const elements = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || /^-{3,}/.test(trimmed) || /^No /.test(trimmed)) continue;
    const parts = trimmed.split('|');
    if (parts.length < 5) continue;
    const [id, window, role, name, coords] = parts;
    const metadata = parts.slice(5).join('|');
    let meta = {};
    try { meta = JSON.parse(metadata); } catch { /* 可选字段 */ }
    elements.push({
      id: Number(id), window, role, name: name ?? '', point: parsePoint(coords),
      focused: meta?.has_focused === 1 || meta?.has_focused === true,
      stableId: stableIdOf(window, role, name ?? '', parsePoint(coords)),
    });
  }
  return elements;
}

export function parseSnapshotText(text) {
  const source = String(text ?? '');
  const cursor = parsePoint(/Cursor Position:\s*(\(\s*-?\d+\s*,\s*-?\d+\s*\))/i.exec(source)?.[1]);
  const focused = parseWindowRows(splitSection(source, 'Focused Window:', 'Opened Windows:'))[0] ?? null;
  const windows = parseWindowRows(splitSection(source, 'Opened Windows:', 'List of Interactive Elements:'));
  const elements = parseElementRows(splitSection(source, 'List of Interactive Elements:', 'List of Scrollable Elements:'));
  const scrollables = parseElementRows(splitSection(source, 'List of Scrollable Elements:'));
  return {
    activeWindow: focused ? { title: focused.title, width: focused.width, height: focused.height, handle: focused.handle, status: focused.status } : null,
    windows, elements, scrollables, cursor,
    perceptionPath: elements.length ? 'uia' : 'screen',
    truncated: false,
  };
}

// 组装 §4.2 约定的观察返回；frames 只含 mimeType/bytes 概要，图片本体走 attachment 投影。
export function buildObservation(parsed, frames = []) {
  return {
    ok: true,
    activeWindow: parsed.activeWindow,
    windows: parsed.windows.map(({ title, status, width, height, handle, depth }) => ({ app: title, focused: parsed.activeWindow?.handle === handle, status, width, height, handle, depth })),
    elements: parsed.elements.map(({ stableId, id, window, role, name, point, focused }) => ({ id: stableId, label: id, name, role, window, point, focused })),
    scrollables: parsed.scrollables,
    cursor: parsed.cursor,
    truncated: parsed.truncated,
    perceptionPath: parsed.perceptionPath,
    frames: frames.map((frame) => ({ mimeType: frame.mimeType, bytes: Math.floor(String(frame.data ?? '').length * 3 / 4), time: Date.now() })),
  };
}
