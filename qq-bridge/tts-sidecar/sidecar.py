#!/usr/bin/env python3
"""Breeze TTS 2 本地合成 sidecar（WSL 内常驻）。

架构（见 docs/design/VOICE_TTS_INTEGRATION_PLAN.md §5/§6.1）：

    qq-bridge (Windows)  --HTTP-->  本进程 :18100  --HTTP-->  audiocpp_server :18080 (GGUF, CPU/CUDA)

本进程只做四件事：
  1) 契约/参数钳制（文本长度、音频路径、数值范围）；
  2) **串行队列**（引擎独占 CPU/GPU，并发请求排队而不是并行抢核）；
  3) **原子落盘**（先写 <target>.tmp 再 os.replace，避免半个文件被桥接发出去）；
  4) /health 汇总引擎状态，供桥接与控制台展示。

安全：
  - 只监听回环地址；
  - 产物只能写进 --voice-root 之内（outDir 是相对该根目录的子路径，越界直接拒绝）；
  - 参考音频只能来自 --refs-root（默认 ~/tts/refs），绝不从语音库取。

用法：
    python3 sidecar.py --port 18100 --engine http://127.0.0.1:18080 \
        --voice-root /mnt/d/github/qq-bridge/audio --refs-root /root/tts/refs

只依赖标准库（urllib / wave / hashlib / http.server）。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 引擎侧的模型 id（与 engine.json 的 models[].id 一致）
DEFAULT_MODEL_ID = "breeze"

# 文本里允许保留的 Vocal Events（发音指令，不能当普通方括号清掉）
VOCAL_EVENT_RE = re.compile(r"\[(笑|叹气|咳嗽|清嗓子|哭|哼|喘气)\]")
CTRL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class SidecarError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def sha1_of(*parts: str) -> str:
    h = hashlib.sha1()
    for p in parts:
        h.update(p.encode("utf-8", "replace"))
        h.update(b"\x1f")
    return h.hexdigest()


def wav_duration(path: str) -> float | None:
    try:
        with wave.open(path, "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate() or 0
            return round(frames / rate, 3) if rate else None
    except Exception:
        return None


def clamp_float(value, lo: float, hi: float, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


class Engine:
    """对 audiocpp_server 的薄封装（OpenAI 兼容 /v1/audio/speech）。"""

    def __init__(self, base: str, timeout: float):
        self.base = base.rstrip("/")
        self.timeout = timeout

    def health(self) -> dict:
        try:
            with urllib.request.urlopen(f"{self.base}/health", timeout=5) as r:
                body = r.read().decode("utf-8", "replace")
            return {"ok": True, "status": body.strip()[:200]}
        except Exception as exc:  # noqa: BLE001 - health 只做汇报，不抛
            return {"ok": False, "error": str(exc)[:200]}

    def speech(self, payload: dict) -> bytes:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base}/v1/audio/speech",
            data=data,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise SidecarError("tts_engine_error", f"引擎返回 HTTP {exc.code}：{detail}", 502) from exc
        except urllib.error.URLError as exc:
            reason = str(getattr(exc, "reason", exc))
            code = "tts_timeout" if "timed out" in reason.lower() else "tts_unavailable"
            raise SidecarError(code, f"引擎不可用：{reason[:200]}", 503) from exc
        except TimeoutError as exc:
            raise SidecarError("tts_timeout", "引擎合成超时", 504) from exc


class Synth:
    def __init__(self, args):
        self.args = args
        self.engine = Engine(args.engine, args.timeout)
        self.lock = threading.Lock()
        self.voice_root = os.path.abspath(args.voice_root)
        self.refs_root = os.path.abspath(os.path.expanduser(args.refs_root))
        self.ffmpeg = shutil.which("ffmpeg") or args.ffmpeg

    # ── 路径约束 ────────────────────────────────────────────────────────────
    def _resolve_out_dir(self, subdir: str) -> str:
        """outDir 只能是 voice_root 下的相对子路径；越界一律拒绝。"""
        rel = (subdir or self.args.default_subdir).strip().strip("/")
        if not rel or ".." in rel.split("/") or os.path.isabs(rel):
            raise SidecarError("tts_bad_request", "outDir 必须是语音库内的相对子路径")
        target = os.path.abspath(os.path.join(self.voice_root, rel))
        if os.path.commonpath([target, self.voice_root]) != self.voice_root:
            raise SidecarError("tts_bad_request", "outDir 越出语音库根目录")
        return target

    def _resolve_ref_by_name(self, name: str) -> str:
        """按名字取 refs 目录里的参考音频。

        桥接（Windows）与 sidecar（WSL）的路径命名空间不同（D:\\... vs /mnt/d/...），
        所以跨进程**不传绝对路径**，只传文件名，由 sidecar 在自己的命名空间里拼。
        """
        base = os.path.basename(str(name or "").strip())
        if not base:
            raise SidecarError("tts_bad_request", "参考音频名不能为空")
        path = os.path.join(self.refs_root, base)
        if not os.path.isfile(path):
            raise SidecarError("tts_bad_request", f"参考音频不存在：{base}（refs 目录里没有这个文件）")
        return path

    def _resolve_ref_audio(self, ref: str) -> str:
        path = os.path.abspath(os.path.expanduser(str(ref).strip()))
        if not path or not os.path.isfile(path):
            raise SidecarError("tts_bad_request", "参考音频不存在（只接受 refs 目录内的文件）")
        if os.path.commonpath([path, self.refs_root]) != self.refs_root:
            raise SidecarError("tts_bad_request", "参考音频必须位于 refs 目录内（不能从语音库取）")
        return path

    # ── 请求 → 引擎 payload ─────────────────────────────────────────────────
    def _payload(self, body: dict) -> tuple[dict, float, str]:
        text = CTRL_CHARS_RE.sub("", str(body.get("text") or "")).strip()
        if not text:
            raise SidecarError("tts_bad_request", "text 不能为空")
        if len(text) > self.args.max_chars:
            raise SidecarError("tts_text_too_long", f"文本 {len(text)} 字，超过上限 {self.args.max_chars}")

        mode = str(body.get("mode") or "design").strip().lower()
        if mode in ("vdes", "voice-design"):
            mode = "design"
        elif mode in ("clone", "clon", "voice-clone"):
            mode = "clone"
        elif mode in ("direction", "voice-direction", "instruct"):
            mode = "direction"
        if mode not in ("design", "clone", "direction"):
            raise SidecarError("tts_bad_request", f"未知音色模式：{mode}")

        options: dict = {}
        payload: dict = {"model": self.args.model_id, "input": text, "options": options}
        voice_hint = ""

        if mode == "design":
            design = str(body.get("voiceDesign") or self.args.default_design).strip()[:400]
            if not design:
                raise SidecarError("tts_bad_request", "design 模式必须提供 voiceDesign")
            options["instruct"] = design
            voice_hint = design
        else:
            ref_name = str(body.get("refName") or "").strip()
            # 优先按名字（跨命名空间安全）；refAudio 绝对路径只留给 WSL 内的 CLI 排障用。
            ref = self._resolve_ref_by_name(ref_name) if ref_name else self._resolve_ref_audio(body.get("refAudio") or "")
            ref_text = str(body.get("refText") or "").strip()
            if not ref_text:
                raise SidecarError("tts_bad_request", "clone/direction 模式必须提供参考音频逐字稿 refText")
            payload["voice_ref"] = ref
            payload["reference_text"] = ref_text[:400]
            voice_hint = os.path.basename(ref)
            if mode == "direction":
                instruction = str(body.get("instruction") or "").strip()[:400]
                if not instruction:
                    raise SidecarError("tts_bad_request", "direction 模式必须提供 instruction")
                options["instruct"] = instruction
                voice_hint = f"{voice_hint}|{instruction}"
            else:
                options["instruct"] = str(body.get("instruction") or "Speak clearly and naturally.").strip()[:400]

        cfg_scale = clamp_float(body.get("cfgScale"), 0.0, 10.0, 4.0)
        options["guidance_scale"] = cfg_scale
        speed = clamp_float(body.get("speed"), 0.5, 2.0, 1.0)
        return payload, speed, f"{mode}|{voice_hint}|{cfg_scale}|{speed}"

    # ── 主流程 ──────────────────────────────────────────────────────────────
    def synthesize(self, body: dict) -> dict:
        started = time.time()
        payload, speed, voice_key = self._payload(body)
        text = payload["input"]
        out_dir_base = self._resolve_out_dir(str(body.get("outDir") or ""))

        day = time.strftime("%Y%m%d")
        out_dir = os.path.join(out_dir_base, day)
        os.makedirs(out_dir, exist_ok=True)
        # 缓存键里带上前置静音设置：改了这个参数就该重新合成，不能命中旧文件。
        name = sha1_of(text, voice_key, f"lead{int(self.args.lead_silence_ms)}") + ".wav"
        target = os.path.join(out_dir, name)
        rel = os.path.relpath(target, self.voice_root).replace(os.sep, "/")

        # 同一句话重复合成：**先看有没有**再决定要不要占推理资源（内容由 sha1(文本|音色|参数)
        # 唯一确定）。这一步刻意放在抢锁之前：命中缓存时不应该排在别人后面等几十秒。
        if os.path.isfile(target) and os.path.getsize(target) > 128:
            return {
                "ok": True,
                "path": target,
                "relPath": rel,
                "bytes": os.path.getsize(target),
                "durationSec": wav_duration(target),
                "elapsedMs": int((time.time() - started) * 1000),
                "cached": True,
            }

        if not self.lock.acquire(timeout=self.args.queue_timeout):
            raise SidecarError("tts_timeout", "合成队列等待超时（前面的请求还没结束）", 504)
        try:
            wav_bytes = self.engine.speech(payload)
            if len(wav_bytes) < 128:
                raise SidecarError("tts_engine_error", "引擎返回的数据不像 WAV", 502)

            fd, tmp = tempfile.mkstemp(prefix=".tts-", suffix=".wav", dir=out_dir)
            os.close(fd)
            try:
                with open(tmp, "wb") as f:
                    f.write(wav_bytes)
                if abs(speed - 1.0) > 0.01:
                    self._apply_speed(tmp, speed)
                # 起头补静音：必须在落盘前做，否则 sha1 缓存会命中"没有前置静音"的旧文件。
                self._apply_onset(tmp)
                os.replace(tmp, target)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        finally:
            self.lock.release()

        size = os.path.getsize(target)
        if size > self.args.max_bytes:
            os.unlink(target)
            raise SidecarError("tts_engine_error", f"合成产物 {size} 字节超过上限 {self.args.max_bytes}", 502)
        return {
            "ok": True,
            "path": target,
            "relPath": rel,
            "bytes": size,
            "durationSec": wav_duration(target),
            "elapsedMs": int((time.time() - started) * 1000),
            "cached": False,
        }

    def _apply_speed(self, path: str, speed: float) -> None:
        """语速由 ffmpeg atempo 后期处理（引擎不一定支持 speed 参数）。"""
        if not self.ffmpeg:
            raise SidecarError("tts_unavailable", "ffmpeg 不可用，无法应用 speed", 503)
        tmp2 = path + ".spd.wav"
        proc = subprocess.run(
            [self.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", path,
             "-filter:a", f"atempo={speed:.3f}", tmp2],
            capture_output=True,
        )
        if proc.returncode != 0:
            raise SidecarError("tts_engine_error", f"ffmpeg 变速失败：{proc.stderr.decode('utf-8', 'replace')[:200]}", 502)
        os.replace(tmp2, path)

    def _apply_onset(self, path: str) -> None:
        """给合成音频补一段前置静音 + 极短淡入。

        原因（2026-10-30 实测）：引擎输出**直接从满音量开始**——有的句子首帧 10ms 的
        RMS 就有 0.10（有声起点 0ms）。这种"硬起头"过网关转 SILK 时，编码器的起播窗口
        会把第一个字吃掉一半，听感就是"前两个字不清楚"。补 150ms 静音给播放器/编码器
        留出起播余量，再用 12ms 淡入避免边界处的爆音。
        """
        lead = int(self.args.lead_silence_ms)
        if lead <= 0 or not self.ffmpeg:
            return
        fade = int(self.args.fade_in_ms)
        filt = f"adelay=delays={lead}:all=1"
        if fade > 0:
            filt += f",afade=t=in:st={lead / 1000:.3f}:d={fade / 1000:.3f}"
        tmp = path + ".lead.wav"
        proc = subprocess.run(
            [self.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", path,
             "-filter:a", filt, tmp],
            capture_output=True,
        )
        if proc.returncode == 0 and os.path.getsize(tmp) > 128:
            os.replace(tmp, path)
            return
        # 补静音失败绝不弄丢音频：删掉半成品，保留原始输出（只是起头可能还硬）
        try:
            if os.path.isfile(tmp):
                os.unlink(tmp)
        except OSError:
            pass

    # ── 参考音频导入（音色克隆） ─────────────────────────────────────────────
    def import_ref(self, body: dict) -> dict:
        """把浏览器上传的音频转成 24kHz 单声道 wav 落到 refs_root，返回可复用的绝对路径。

        为什么在 sidecar 里做：ffmpeg 只在 WSL 里装了；桥接（Windows）不该自己解码音频。
        只接受 3~30 秒，超过就截断——参考音频越长克隆越慢，短样本足够定音色。
        """
        raw_b64 = str(body.get("audio") or "").strip()
        if not raw_b64:
            raise SidecarError("tts_bad_request", "audio 不能为空（base64）")
        try:
            raw = base64.b64decode(raw_b64, validate=False)
        except Exception as exc:  # noqa: BLE001
            raise SidecarError("tts_bad_request", "audio 不是合法的 base64") from exc
        if len(raw) > self.args.max_ref_bytes:
            raise SidecarError("tts_bad_request", f"参考音频 {len(raw)} 字节，超过上限 {self.args.max_ref_bytes}")
        if not self._looks_like_audio(raw):
            raise SidecarError("tts_bad_request", "文件不像音频（只接受 wav/mp3/flac/ogg/m4a）")

        name = self._safe_ref_name(body.get("name"))
        if not self.ffmpeg:
            raise SidecarError("tts_unavailable", "ffmpeg 不可用，无法转换参考音频", 503)
        os.makedirs(self.refs_root, exist_ok=True)
        target = os.path.join(self.refs_root, name)
        fd, tmp_src = tempfile.mkstemp(prefix=".ref-", dir=self.refs_root)
        os.close(fd)
        fd, tmp_out = tempfile.mkstemp(prefix=".ref-", dir=self.refs_root, suffix=".wav")
        os.close(fd)
        try:
            with open(tmp_src, "wb") as f:
                f.write(raw)
            proc = subprocess.run(
                [self.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", tmp_src,
                 "-t", "30", "-ac", "1", "-ar", "24000", "-acodec", "pcm_s16le", tmp_out],
                capture_output=True,
            )
            if proc.returncode != 0:
                raise SidecarError(
                    "tts_bad_request",
                    "音频解码失败（换 wav/mp3 再试）：" + proc.stderr.decode("utf-8", "replace")[:200],
                )
            dur = wav_duration(tmp_out)
            if not dur or dur < 1.0:
                raise SidecarError("tts_bad_request", f"参考音频太短（{dur or 0}s），至少要 3 秒")
            os.replace(tmp_out, target)
        finally:
            for p in (tmp_src, tmp_out):
                try:
                    if os.path.isfile(p):
                        os.unlink(p)
                except OSError:
                    pass
        return {
            "ok": True,
            "file": target,
            "name": name,
            "durationSec": wav_duration(target),
            "bytes": os.path.getsize(target),
        }

    @staticmethod
    def _looks_like_audio(raw: bytes) -> bool:
        head = raw[:16]
        return (
            head[:4] == b"RIFF"            # wav
            or head[:3] == b"ID3"          # mp3 (带标签)
            or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")  # mp3 裸帧
            or head[:4] == b"fLaC"         # flac
            or head[:4] == b"OggS"         # ogg
            or head[4:8] == b"ftyp"        # m4a/mp4
        )

    @staticmethod
    def _safe_ref_name(raw) -> str:
        """参考音频文件名只由桥接给的音色名派生：去掉路径分隔符与特殊字符，杜绝目录穿越。"""
        name = re.sub(r"[^0-9A-Za-z\u4e00-\u9fa5_-]", "_", str(raw or "").strip())[:40].strip("_")
        if not name:
            raise SidecarError("tts_bad_request", "音色名不合法（1~20 个中文/字母/数字/-_）")
        return name + ".wav"


def make_handler(synth: Synth):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *a):  # 少打点日志，避免把每轮请求都刷进 journal
            pass

        def _send(self, status: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802
            if self.path.split("?")[0] != "/health":
                self._send(404, {"ok": False, "error": "not found"})
                return
            engine = synth.engine.health()
            self._send(200, {
                "ok": True,
                "engine": "audio.cpp",
                "model": synth.args.model_id,
                "ready": bool(engine.get("ok")),
                "engineStatus": engine,
                "voiceRoot": synth.voice_root,
                "maxChars": synth.args.max_chars,
            })

        def do_POST(self):  # noqa: N802
            path = self.path.split("?")[0]
            if path not in ("/tts", "/refs"):
                self._send(404, {"ok": False, "error": "not found"})
                return
            try:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
                if not isinstance(body, dict):
                    raise SidecarError("tts_bad_request", "请求体必须是 JSON 对象")
                result = synth.import_ref(body) if path == "/refs" else synth.synthesize(body)
                self._send(200, result)
            except SidecarError as exc:
                self._send(exc.status, {"ok": False, "error": exc.message, "code": exc.code})
            except json.JSONDecodeError as exc:
                self._send(400, {"ok": False, "error": f"JSON 解析失败：{exc}", "code": "tts_bad_request"})
            except Exception as exc:  # noqa: BLE001 - 兜底，绝不把 traceback 回给调用方
                self._send(500, {"ok": False, "error": f"内部错误：{exc}", "code": "tts_engine_error"})

    return Handler


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Breeze TTS 2 本地合成 sidecar")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18100)
    ap.add_argument("--engine", default="http://127.0.0.1:18080")
    ap.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    ap.add_argument("--voice-root", default="/mnt/d/github/qq-bridge/audio")
    ap.add_argument("--default-subdir", default="tts")
    ap.add_argument("--refs-root", default="/mnt/d/github/qq-bridge/state/tts-refs")
    ap.add_argument("--max-chars", type=int, default=120)
    ap.add_argument("--max-bytes", type=int, default=20 * 1024 * 1024)
    # 合成产物前置静音/淡入：给 QQ 网关的 SILK 转码和播放器留起播余量，
    # 否则引擎"0ms 满音量"的硬起头会把前一两个字吃掉（0 = 关闭）。
    ap.add_argument("--lead-silence-ms", type=int, default=150)
    ap.add_argument("--fade-in-ms", type=int, default=12)
    # 参考音频上传上限（浏览器 base64 后经桥接转发）。
    ap.add_argument("--max-ref-bytes", type=int, default=25 * 1024 * 1024)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--queue-timeout", type=float, default=120.0)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument(
        "--default-design",
        default="一位温柔自信的年轻女性，声音清晰，语气亲切，表达轻快而富有感染力。",
    )
    args = ap.parse_args(argv)

    synth = Synth(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(synth))
    print(f"[sidecar] listening on {args.host}:{args.port} -> engine {args.engine}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
