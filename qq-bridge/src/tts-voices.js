// 音色库（克隆音色）登记表。
//
// 参考音频本体放在 `state/tts-refs/`（WSL 里通过 /mnt/d 读，sidecar 的 --refs-root 就指向这里），
// 这里只记「名字 → 元数据」。**不进语音库**：语音库里的文件会被 qq_list_voices 枚举出来，
// 参考音频混进去就可能被当成语音发到群里（项目红线：不冒充真人）。
//
// 名字是用户可见的唯一标识，所以校验放在这里：1~20 个中文/字母/数字/-_，
// 既做文件名（sidecar 再兜底清洗一次），也做合成时的下拉项。
import fs from 'node:fs';
import path from 'node:path';

export const VOICE_NAME_RE = /^[0-9A-Za-z\u4e00-\u9fa5_-]{1,20}$/;
export const MAX_VOICES = 20;
const MAX_REF_TEXT = 400;

/** 归一音色名；不合法返回 null（调用方 fail-closed，绝不擅自改名）。 */
export function normalizeVoiceName(raw) {
  const name = String(raw ?? '').trim();
  if (!name || !VOICE_NAME_RE.test(name)) return null;
  return name;
}

export function createVoiceStore({ file, refsDir, max = MAX_VOICES }) {
  const filePath = file;
  const refsRoot = refsDir;
  // `new Object.assign(...)` 会被解析成「把 Object.assign 当构造函数」，所以走独立 helper。
  const fail = (code, message) => {
    const err = new Error(message);
    err.code = code;
    return err;
  };

  function readAll() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const voices = Array.isArray(raw?.voices) ? raw.voices : [];
      return voices
        .filter((v) => v && normalizeVoiceName(v.name) && typeof v.file === 'string' && v.file)
        .map((v) => ({
          name: String(v.name),
          // 只允许纯文件名：清单被手工改坏时也不能变成 ../ 穿越
          file: path.basename(String(v.file)),
          refText: String(v.refText ?? '').slice(0, MAX_REF_TEXT),
          durationSec: Number.isFinite(Number(v.durationSec)) ? Number(v.durationSec) : null,
          bytes: Number.isFinite(Number(v.bytes)) ? Number(v.bytes) : null,
          createdAt: String(v.createdAt ?? '')
        }));
    } catch {
      return [];
    }
  }

  function writeAll(voices) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, voices }, null, 2));
    fs.renameSync(tmp, filePath);
  }

  /** 给桥接/引擎用的绝对路径；清单里的 file 已做过 basename，这里再兜一次。 */
  function refPath(voice) {
    const safe = path.basename(String(voice?.file ?? ''));
    return safe ? path.join(refsRoot, safe) : '';
  }

  return {
    refsDir: refsRoot,
    list() {
      return readAll().map((v) => ({ ...v, refAudio: refPath(v), exists: fs.existsSync(refPath(v)) }));
    },
    get(name) {
      const key = normalizeVoiceName(name);
      if (!key) return null;
      const hit = readAll().find((v) => v.name === key);
      return hit ? { ...hit, refAudio: refPath(hit), exists: fs.existsSync(refPath(hit)) } : null;
    },
    /** 新增或覆盖同名音色（覆盖时沿用同一个文件名，旧音频被 sidecar 原子替换）。 */
    add({ name, file, refText, durationSec, bytes, now = new Date().toISOString() }) {
      const key = normalizeVoiceName(name);
      if (!key) throw fail('tts_bad_request', '音色名不合法（1~20 个中文/字母/数字/-_）');
      const voices = readAll();
      const sameName = voices.findIndex((v) => v.name === key);
      const entry = {
        name: key,
        file: path.basename(String(file)),
        refText: String(refText ?? '').trim().slice(0, MAX_REF_TEXT),
        durationSec,
        bytes,
        createdAt: now
      };
      if (sameName >= 0) voices[sameName] = entry;
      else {
        if (voices.length >= max) throw fail('tts_bad_request', `音色最多 ${max} 个，先删掉不用的`);
        voices.push(entry);
      }
      writeAll(voices);
      return { ...entry, refAudio: refPath(entry) };
    },
    remove(name) {
      const key = normalizeVoiceName(name);
      if (!key) return null;
      const voices = readAll();
      const idx = voices.findIndex((v) => v.name === key);
      if (idx < 0) return null;
      const [gone] = voices.splice(idx, 1);
      writeAll(voices);
      // 同名的旧音频一并删掉；删失败不影响登记表（下次同名导入会覆盖）。
      try {
        const target = refPath(gone);
        // 只删 refs 目录内的文件，清单被改坏时也不越界
        if (target && path.dirname(path.resolve(target)) === path.resolve(refsRoot)) fs.unlinkSync(target);
      } catch { /* 文件已不在 */ }
      return gone;
    }
  };
}
