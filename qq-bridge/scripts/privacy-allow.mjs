// 隐私扫描的白名单匹配（纯函数，零 IO，便于单测）。
//
// 为什么单独抽出来：旧的白名单 `allowPaths` 是**按文件**放行的——一旦某个文件因为某条规则误报
// 被整体加进去，该文件今后所有规则（包括真实泄漏）都扫不出来了。这里补上「文件 + 规则名」粒度：
// 只放行**这一条规则在这个文件里**的命中，其它规则照旧生效。

/** glob → 正则（`*` 不跨目录，`**` 跨目录）。 */
export function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`);
}

/**
 * 是否放行「文件 + 规则」这一条命中。
 *
 * @param {Array<string|{path:string, rule?:string}>} entries 白名单条目：
 *   - 字符串：等价 `{ path, rule: '*' }`（按文件放行，旧语义）；
 *   - `{ path }`：同上；
 *   - `{ path, rule: '规则名' }`：只放行这一条规则；
 *   - `rule` 以 `*` 结尾：按**规则名前缀**放行（规则名常带括号补充说明，前缀匹配更稳）。
 * @param {string} file 仓库相对路径（`/` 分隔）
 * @param {string} ruleName 规则名
 * @returns {boolean}
 */
export function matchesAllow(entries, file, ruleName) {
  const name = String(ruleName ?? '');
  for (const entry of entries ?? []) {
    const pathGlob = typeof entry === 'string' ? entry : entry?.path;
    const ruleGlob = typeof entry === 'string' ? '*' : (entry?.rule ?? '*');
    if (!pathGlob) continue;
    // 路径：含 `*` 走 glob 全匹配；否则沿用 allowPaths 的前缀语义（`scripts/test-` 放行整个前缀）。
    const pathHit = String(pathGlob).includes('*')
      ? globToRe(String(pathGlob)).test(file)
      : file.startsWith(String(pathGlob));
    if (!pathHit) continue;
    if (ruleGlob === '*') return true;
    const pattern = String(ruleGlob);
    if (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern) return true;
  }
  return false;
}
