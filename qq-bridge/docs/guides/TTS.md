# 本地语音合成（TTS）部署与运维

> 目标：让 QQ 机器人可以把一段中文**现念成语音条**发出去，全在本机完成（文本不出网）。
> 方案文档：[../design/VOICE_TTS_INTEGRATION_PLAN.md](../design/VOICE_TTS_INTEGRATION_PLAN.md)。
> 本文只讲**怎么装、怎么开、怎么查**，不重复设计论证。

---

## 一、链路速览

```
QQ ↔ 桥接（Windows, node）  ──HTTP──▶  sidecar（WSL, :18100）  ──HTTP──▶  audiocpp_server（WSL, :18080）
                                              │                              │
                                              └── 原子落盘 ────────────────────┘ Breeze TTS 2 GGUF（CPU）
                                                    audio/tts/<日期>/<sha1>.wav  ← 语音库子目录
```

- 桥接**不直接**连推理引擎：sidecar 负责参数钳制、串行排队、原子落盘、`/health` 汇总。
- 产物必须落在语音库（`socialV2.voice.dir`，默认 `qq-bridge/audio/`）之内，因此**不需要**打开
  `socialV2.voice.allowAbsolutePath`（该开关对 AI 通道早已无效，见 `bridge.js` 的注释）。
- 参考音频（clone / direction 模式）只能来自 `state/tts-refs/`（Windows 侧目录，WSL 里是
  `/mnt/d/github/qq-bridge/state/tts-refs`），**绝不放进语音库**。

---

## 二、装（一次性）

### 2.1 WSL 内依赖

```bash
wsl -d Ubuntu-22.04 -u root -- bash -lc "apt-get update -qq && apt-get install -y -qq cmake ffmpeg build-essential python3"
```

> GCC 13 由 `ppa:ubuntu-toolchain-r/test` 提供（audio.cpp 需要 C++20）。实测 Ubuntu 22.04 自带
> 的 GCC 11 编译会失败。

### 2.2 源码与权重

```bash
# 源码（HTTPS clone 在本机偶发 HTTP2 framing 错误，直接下 tarball 更稳）
curl -sSL https://codeload.github.com/0xShug0/audio.cpp/tar.gz/refs/heads/main -o /tmp/audio.cpp.tgz
mkdir -p /root/tts && tar xzf /tmp/audio.cpp.tgz -C /root/tts

# 权重（约 3.6 GB，走 hf-mirror，huggingface.co 本机不可达）
mkdir -p /root/tts/models
curl -L -C - -o /root/tts/models/breeze-tts-2-q4_0.gguf \
  https://hf-mirror.com/audio-cpp/audio.cpp-gguf/resolve/main/Breeze-TTS-2-GGUF/breeze-tts-2-q4_0.gguf
```

### 2.3 编译（只编需要的模型族，避免把整个模型集合都跑一遍）

```bash
cd /root/tts/audio.cpp-main
CC=gcc-13 CXX=g++-13 cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DAUDIOCPP_MODEL_SET=custom -DAUDIOCPP_MODELS=breeze_tts
cmake --build build -j 14
# 产物：build/bin/audiocpp_server（HTTP 引擎）、audiocpp_cli（单次合成，排障用）
```

### 2.4 引擎与 sidecar 常驻（systemd）

```bash
# 引擎配置：threads 按 CPU 物理核数；voice_dir 指向参考音频目录
cat /root/tts/server.json        # 见下
systemctl enable --now audiocpp.service tts-sidecar.service
```

`/root/tts/server.json`（本机实测可用版本）：

```json
{
  "host": "127.0.0.1",
  "port": 18080,
  "backend": "cpu",
  "threads": 8,
  "lazy_load": true,
  "max_loaded_models": 1,
  "voice_dir": "/root/tts/refs",
  "models": [
    {
      "id": "breeze",
      "family": "breeze_tts",
      "path": "/root/tts/models/breeze-tts-2-q4_0.gguf",
      "task": "tts",
      "mode": "offline",
      "default_request_options": {
        "instruct": "一位温柔自信的年轻女性，声音清晰，语气亲切，表达轻快而富有感染力。",
        "seed": 123
      }
    }
  ]
}
```

sidecar 单元的关键参数（完整 unit 见仓库 `tts-sidecar/`，安装时拷到 `/opt/tts-sidecar/sidecar.py`）：

```
--port 18100 --engine http://127.0.0.1:18080
--voice-root /mnt/d/github/qq-bridge/audio --default-subdir tts
--refs-root /mnt/d/github/qq-bridge/state/tts-refs --max-chars 120 --timeout 120
```

> 参考音频目录必须与桥接的 `state/tts-refs` 是**同一份**（通过 `/mnt/d` 共享）。
> 跨进程只传文件名（`refName`），不传绝对路径：Windows 的 `D:\...` 在 WSL 里不存在。

> ⚠️ `--voice-root` 必须是桥接实际使用的语音库根目录。改 `socialV2.voice.dir` 后要同步改这里，
> 否则桥接会拒收产物（`safeJoinLibrary` 只认自己那个库）。

### 2.5 让 WSL 常驻（否则服务会"莫名其妙"掉线）

WSL VM 在最后一个会话结束后会**空闲关停**，里面的 systemd 服务随之退出。表现很有迷惑性：
控制台一会儿显示引擎在线、一会儿离线；桥接报 `tts_unavailable … fetch failed`；而那一刻进 WSL
`systemctl is-active` 又显示 `active`（因为这条命令本身把发行版唤醒了）。长句合成（30~50 s）
还会被"半路掐断"，看起来像网络问题，实际是 VM 在请求进行中关停了。

```powershell
# 常驻会话（推荐，一键启动脚本会自动做）
node local\wsl-keeper.mjs Ubuntu-22.04
#   → KEEPER_STARTED pid=…，把 pid 写进 state\wsl-keeper.pid；重复执行只回 KEEPER_EXISTS
# 关闭：一键关闭所有服务.bat 会按这个 pid 结束它
```

要点：

- **不能用 `Start-Process wsl.exe … tail -f /dev/null`**：控制台型进程会在父进程/任务结束时
  收到 CTRL_C 被掐掉（退出码 `0xC000013A`），VM 随之关停——这就是"一会儿在线一会儿离线"的根因。
  `local\wsl-keeper.mjs` 用 Node 的 `detached: true` + `stdio: 'ignore'` 起会话，不继承控制台，
  实测能稳定顶住 VM（2.5 分钟无任何会话仍然 Running、`/health` 返回 200）。
- 老的"每 5 分钟 `systemctl start` 唤醒"任务已经废弃并会在启动时自动删除：
  它既留不住模型（服务一起来 VM 又停），还让首句白等 30 秒。
- 常驻后：第一次合成加载模型（约 30 秒，内存 420 MB → 3.5 GB），之后每句 12~15 秒，
  模型一直在内存里，直到你关闭。

> `一键启动QQ桥接.bat`：`tts.enabled=true` 时先拉起 WSL 服务、等 `/health` 就绪（冷启动约 5 秒），
> 再起常驻会话。`一键关闭所有服务.bat` 关掉浏览器窗口、桥接、MCP、DSH、SnowLuma，最后收掉常驻会话
> 并 `wsl --shutdown`。

验证：

```powershell
wsl -l -v                                        # STATE 应长期是 Running
curl.exe -sS --noproxy '*' 127.0.0.1:18100/health  # 应返回 "ready": true
```

### 2.6 克隆音色（控制台就能做）

控制台「语音系统 → 音色库（克隆音色）」：

1. **名称**：1~20 个中文/字母/数字/-_（就是合成时下拉里显示的名字）。
2. **逐字稿**：必须与参考音频里说的话**一字不差** —— 模型用它对齐音色，写错会明显跑调。
3. **参考音频**：3~20 秒干净人声（wav/mp3/m4a/flac 均可，≤6MB）。sidecar 用 ffmpeg 转成
   24 kHz 单声道 wav 后落到 `state/tts-refs/<名字>.wav`，登记表写 `state/tts-voices.json`。
4. 保存后到「本地合成（TTS）」的**音色**下拉里选它，再试听/合成发送。

边界：

- 参考音频**不进语音库**（否则会被 `qq_list_voices` 枚举、可能被当语音发出去）。
- 跨进程只传文件名：桥接写 `refName`（如 `小暖.wav`），sidecar 在自己的命名空间里拼路径，
  Windows 的 `D:\...` 不会被当成 WSL 路径误传。
- 最多 20 个音色；同名再存会覆盖旧音频（同一个文件名原子替换）。
- 只允许**本人授权音色或虚拟音色**，这是项目红线（不冒充真人）。

---

## 三、开

1. `config.json` 里把 `tts.enabled` 改成 `true`（默认 `false`，关闭时工具 `qq_tts_say` 不注册、
   行为与现网完全一致）。
2. 确认语音总开关也开着：`socialV2.voice.enabled !== false` 且 `socialV2.tools.sendVoice !== false`
   （三者任一不满足都不注册工具）。
3. 重启桥接（`restart.bat`），再重启 DSH（让 MCP 工具重新挂载，`重启DSH-加载语音工具.cmd`）。
4. 控制台「聊天行为 → 语音系统」里点「试听」：只合成、不发送，产物留在 `audio/tts/`。

常用字段：

| 字段 | 本机建议 | 说明 |
| --- | --- | --- |
| `mode` | `design` | 文字描述音色，不需要参考音频 |
| `voice` | 空（可用克隆音色名） | **默认克隆音色**：填音色库里的名字（如 `rika`），AI 的 `qq_tts_say` 与不指定音色的合成都会用它；空 = 退回 `voiceDesign` 文字描述。改这个字段**不用重启桥接**（tts 段每次热读） |
| `voicePrivate` / `voiceGroup` | 空（跟随 `voice`） | 私聊 / 群聊各自的默认音色；控制台「本地合成 → 私聊默认音色 / 群聊默认音色 + 保存默认音色」写的就是这两个字段。只接受音色库里真实存在的名字 |
| `voiceDesign` | 见 `config.json` | 换音色的唯一手段（实测 5 种描述 5 种不同音频） |
| `timeoutMs` | 180000 | CPU 推理长句可到 ~70s；串行排队还要加等待 |
| `maxChars` | 120 | 超过直接拒绝，sidecar 再截断一次 |
| `keepDays` | 7 | 只清理 `tts/` 下 40 位 sha1 命名的 wav，用户自己的文件不碰 |
| `dailyLimit` | 0 | 每日语音条数上限（跨重启延续），0=不限 |

---

## 四、本机实测数据（RTX 4070 Laptop + R7-7745HX，CPU 8 线程，Q4_0）

| 场景 | 字数 | 耗时 | 音频时长 | 大小 |
| --- | --- | --- | --- | --- |
| 首次冷启动（含加载模型） | 3 | **31.1 s** | 1.04 s | 49 KB |
| 短句 | 3 | 7.1 s | 1.04 s | 49 KB |
| 短句 | 22 | 17.7 s | 3.84 s | 184 KB |
| 长句 | 76 | 47.9 s | 11.04 s | 530 KB |
| 三个不同 `voiceDesign` | 16 | 11.8 / 15.8 / 12.0 s | 2.56 / 3.60 / 2.56 s | — |
| Vocal Events（`[笑]`/`[叹气]`） | 23 | 17.3 s | 3.76 s | 181 KB |
| 语速 0.8（ffmpeg atempo） | 16 | 12.6 s | 3.17 s | 152 KB |
| 同句重复（sha1 去重命中） | 16 | ≈0 s | 复用 | 复用 |
| **经桥接 `/api/voice/tts`（真实链路，冷启动后首句）** | 15 | 31.2 s | 2.40 s | 115 KB |
| **clone（克隆音色，3 字）** | 8 | ≈20.0 s | 1.76 s | 83 KB |
| clone + instruction（direction） | 8 | 16.7 s | 2.48 s | 116 KB |

结论：

- **音色描述真的会换声音**：5 种描述 → 5 段不同音频（md5 全不同）。
- **Vocal Events 生效**（`[笑]`/`[叹气]` 有实际发声，需人耳最终确认）。
- **CPU 太慢，不适合当"实时语音"**：一句 16 字要 12 s。适合"稀疏地发一条"，不适合连续对话。
  提升空间：CUDA 版（本机显存空闲约 5.7 GB，Q4 约 3.6 GB 可塞下），但 WSL 内 CUDA Toolkit
  未装（下载 3 GB+），本轮未做，列为可选优化。
- 因此提示词里要求「一次唤醒最多 1 条、1~2 句」不只是风格问题，也是**性能约束**。

验收样例音频：`audio/tts/s0-demo/`（说明见该目录，控制台语音库里也能看到）。

---

## 五、排查

| 现象 | 先查 | 常见原因 |
| --- | --- | --- |
| 控制台「TTS 引擎」时而在线时而离线；桥接报 `fetch failed` | `wsl -l -v` 的 STATE | **WSL VM 空闲关停了**（见 2.5）；`schtasks /query /tn "WSL KeepAlive"` 看保活任务 |
| 长句合成做到一半失败（30~50 s 的请求） | 同上 | 同上：请求进行中 VM 被关停，容易误判为"网络不稳" |
| 控制台「TTS 引擎」显示离线 | `curl -sS 127.0.0.1:18100/health`（WSL 内） | sidecar 没起；`--engine` 地址写错 |
| `tts_unavailable` | `systemctl status audiocpp.service` | 引擎崩了/端口被占/模型路径失效 |
| `tts_timeout` | `journalctl -u tts-sidecar -n 50` | 长句超时；队列里排了别人的请求 |
| `tts_text_too_long` | 播放器/控制台里的文本长度 | 超过 `tts.maxChars` |
| `tts_engine_error` | `/root/tts/server.log` | 权重不匹配、显存/内存不足 |
| 桥接日志：`tts.outDir 不在语音库内` | `config.json` 的 `tts.outDir` | 写成了绝对路径或库外目录（已自动降级为 `<库>/tts`） |
| 桥接日志：`tts.baseUrl 必须是本机回环地址` | `config.json` 的 `tts.baseUrl` | 指向了局域网/云端（已回退 127.0.0.1:18100） |
| 工具 `qq_tts_say` 不存在 | 三个闸门 | `tts.enabled=false` / `voice.enabled=false` / `tools.sendVoice=false` |
| 音色下拉里没有刚存的音色 | `state/tts-voices.json`、`state/tts-refs/` | 名字不合法（只许中文/字母/数字/-_，≤20 字）；保存后没刷新页面 |
| `参考音频不存在`（clone 报错） | `ls state/tts-refs/` + `--refs-root` | sidecar 的 `--refs-root` 没指向 `state/tts-refs`，或清单里的文件被删了 |
| 克隆出来「不像」 | 逐字稿 | 逐字稿和音频里说的话不一致；参考音频有背景音/多人声/太短 |
| 语音条**开头一两个字听不清** | 已默认修复 | 引擎输出是"0ms 满音量"的硬起头，网关转 SILK 时起播窗口会吃掉首字。sidecar 落盘前会补 **150ms 前置静音 + 12ms 淡入**（`--lead-silence-ms` / `--fade-in-ms`，设 0 可关闭）；缓存键含 lead 值，改参数会重新合成 |

日志位置：

- 引擎：`/root/tts/server.log`、`/root/tts/server.stdout`
- sidecar：`/root/tts/sidecar.stdout`（stdout 只在启动时打一行）
- 桥接：`qq-bridge/state/bridge.log`、`state/qq-activity.log`（`[tts]` 前缀）

---

## 六、边界（不要越过）

1. **不做出网合成**：`tts.baseUrl` 非回环会被强制回退并告警，云端 TTS 一律不接。
2. **不做克隆他人声音**：控制台只能上传**你自己**的录音，参考音频固定落在 `state/tts-refs/`，
   不提供"给一段网络音频当参考"的入口；项目红线是"不冒充真人"。
3. **失败不重试**：混成失败就把错误回给模型，让它改打字（`tts.fallbackToText`），
   避免一次失败在群里刷出多条语音。
4. **主动冒泡不发语音**：`tts.allowProactive` 默认 false；冷场时突然开口是体验灾难。
5. **许可**：权重为「研究与非商用」，自用可以，**禁止商用**。

---

## 七、回归测试

```bash
npm run test-tts            # 客户端纯函数 + 合成发送安全边界 + 四处同步的契约检查
npm run test-voice          # 语音库/路径/审计（既有）
npm run test-voice:system   # 语音系统端到端（既有）
npm run test:preset-prompt  # 预设提示词（含新增语音约束）
npm run test:qq-preset-contract
```

`test-tts-contract.mjs` 是"改了四处要同步"的机器可读版本：配置字段、桥接端点、MCP 闸门、
v2/v3 预设措辞、控制台元素、sidecar 与本文档的存在性 —— 少改一处就红。
