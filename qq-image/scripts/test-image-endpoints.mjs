// 图片检索/发送端点的离线端到端回归。
//
// 目标（对应本仓库 README.md 的验收标准）：
//   · /api/socialV2/image/search 把候选缩略图交给调用方（这里只断言结构/字节）
//   · /api/socialV2/image/send 用**一条** OneBot 消息发多个 image 段，顺序与字节都要对
//   · 鉴权矩阵：reserved2 必须带会话令牌；其它模式必须显式 key + 已有桥接会话 + 白名单
//   · 1~3 截断、同消息 sha256 去重、部分失败只发成功项、全部失败不落账
//   · 候选缓存过期/不存在返回明确错误；白名单拒绝时**不下载**
//
// 全程不联网：bridge 的 fetch 是 harness 的假网关；图片搜索/下载用 globals 注入的桩
// （覆盖 imageSearch.defaultImageFetchers），只有本地 HTTP + 假 OneBot。
// 桥接侧的脚手架（audit-bridge-harness）与 bridge.js 都在同级的 qq-bridge/ 仓库里，
// 不让本仓库复制一份 bridge 逻辑（那会与被测代码漂移）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from '../../qq-bridge/scripts/audit-bridge-harness.mjs';

// ── 三张合法 PNG fixture（8×8、约 2.7 KB；仅用于字节/顺序断言）──────────────
// 为什么不是 1×1：桥接会拒绝明显占位图（原始字节 < 2048 或 宽/高 < 8），
// 用 68 字节的 1×1 图会让"发送成功"的用例全部变成"占位图被拒绝"。
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAKMnRFWHRDb21tZW50AGE6eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHidCIpHAAAAEUlEQVR42mP4z8CAFTEMLQkAKP8/wc53yE8AAAAASUVORK5CYII=', 'base64');
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAKMnRFWHRDb21tZW50AGI6eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHiaMFu6AAAAEElEQVR42mNgaPiPHQ0tCQAqM1/BgkfPGQAAAABJRU5ErkJggg==', 'base64');
const PNG_C = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAKMnRFWHRDb21tZW50AGM6eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHguCOkuAAAAEUlEQVR42mMQOKGAFTEMLQkANjA+AY7Qyz4AAAAASUVORK5CYII=', 'base64');

// ── provider fixtures（Baidu acjson / Bing images async HTML）────────────
const BAIDU_JSON = JSON.stringify({
  queryEnc: '%E7%8C%AB',
  data: [
    {
      thumbURL: 'https://img.example.com/t1.png',
      middleURL: 'https://img.example.com/o1.png',
      replaceUrl: [{ ObjURL: 'https://img.example.com/o1.png' }],
      width: 800, height: 600,
      fromPageTitleEnc: '猫 A', fromURLHost: 'example.com'
    },
    {
      thumbURL: 'https://img.example.com/t2.png',
      middleURL: 'https://img.example.com/o2.png',
      replaceUrl: [{ ObjURL: 'https://img.example.com/o2.png' }],
      width: 640, height: 480,
      fromPageTitleEnc: '猫 B', fromURLHost: 'example.com'
    },
    {
      // 明文 http：必须被丢弃（只允许 https）
      thumbURL: 'http://insecure.example.com/t3.png',
      middleURL: 'http://insecure.example.com/o3.png',
      width: 100, height: 100,
      fromPageTitleEnc: '明文 http 条目'
    }
  ]
});

const BING_HTML = [
  '<html><body><ul>',
  '<li><a class="iusc" href="https://page.example.com/c3" m="{&quot;murl&quot;:&quot;https://img.example.com/o3.png&quot;,&quot;turl&quot;:&quot;https://img.example.com/t3.png&quot;,&quot;purl&quot;:&quot;https://page.example.com/c3&quot;,&quot;t&quot;:&quot;Bing 猫 3&quot;}"></a></li>',
  '<li><a class="iusc" href="https://page.example.com/c4" m="{&quot;murl&quot;:&quot;https://img.example.com/o4.png&quot;,&quot;turl&quot;:&quot;https://img.example.com/t4.png&quot;,&quot;purl&quot;:&quot;https://page.example.com/c4&quot;,&quot;t&quot;:&quot;Bing 猫 4&quot;}"></a></li>',
  '</ul></body></html>'
].join('\n');

// 主机名 → 字节（thumb 与 original 分开，便于断言"发的是原图而不是缩略图"）
const RESOURCES = new Map([
  ['https://img.example.com/t1.png', PNG_A],
  ['https://img.example.com/t2.png', PNG_B],
  ['https://img.example.com/t3.png', PNG_C],
  ['https://img.example.com/t4.png', PNG_A],
  ['https://img.example.com/o1.png', PNG_A],
  ['https://img.example.com/o2.png', PNG_B],
  ['https://img.example.com/o3.png', PNG_C],
  ['https://img.example.com/o4.png', PNG_A]
]);

function makeImageStubs() {
  const state = {
    textCalls: [],   // {url, headers}
    bufferCalls: [], // url
    failUrls: new Set(),
    searchWebCalls: 0
  };
  const fetchText = async (url, options = {}) => {
    state.textCalls.push({ url: String(url), headers: { ...(options.headers ?? {}) } });
    const s = String(url);
    if (s.includes('image.baidu.com')) {
      return { statusCode: 200, contentType: 'application/json; charset=utf-8', body: BAIDU_JSON, url: s };
    }
    if (s.includes('bing.com/images/async')) {
      return { statusCode: 200, contentType: 'text/html; charset=utf-8', body: BING_HTML, url: s };
    }
    return { statusCode: 200, contentType: 'text/html; charset=utf-8', body: '<html><head><meta property="og:image" content="https://img.example.com/o3.png"><title>og 页面</title></head></html>', url: s };
  };
  const fetchBuffer = async (url, options = {}) => {
    const s = String(url);
    state.bufferCalls.push(s);
    if (state.failUrls.has(s)) throw new Error(`fixture：模拟下载失败 ${s}`);
    const buffer = RESOURCES.get(s);
    if (!buffer) throw new Error(`fixture：未登记的资源 ${s}`);
    const maxBytes = Number(options.maxBytes) || 8 * 1024 * 1024;
    if (buffer.length > maxBytes) throw new Error(`fixture：超过 ${maxBytes} 字节`);
    return { buffer, contentType: 'image/png', url: s };
  };
  const searchWeb = async (query) => {
    state.searchWebCalls += 1;
    return [
      { title: 'og 页面 1', url: 'https://page.example.com/og1' },
      { title: 'og 页面 2', url: 'https://page.example.com/og2' }
    ];
  };
  return { state, fetchers: { fetchText, fetchBuffer, searchWeb } };
}

const CONSOLE = { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1' };

function postJson(server, pathname, body, headers = {}) {
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        resolve({ status: response.statusCode, body: parsed, text });
      });
    });
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error(`request hung: ${pathname}`)));
    request.end(payload);
  });
}

async function startHarness(options = {}) {
  const stubs = makeImageStubs();
  const harness = await bridgeHarness({
    config: options.config ?? {},
    globals: {
      // 覆盖桥接注入的默认抓取器：测试绝不联网。
      defaultImageFetchers: stubs.fetchers,
      ...(options.globals ?? {})
    }
  });
  const server = harness.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return { harness, server, stubs };
}

async function closeHarness(ctx) {
  try { await new Promise((resolve) => ctx.server.close(resolve)); } catch {}
  try { await ctx.harness.close(); } catch {}
}

function sentOneBotBodies(harness) {
  return harness.calls.http.filter((call) => /\/send_(private|group)_msg$/.test(call.url));
}

function imageSegments(body) {
  const message = Array.isArray(body?.message) ? body.message : [];
  return message.filter((segment) => segment?.type === 'image');
}

function decodeImageSegment(segment) {
  const file = String(segment?.data?.file ?? '');
  assert.ok(file.startsWith('base64://'), 'image 段必须是 base64://（桥接下载后内联，不能让网关再抓 URL）');
  return Buffer.from(file.slice('base64://'.length), 'base64');
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, '—', error?.message ?? error);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 主场景：reserved2 + 默认额度（dailyLimit=0），去重窗口关闭以便重复发送
// ════════════════════════════════════════════════════════════════════════════
{
  const ctx = await startHarness({
    config: {
      imageSearch: {
        enabled: true,
        providers: ['baidu', 'bing'],
        dedupeWindowMinutes: 0,
        dailyLimit: 0,
        cooldownMs: 0
      }
    }
  });
  const { harness, server, stubs } = ctx;
  harness.setMode('reserved2');
  const st = harness.getSocialV2State('private:123');
  const agentToken = st.agentToken;
  let searchId = '';

  await test('image/search 合并 baidu+bing 候选、丢弃明文 http、返回缩略图与 searchId', async () => {
    const res = await postJson(server, '/api/socialV2/image/search', { query: '猫', count: 8 }, CONSOLE);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.searchId, 'string');
    assert.ok(res.body.searchId.length > 0);
    searchId = res.body.searchId;
    assert.equal(res.body.candidates.length, 4, `应有 4 个候选（baidu 3 条里丢 1 条 http + bing 2 条），实际 ${res.body.candidates.length}`);
    assert.equal(res.body.previews.length, 4);
    // candidateId 必须是 1..N 的连续整数（模型按编号挑选）
    assert.deepEqual(res.body.candidates.map((c) => c.candidateId), [1, 2, 3, 4]);
    // 缩略图字节必须与 fixture 对得上（不是占位图/错误图）
    const preview = res.body.previews.find((p) => p.candidateId === 1);
    assert.ok(preview, '候选 1 应有预览');
    assert.deepEqual(Buffer.from(preview.dataBase64, 'base64'), PNG_A);
    assert.match(preview.mimeType, /^image\//);
    // 每个候选都必须带 preview 状态
    for (const candidate of res.body.candidates) {
      assert.ok(['ok', 'failed'].includes(candidate.preview), `候选 ${candidate.candidateId} 的 preview 状态非法`);
    }
    // 明文 http 条目必须被丢掉：不许把 http URL 交给下载器
    assert.ok(!stubs.state.textCalls.some((call) => call.url.startsWith('http://')), '不得请求明文 http 资源');
    assert.ok(!stubs.state.bufferCalls.some((url) => url.startsWith('http://')), '不得下载明文 http 资源');
    // Baidu 的 acjson 需要 Referer（否则真实环境会返回验证页）
    const baiduCall = stubs.state.textCalls.find((call) => call.url.includes('image.baidu.com'));
    assert.ok(baiduCall, '应请求 Baidu 图片接口');
    assert.match(String(baiduCall.headers.referer ?? ''), /image\.baidu\.com/);
    // provider 结果要可观测
    const providers = Object.fromEntries((res.body.providers ?? []).map((p) => [p.id, p]));
    assert.equal(providers.baidu?.ok, true);
    assert.equal(providers.bing?.ok, true);
  });

  await test('image/send 把 2 张图放进同一条消息、顺序与字节正确、走白名单目标', async () => {
    const before = sentOneBotBodies(harness).length;
    const res = await postJson(server, '/api/socialV2/image/send', {
      searchId, candidateIds: [1, 2], token: agentToken
    }, CONSOLE);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.messageId, 9001);
    assert.equal(res.body.sent.length, 2);
    assert.deepEqual(res.body.sent.map((s) => s.candidateId), [1, 2]);
    const sends = sentOneBotBodies(harness);
    assert.equal(sends.length, before + 1, '两张图必须是**一条**消息（一次 send_*_msg）');
    const last = sends[sends.length - 1];
    assert.match(last.url, /\/send_private_msg$/);
    assert.equal(last.body.user_id, 123, '目标必须是当前私聊会话');
    const images = imageSegments(last.body);
    assert.equal(images.length, 2);
    assert.deepEqual(decodeImageSegment(images[0]), PNG_A);
    assert.deepEqual(decodeImageSegment(images[1]), PNG_B);
  });

  await test('超过 3 张被截断并提示（一条消息最多 3 张）', async () => {
    const res = await postJson(server, '/api/socialV2/image/send', {
      searchId, candidateIds: [1, 2, 3, 4], token: agentToken
    }, CONSOLE);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.truncated, true, '4 个候选必须标记 truncated');
    assert.equal(res.body.sent.length, 3);
    assert.match(String(res.body.note ?? ''), /最多 3 张/);
    const last = sentOneBotBodies(harness).at(-1);
    assert.equal(imageSegments(last.body).length, 3);
  });

  await test('同一条消息里 sha256 相同的图被去重（只发一张）', async () => {
    const res = await postJson(server, '/api/socialV2/image/send', {
      searchId, candidateIds: [4, 1], token: agentToken
    }, CONSOLE);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.sent.length, 1);
    assert.ok((res.body.skippedDuplicates ?? []).includes(1), `重复候选应被跳过：${JSON.stringify(res.body.skippedDuplicates)}`);
    const last = sentOneBotBodies(harness).at(-1);
    assert.equal(imageSegments(last.body).length, 1);
  });

  await test('部分候选下载失败：只发成功项并逐条报告失败原因', async () => {
    stubs.state.failUrls = new Set(['https://img.example.com/o2.png']);
    const before = sentOneBotBodies(harness).length;
    const res = await postJson(server, '/api/socialV2/image/send', {
      searchId, candidateIds: [1, 2], token: agentToken
    }, CONSOLE);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.sent.length, 1);
    assert.equal(res.body.sent[0].candidateId, 1);
    assert.equal(res.body.failed.length, 1);
    assert.equal(res.body.failed[0].candidateId, 2);
    assert.match(String(res.body.failed[0].reason ?? ''), /失败|图片/);
    const sends = sentOneBotBodies(harness);
    assert.equal(sends.length, before + 1);
    assert.equal(imageSegments(sends.at(-1).body).length, 1);
  });

  await test('全部候选不可用：不发消息、返回可读错误（失败不落账）', async () => {
    stubs.state.failUrls = new Set(['https://img.example.com/o1.png', 'https://img.example.com/o2.png']);
    const before = sentOneBotBodies(harness).length;
    const res = await postJson(server, '/api/socialV2/image/send', {
      searchId, candidateIds: [1, 2], token: agentToken
    }, CONSOLE);
    assert.equal(res.body.ok, false);
    assert.equal(res.status, 502);
    assert.match(String(res.body.error ?? ''), /未发出|无法发送|失败/);
    assert.equal(sentOneBotBodies(harness).length, before, '全部失败时绝不能调用 OneBot 发送');
    // 失败不落账：每日额度与冷却不应因为失败被消耗
    stubs.state.failUrls = new Set();
    const retry = await postJson(server, '/api/socialV2/image/send', {
      searchId, candidateIds: [1], token: agentToken
    }, CONSOLE);
    assert.equal(retry.body.ok, true, '失败后应能立即重试（额度已回滚）');
  });

  await test('candidateIds 非法 / searchId 失效：返回明确错误且不发送', async () => {
    const bad = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: ['x'], token: agentToken }, CONSOLE);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.ok, false);

    const missing = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [], token: agentToken }, CONSOLE);
    assert.equal(missing.status, 400);

    const before = sentOneBotBodies(harness).length;
    const expired = await postJson(server, '/api/socialV2/image/send', {
      searchId: 'not-a-real-search-id', candidateIds: [1], token: agentToken
    }, CONSOLE);
    assert.equal(expired.body.ok, false);
    assert.equal(expired.status, 410, `失效 searchId 应 410，实际 ${expired.status} ${expired.text}`);
    assert.match(String(expired.body.error ?? ''), /不存在|过期/);
    assert.equal(sentOneBotBodies(harness).length, before, '失效 searchId 时不得发送');
  });

  await test('reserved2 鉴权：无令牌/令牌不匹配一律拒绝且不下载', async () => {
    const downloadsBefore = stubs.state.bufferCalls.length;
    const noToken = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1] }, CONSOLE);
    assert.equal(noToken.status, 403, noToken.text);
    const foreign = await postJson(server, '/api/socialV2/image/send', {
      searchId, candidateIds: [1], key: 'group:456', token: agentToken
    }, CONSOLE);
    assert.equal(foreign.status, 403, foreign.text);
    assert.equal(stubs.state.bufferCalls.length, downloadsBefore, '鉴权失败时绝不能下载原图');
  });

  await test('dryRun：下载与校验照做，但不调用 OneBot、不写 recentMessages', async () => {
    const before = sentOneBotBodies(harness).length;
    const recentBefore = harness.getSocialV2State('private:123').recentMessages.length;
    const res = await postJson(server, '/api/socialV2/image/send', {
      searchId, candidateIds: [1], token: agentToken, dryRun: true
    }, CONSOLE);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.wouldSend.length, 1);
    assert.equal(res.body.wouldSend[0].bytes, PNG_A.length);
    assert.equal(sentOneBotBodies(harness).length, before, 'dryRun 不得发送');
    assert.equal(harness.getSocialV2State('private:123').recentMessages.length, recentBefore);
  });

  await test('asSticker：按表情规格发送（优先缩略图 + sub_type=1）', async () => {
    const beforeDownloads = stubs.state.bufferCalls.length;
    const res = await postJson(server, '/api/socialV2/image/send', {
      searchId, candidateIds: [1], token: agentToken, asSticker: true
    }, CONSOLE);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.asSticker, true, '表情模式应在响应里标记 asSticker');
    assert.equal(res.body.stickerFallback, false);
    assert.match(String(res.body.note ?? ''), /表情/);
    const last = sentOneBotBodies(harness).at(-1);
    const [segment] = imageSegments(last.body);
    assert.equal(segment.data.sub_type, 1, '表情模式必须带 sub_type=1（QQ 才会当表情处理）');
    assert.equal(segment.data.summary, '[表情]');
    // 表情模式必须先试缩略图（fixture 里候选 1 的 thumb 是 t1.png、原图是 o1.png）
    assert.deepEqual(
      stubs.state.bufferCalls.slice(beforeDownloads),
      ['https://img.example.com/t1.png'],
      '表情模式必须优先下载缩略图，而不是原图'
    );
  });

  await test('dailyLimit=0 不误拦：连续两次发图都成功', async () => {
    const first = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1], token: agentToken }, CONSOLE);
    const second = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [2], token: agentToken }, CONSOLE);
    assert.equal(first.body.ok, true, first.text);
    assert.equal(second.body.ok, true, second.text);
  });

  await closeHarness(ctx);
}

// ════════════════════════════════════════════════════════════════════════════
// 同会话窗口去重（dedupeWindowMinutes=30）
// ════════════════════════════════════════════════════════════════════════════
{
  const ctx = await startHarness({
    config: { imageSearch: { enabled: true, providers: ['baidu', 'bing'], dedupeWindowMinutes: 30 } }
  });
  const { harness, server } = ctx;
  harness.setMode('reserved2');
  const token = harness.getSocialV2State('private:123').agentToken;
  const search = await postJson(server, '/api/socialV2/image/search', { query: '猫', count: 4 }, CONSOLE);
  const searchId = search.body.searchId;

  await test('同一会话短时间内重复图被跳过（dedupeWindowMinutes）', async () => {
    const first = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1], token }, CONSOLE);
    assert.equal(first.body.ok, true, first.text);
    assert.equal(first.body.sent.length, 1);
    const again = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1], token }, CONSOLE);
    assert.equal(again.body.ok, true, again.text);
    assert.equal(again.body.sent.length, 0);
    assert.deepEqual(again.body.skippedDuplicates, [1]);
    assert.match(String(again.body.note ?? ''), /已经.*发过|跳过/);
  });
  await closeHarness(ctx);
}

// ════════════════════════════════════════════════════════════════════════════
// 每日额度（dailyLimit>0）+ 发送频率（socialV2.send.maxSendPerMinute）
// ════════════════════════════════════════════════════════════════════════════
{
  const ctx = await startHarness({
    config: {
      imageSearch: { enabled: true, providers: ['baidu'], dedupeWindowMinutes: 0, dailyLimit: 2, cooldownMs: 0 }
    }
  });
  const { harness, server } = ctx;
  harness.setMode('reserved2');
  const token = harness.getSocialV2State('private:123').agentToken;
  const search = await postJson(server, '/api/socialV2/image/search', { query: '猫', count: 4 }, CONSOLE);
  const searchId = search.body.searchId;

  await test('dailyLimit=2：前两次成功，第三次 429 且不发消息', async () => {
    const first = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1], token }, CONSOLE);
    const second = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [2], token }, CONSOLE);
    assert.equal(first.body.ok, true, first.text);
    assert.equal(second.body.ok, true, second.text);
    const before = sentOneBotBodies(harness).length;
    const third = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [3], token }, CONSOLE);
    assert.equal(third.status, 429, third.text);
    assert.match(String(third.body.error ?? ''), /额度|限额|dailyLimit/);
    assert.equal(sentOneBotBodies(harness).length, before);
  });
  await closeHarness(ctx);
}
{
  const ctx = await startHarness({
    config: {
      imageSearch: { enabled: true, providers: ['baidu'], dedupeWindowMinutes: 0 },
      socialV2: { send: { maxSendPerMinute: 1, maxSendPerHour: 0 } }
    }
  });
  const { harness, server } = ctx;
  harness.setMode('reserved2');
  const token = harness.getSocialV2State('private:123').agentToken;
  const search = await postJson(server, '/api/socialV2/image/search', { query: '猫', count: 4 }, CONSOLE);
  const searchId = search.body.searchId;

  await test('发送频率复用 socialV2.send 限流（maxSendPerMinute=1）', async () => {
    const first = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1], token }, CONSOLE);
    assert.equal(first.body.ok, true, first.text);
    const second = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [2], token }, CONSOLE);
    assert.equal(second.status, 429, second.text);
  });
  await closeHarness(ctx);
}

// ════════════════════════════════════════════════════════════════════════════
// 一代 chat 模式：必须显式 key + 已有桥接会话 + 白名单；非白名单目标不下载
// ════════════════════════════════════════════════════════════════════════════
{
  const ctx = await startHarness({
    config: { imageSearch: { enabled: true, providers: ['baidu'], dedupeWindowMinutes: 0 } }
  });
  const { harness, server, stubs } = ctx;
  harness.setMode('chat');
  const search = await postJson(server, '/api/socialV2/image/search', { query: '猫', count: 4 }, CONSOLE);
  assert.equal(search.body.ok, true, search.text);
  const searchId = search.body.searchId;

  await test('非白名单目标：403 且不下载任何原图', async () => {
    const before = stubs.state.bufferCalls.length;
    const res = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1], key: 'group:999' }, CONSOLE);
    assert.equal(res.status, 403, res.text);
    assert.equal(stubs.state.bufferCalls.length, before, '白名单拒绝时绝不能下载');
  });

  await test('chat 模式无会话令牌时必须显式 key；没有桥接会话则拒绝', async () => {
    const noKey = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1] }, CONSOLE);
    assert.equal(noKey.status, 400, noKey.text);
    const noSession = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1], key: 'private:123' }, CONSOLE);
    assert.equal(noSession.status, 403, noSession.text);
    assert.match(String(noSession.body.error ?? ''), /桥接会话/);
  });

  await test('chat 模式已有桥接会话 + 白名单：可以发图（无令牌）', async () => {
    harness.state.sessions['private:123'] = 'fixture-session';
    const res = await postJson(server, '/api/socialV2/image/send', { searchId, candidateIds: [1], key: 'private:123' }, CONSOLE);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.sent.length, 1);
    const last = sentOneBotBodies(harness).at(-1);
    assert.match(last.url, /\/send_private_msg$/);
    assert.equal(imageSegments(last.body).length, 1);
  });
  await closeHarness(ctx);
}

console.log(failures === 0 ? '\n图片端点回归：全部通过' : `\n图片端点回归：${failures} 个失败`);
process.exitCode = failures ? 1 : 0;
