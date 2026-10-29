// 刷抖音设置页（大肥鱼抖音助手）。
// 2026-10-27 使用者要求：界面重设计（抖音手账风：玫红→青渐变竖条 + 序号眉标 + 紧字距大标题）；
// 设置精简——视频观看只留「观看主题（填入自动保存）」与「自主观看时长与时间段」；
// 续火花只留「允许主动问候」、分享只留「允许自主分享」（无上限）、评论只留「允许自主发布评论」（无上限）；
// 私信自动回复永久启用、每日模型请求无上限；页头加「开始新一轮」快捷键。
// 2026-10-28 设置入口合并：原「抖音助手」设置页（dsh-douyin-agent 的状态/登录/采集投递）
// 并入本页「登录与采集」栏目，设置侧栏只保留一个抖音入口；后端仍是 /api/douyin-agent 路由。
window.__ModuleLoader__.load({
  id: 'computer-use',
  factory: require => {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createElement: h, useEffect, useRef, useState } = React;
    const Button = primitives.Button, Input = primitives.Input || 'input';
    const PREFIX = '/api/douyin-browser';
    const routes = new Set(['/state', '/diagnostics', '/diagnostics/repair', '/watch/schedule', '/watch/options', '/comment-duty/configure', '/video/configure', '/video/start', '/video/stop', '/browser/open', '/persona/configure', '/model/configure', '/mode/configure', '/watch/start', '/watch/stop', '/spark/configure', '/spark/start', '/spark/stop', '/spark/resolve', '/comments/configure', '/comments/resolve', '/share/configure', '/share/resolve', '/chat/contacts', '/chat/configure', '/chat/start', '/chat/stop', '/chat/resolve', '/media/configure', '/media/credentials', '/reports/generate']);
    // ── 视觉规范：抖音手账风（2026-10-27 重设计）──
    const ACCENT = '#fe2c55', ACCENT2 = '#25f4ee';
    const ink = 'var(--dsw-alias-label-primary, #17181c)';
    const inkSoft = 'var(--dsw-alias-label-secondary, #565b63)';
    const inkFaint = 'var(--dsw-alias-label-tertiary, #8a8f98)';
    const line = 'var(--dsw-alias-border-l2, #e6e8ee)';
    const surface = 'var(--dsw-alias-bg-base, #fff)';
    const column = { display: 'flex', flexDirection: 'column', gap: 12 };
    const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
    const muted = { color: inkFaint, fontSize: 12.5, lineHeight: 1.8, margin: 0 };
    const eyebrow = { fontSize: 10.5, fontWeight: 700, letterSpacing: '.18em', textTransform: 'uppercase', color: ACCENT, margin: 0 };
    const formControl = { font: 'inherit', fontSize: 14, color: ink, background: surface, border: `1px solid ${line}`, borderRadius: 12, padding: '11px 13px', maxWidth: '100%', width: '100%', boxSizing: 'border-box', outline: 'none', transition: 'border-color .15s ease' };
    const cardStyle = { position: 'relative', background: surface, border: `1px solid ${line}`, borderRadius: 18, padding: '22px 24px', boxShadow: '0 1px 2px rgba(16,24,40,.04), 0 8px 28px -22px rgba(16,24,40,.18)', display: 'flex', flexDirection: 'column', gap: 13 };
    const labelStyle = { display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, fontWeight: 600, color: inkSoft };
    const sectionTitle = { margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: '-.01em', color: ink, display: 'flex', alignItems: 'center', gap: 10 };
    const accentBar = { width: 5, height: 17, borderRadius: 3, background: `linear-gradient(160deg, ${ACCENT}, ${ACCENT2})`, flex: '0 0 auto' };
    const pill = (on) => ({ borderRadius: 999, padding: '7px 18px', fontSize: 13, fontWeight: on ? 700 : 600, ...(on ? { background: '#17181c', borderColor: '#17181c', color: '#fff' } : { color: inkSoft }) });
    const fallbackCategories = { '视频观看': ['观看主题', '自主观看时长与时间段'], '好友互动': ['自动续火花', '自主分享作品', '许可好友与自动回复'], '公开评论': ['自主公开视频评论'], '登录与采集': ['运行状态', '登录抖音', '采集与投递'] };

    function createSettingsTransport(globals = globalThis, rpc = globals.__DSH_TRANSPORT__?.rpc) {
      const carrier = globals.__DSH_TRANSPORT__;
      const address = globals.location;
      const http = address && ['http:', 'https:'].includes(address.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
      const desktop = ['dsh-app:', 'dsh:'].includes(address?.protocol) && address.hostname === 'app';
      const fetcher = typeof carrier?.fetch === 'function' ? carrier.fetch.bind(carrier) : (http || desktop) && typeof globals.fetch === 'function' ? globals.fetch.bind(globals) : null;
      let token = '';
      return {
        async request(route, input) {
          if (!routes.has(route) && !/^\/reports\/read\?date=\d{4}-\d{2}-\d{2}$/.test(route)) throw new Error('只允许本插件的原生设置接口。');
          if (!fetcher && typeof rpc?.call !== 'function') throw new Error('当前 DSH 页面没有可用的插件设置通信接口。请更新插件后完全退出并重开 DSH；若仍失败，请核对 DSH 版本与来源。可点击“刷新插件状态”重试。');
          if (input !== undefined && !token) throw new Error('请先刷新原生设置页，核实当前状态。');
          const signal = AbortSignal.timeout(65_000);
          let response;
          if (!fetcher && typeof rpc?.call === 'function') {
            const reply = await rpc.call('/douyin-settings', 'request', { path: route, ...(input === undefined ? {} : { input, token }) }, signal);
            if (!reply?.ok) throw new Error(reply?.error?.message || 'DSH 设置通信失败，请确认插件后端已加载新版；操作不会自动重试。');
            const outcome = reply.value;
            if (!Number.isInteger(outcome?.status) || !outcome.body || typeof outcome.body !== 'object') throw new Error('DSH 设置接口版本不匹配，请完全退出后重开 DSH。');
            response = { status: outcome.status, ok: outcome.status >= 200 && outcome.status < 300, json: async () => outcome.body };
          } else response = await fetcher(PREFIX + route, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'content-type': 'application/json', ...(input === undefined ? {} : { 'x-douyin-settings-token': token }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
          let value;
          try { value = await response.json(); }
          catch { const error = new Error(`插件设置接口未返回 JSON（HTTP ${response.status || '未知'}）。请检查插件后端是否启用、DSH 的 WebServer 服务及版本兼容性。`); error.status = response.status; throw error; }
          if (!response.ok) { const error = new Error(value.error || '原生设置操作未完成。'); error.status = response.status; throw error; }
          if (route === '/state') { if (typeof value.token !== 'string' || !value.token) throw new Error('原生设置未取得有效会话。'); token = value.token; const { token: hidden, ...state } = value; return state; }
          return value;
        },
      };
    }

    // ── 「登录与采集」栏目：原「抖音助手」设置页并入（2026-10-28 设置入口合并）──
    // 后端是 dsh-douyin-agent 的 /api/douyin-agent 路由；界面换成与本页一致的手账风。
    const AGENT_API = '/api/douyin-agent';
    const agentCall = async (path, body) => {
      const res = await fetch(AGENT_API + path, body === undefined
        ? { credentials: 'same-origin', cache: 'no-store' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''}`);
      return res.json();
    };
    const kvGrid = { display: 'grid', gridTemplateColumns: '120px 1fr', gap: '7px 12px', fontSize: 13.5, alignItems: 'baseline' };
    const kvK = { color: inkSoft, fontWeight: 600 };
    const preStyle = { ...muted, margin: 0, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, lineHeight: 1.6 };

    function AgentPanel({ section }) {
      const [status, setStatus] = useState(null);
      const [cfg, setCfg] = useState(null);
      const [doctor, setDoctor] = useState(null);
      const [logLines, setLogLines] = useState([]);
      const [draft, setDraft] = useState({});
      const [busy, setBusy] = useState('');
      const [agentError, setAgentError] = useState('');
      const [agentNotice, setAgentNotice] = useState('');
      const booted = useRef(false);
      const run = (name, fn) => {
        if (busy) return;
        setBusy(name); setAgentError(''); setAgentNotice('');
        void (async () => {
          try { await fn(); } catch (failure) { setAgentError(String(failure?.message || failure)); } finally { setBusy(''); }
        })();
      };
      const refresh = (quiet = false) => run('refresh', async () => {
        const [s, c] = await Promise.all([agentCall('/status'), agentCall('/config')]);
        setStatus(s); setCfg(c.config); setAgentNotice(quiet ? '' : '已刷新。');
      });
      useEffect(() => { if (!booted.current) { booted.current = true; refresh(true); } }, []);
      const abtn = (text, key, onClick, primary = false) => h(Button, { type: 'button', size: 'sm', variant: primary ? 'primary' : 'outline', style: { borderRadius: 12, fontWeight: 600 }, disabled: !!busy, onClick }, busy === key ? '处理中…' : text);
      const edit = (key, v) => setDraft(old => ({ ...old, [key]: v }));
      const field = (key, label, kind = 'number') => h('label', { key, style: labelStyle }, label, h(Input, { 'aria-label': label, type: kind, style: formControl, value: draft[key] !== undefined ? draft[key] : (cfg?.[key] ?? ''), onChange: e => edit(key, e.target.value) }));
      const check = (key, label) => h('label', { key, style: { ...row, gap: 10, cursor: 'pointer', fontSize: 13.5, fontWeight: 600, color: ink } }, h('input', { type: 'checkbox', 'aria-label': label, checked: draft[key] !== undefined ? draft[key] : !!cfg?.[key], onChange: e => edit(key, e.target.checked), style: { width: 17, height: 17, accentColor: ACCENT, cursor: 'pointer' } }), label);
      const kv = (...pairs) => h('div', { style: kvGrid }, ...pairs.flatMap(([k, v]) => [h('span', { key: k, style: kvK }, k), h('span', { key: `${k}-v`, style: { color: ink } }, v)]));
      const saveAll = () => run('save', async () => {
        const patch = { ...draft };
        for (const key of ['perDay', 'maxPerRun', 'minComments', 'minDescLen']) if (patch[key] !== undefined) patch[key] = Number(patch[key]) || 0;
        if (typeof patch.keywords === 'string') patch.keywords = patch.keywords.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean);
        if (typeof patch.windowsText === 'string') {
          patch.windows = patch.windowsText.split('\n').map(line => {
            const m = /^\s*(\d{1,2}:\d{2})\s*[-~到]\s*(\d{1,2}:\d{2})\s*(.*)$/.exec(line);
            return m ? { start: m[1], end: m[2], label: (m[3] || '').trim() } : null;
          }).filter(Boolean);
          delete patch.windowsText;
        }
        const r = await agentCall('/config', { patch });
        setCfg(r.config); setDraft({}); setAgentNotice('已保存。');
      });
      const s = status || {}, login = s.login || {}, bridge = s.bridge || {};
      const windowsText = cfg && Array.isArray(cfg.windows) && cfg.windows.length ? cfg.windows.map(w => `${w.start}-${w.end} ${w.label || ''}`).join('\n') : '';
      return h(React.Fragment, null,
        agentError && h('div', { role: 'alert', style: { ...muted, color: '#c22449' } }, agentError),
        agentNotice && h('p', { role: 'status', style: { ...muted, color: inkSoft } }, agentNotice),
        section('运行状态',
          kv(['版本', `v${s.version || '?'}`], ['总开关', s.enabled ? '开' : '关'], ['登录态', login.present ? `已存 · ${login.masked || ''}` : '未登录'], ['今日', `${(s.today && s.today.picked) || 0}/${(s.today && s.today.perDay) || 0} 条 · 跑了 ${(s.today && s.today.runs) || 0} 轮`], ['当前时段', (s.schedule && s.schedule.hitNow) || '不在任何时段'], ['浏览器', s.browser ? `${s.browser.mode} · :${s.browser.port}` : '未运行'], ['QQ 投递', bridge.ok ? `通 · 模式 ${bridge.mode} · ${bridge.ownerQQ || ''}` : (bridge.error || '不通')], ['Python', (s.python && s.python.venv) ? (s.python.deps ? 'venv + 依赖就绪' : 'venv 在但缺依赖') : '未安装']),
          h('div', { style: row },
            abtn('刷新', 'refresh', () => refresh()),
            abtn(doctor ? (doctor.ok ? '自检通过' : `自检 ${doctor.failed.length} 项待处理`) : '自检', 'doctor', () => run('doctor', async () => setDoctor(await agentCall('/doctor', {}))), true),
            abtn('看日志', 'log', () => run('log', async () => setLogLines((await agentCall('/log?lines=80')).lines || [])))),
          doctor && h('pre', { style: preStyle }, doctor.checks.map(c => `${c.ok ? '√' : '×'} ${c.key}：${c.detail}${c.ok ? '' : (c.action ? `　→ ${c.action}` : '')}`).join('\n')),
          logLines.length ? h('pre', { style: preStyle }, logLines.join('\n')) : null),
        section('登录抖音',
          h('p', { style: muted }, '扫码是唯一需要你亲手做的一步：先开有头窗口，登录完再取回登录态。'),
          h('div', { style: row },
            abtn('打开扫码窗口', 'loginOpen', () => run('loginOpen', async () => { await agentCall('/login', { action: 'open' }); refresh(true); }), true),
            abtn('保存登录态', 'loginCapture', () => run('loginCapture', async () => { await agentCall('/login', { action: 'capture' }); refresh(true); })),
            abtn('装运行环境', 'setup', () => run('setup', async () => { await agentCall('/setup', {}); refresh(true); })))),
        cfg ? section('采集与投递',
          h('div', { style: row }, field('perDay', '每天几条'), field('maxPerRun', '每轮候选'), field('minComments', '最少评论'), field('minDescLen', '最短文案')),
          h('div', { style: row }, check('peakValley', '谷时自动跑'), check('autoSend', '允许后台外发')),
          h('label', { style: labelStyle }, '关注关键词（命中加权）', h(Input, { 'aria-label': '关注关键词', style: formControl, value: draft.keywords !== undefined ? draft.keywords : (cfg.keywords || []).join(' '), onChange: e => edit('keywords', e.target.value) })),
          h('div', { style: row }, field('dmTo', '抖音好友昵称', 'text'), field('dmToId', 'sec_uid（重名才填）', 'text')),
          h('div', { style: row }, field('mentionName', '评论区 @ 谁（你的抖音昵称）', 'text')),
          h('label', { style: labelStyle }, '时段（每行一段，如 12:00-14:00 中午）', h('textarea', { 'aria-label': '时段', rows: 3, style: { ...formControl, fontFamily: 'monospace' }, placeholder: '12:00-14:00 中午\n18:00-09:00 夜间', value: draft.windowsText !== undefined ? draft.windowsText : windowsText, onChange: e => edit('windowsText', e.target.value) })),
          h('div', { style: row }, abtn('保存设置', 'save', saveAll, true))) : null);
    }

    function SettingsPage({ rpc } = {}) {
      const [api] = useState(() => createSettingsTransport(globalThis, rpc));
      const [state, setState] = useState(null), [ready, setReady] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
      const [draft, setDraft] = useState({}), [busy, setBusy] = useState(new Set()), [contacts, setContacts] = useState(null);
      const [reviews, setReviews] = useState(new Set());
      const [category, setCategory] = useState('视频观看');
      const categories = state?.sections || fallbackCategories;
      const dirty = useRef(new Set()), locks = useRef(new Set()), stateRef = useRef(null), generation = useRef(0), alive = useRef(true), submitted = useRef(new Set()), topicsTimer = useRef(null), draftRef = useRef({}), dirtyVersion = useRef({});
      const connectionFailed = useRef(false);
      const active = value => value?.running === true || value?.starting === true || value?.busy === true || value?.worker?.alive === true;
      const runningWatch = active(state?.watch), runningSpark = active(state?.spark), runningChat = active(state?.chat);
      async function refresh() {
        const sequence = ++generation.current;
        try { const value = await api.request('/state'); if (!alive.current || sequence !== generation.current) return; stateRef.current = value; setState(value); setReady(true); if (connectionFailed.current) setError(''); connectionFailed.current = false; }
        catch (failure) { if (alive.current && sequence === generation.current) { connectionFailed.current = true; setReady(false); setError(failure.message); } }
      }
      useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => { void refresh(); }, 2500); return () => { alive.current = false; generation.current++; clearInterval(timer); clearTimeout(topicsTimer.current); }; }, [api]);
      useEffect(() => {
        if (!state) return;
        const defaults = {
          video: { windows: (state.video?.policy?.windows || ['00:00-24:00']).join('\n'), sessionMinutes: state.video?.policy?.sessionMinutes ?? 10, unlimited: state.video?.policy?.sessionMinutes === null, weekendAll: state.video?.policy?.weekendWindows?.join() === '00:00-24:00' },
          topics: { mode: state.watchOptions?.policy?.mode || 'recommend', topics: (state.watchOptions?.policy?.topics || []).join('\n'), exclude: (state.watchOptions?.policy?.exclude || []).join('\n') },
          spark: { enabled: state.spark?.enabled === true },
          comments: { enabled: state.comments?.enabled === true },
          share: { enabled: state.share?.enabled === true },
          chat: { recipientIds: (state.chat?.policy?.allowlist || []).map(item => item.id) },
          commentDuty: {
            replyOwner: state.commentDuty?.config?.replyOwner !== false,
            multiTurn: state.commentDuty?.config?.multiTurn !== false,
            maxTurns: state.commentDuty?.config?.maxTurns ?? 5,
            replyStranger: state.commentDuty?.config?.replyStranger === true,
            expertAsk: state.commentDuty?.config?.expertAsk !== false,
            expertTimeoutMin: state.commentDuty?.config?.expertTimeoutMin ?? 5,
            ownerNick: state.commentDuty?.config?.ownerNick ?? '',
          },
        };
        setDraft(old => { const next = { ...old, ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !dirty.current.has(key))) }; draftRef.current = next; return next; });
      }, [state]);
      function edit(section, key, value) {
        dirty.current.add(section); dirtyVersion.current[section] = (dirtyVersion.current[section] || 0) + 1; setNotice('');
        setDraft(old => { const next = { ...old, [section]: { ...old[section], [key]: value } }; draftRef.current = next; return next; });
      }
      async function perform(key, action, section) {
        if (!ready || locks.current.has(key)) return;
        locks.current.add(key); setBusy(new Set(locks.current)); setError(''); setNotice('');
        const version = section ? dirtyVersion.current[section] : 0;
        try { const value = await action(); if (section && dirtyVersion.current[section] === version) dirty.current.delete(section); setNotice('已保存。'); await refresh(); return value; }
        catch (failure) { setError(failure.message || '操作未完成。'); await refresh(); }
        finally { locks.current.delete(key); setBusy(new Set(locks.current)); }
      }
      const post = (key, route, value, section) => { void perform(key, () => api.request(route, value), section); };
      const value = (section, key, fallback = '') => draft[section]?.[key] ?? fallback;
      const windows = section => value(section, 'windows').split(/[\n,;，；]+/).map(item => item.trim()).filter(Boolean);
      const button = (text, key, callback, disabled = false, needsReady = true, variant = 'outline', style = {}) => h(Button, { type: 'button', size: 'sm', variant, style: { borderRadius: 12, fontWeight: 600, ...style }, disabled: needsReady && !ready || busy.has(key) || disabled, onClick: callback }, busy.has(key) ? '处理中…' : text);
      const input = (label, section, key, extra = {}) => h('label', { style: labelStyle }, label, h(Input, { 'aria-label': label, value: value(section, key), disabled: !ready, style: formControl, onChange: event => edit(section, key, event.target.value), ...extra }));
      const textarea = (label, section, key, rows = 2, onInput = null) => h('label', { style: labelStyle }, label, h('textarea', { 'aria-label': label, rows, value: value(section, key), disabled: !ready, onChange: event => { edit(section, key, event.target.value); if (onInput) onInput(event.target.value); }, style: formControl, maxLength: 220 }));
      const toggle = (label, section, key = 'enabled', onToggle = null) => h('label', { style: { ...row, gap: 10, cursor: 'pointer', fontSize: 13.5, fontWeight: 600, color: ink } }, h('input', { type: 'checkbox', 'aria-label': label, checked: value(section, key, false) === true, disabled: !ready, onChange: event => { edit(section, key, event.target.checked); if (onToggle) onToggle(event.target.checked); }, style: { width: 17, height: 17, accentColor: ACCENT, cursor: 'pointer' } }), label);
      let sectionIndex = 0;
      const section = (title, ...children) => (categories[category] || []).includes(title) ? (sectionIndex += 1, h('section', { role: 'tabpanel', 'aria-label': title, style: cardStyle },
        h('p', { style: eyebrow }, `SECT ${String(sectionIndex).padStart(2, '0')}`),
        h('h3', { style: sectionTitle }, h('span', { style: accentBar }), title),
        ...children)) : null;
      const note = (text, key) => h('p', { key, style: muted }, text);
      const watchReason = runningWatch ? '自主观看正在运行。' : !state?.video?.allowed ? '请先开始一个允许时段内的有限轮次。' : '';
      // 观看主题：填入后自动保存（防抖 800ms）。2026-10-29 修复「输入保存不了/改不了」：
      // ① 旧防抖闭包读渲染时的旧草稿（存旧值、把新输入滚回去）→ 改走 draftRef 读最新；
      // ② 保存进行中直接丢弃新保存 → 忙时延后再存；
      // ③ 保存成功后无期清 dirty 会把保存期间的新输入一并冲掉 → perform 按版本号判断。
      const saveTopics = () => {
        clearTimeout(topicsTimer.current);
        topicsTimer.current = setTimeout(() => {
          if (locks.current.has('topics')) { saveTopics(); return; }
          const draft = draftRef.current.topics || {};
          void perform('topics', () => api.request('/watch/options', {
            mode: draft.mode || 'recommend',
            topics: String(draft.topics ?? '').split(/[\n,，;；]+/).map(item => item.trim()).filter(Boolean),
            exclude: String(draft.exclude ?? '').split(/[\n,，;；]+/).map(item => item.trim()).filter(Boolean),
          }), 'topics');
        }, 800);
      };
      // 单开关模块：勾选即保存（续火花 / 分享 / 评论）
      const toggleSave = (section, route, payloadOf, withStop = false) => (checked) => {
        void perform(section, async () => {
          const result = await api.request(route, payloadOf(checked));
          if (withStop && !checked) await api.request(route.replace('/configure', '/stop'), {});
          return result;
        }, section);
      };
      function resolve(kind, item, outcome) {
        const key = `${kind}:${item.operationId}`; if (submitted.current.has(key)) return;
        submitted.current.add(key); setReviews(new Set(submitted.current));
        void perform(key, async () => { try { return await api.request(`/${kind}/resolve`, { operationId: item.operationId, outcome }); } catch (failure) { submitted.current.delete(key); setReviews(new Set(submitted.current)); throw failure; } });
      }
      const reviewList = kind => (state?.[kind]?.needsReview || []).map(item => {
        const key = `${kind}:${item.operationId}`;
        return h('div', { key, style: column }, note(`待核对：${item.videoId ? `作品 ${item.videoId}` : '许可好友问候'} · ${item.status || ''}`), reviews.has(key) ? note('核对结果已提交，等待回读，不会重复提交。') : h('div', { style: row }, button('已核对发送成功', key, () => resolve(kind, item, 'confirmed'), kind === 'spark' && runningSpark), button('已核对未发送', key, () => resolve(kind, item, 'not-sent'), kind === 'spark' && runningSpark)));
      });
      const remaining = state?.video?.remainingSeconds ?? 0;
      return h('div', { style: { maxWidth: 900, color: ink, paddingBottom: 36, display: 'flex', flexDirection: 'column', gap: 18 } },
        h('div', { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' } },
          h('div', null,
            h('p', { style: eyebrow }, 'DSH PLUGIN · DOUYIN'),
            h('h2', { style: { margin: '4px 0 0', fontSize: 27, fontWeight: 800, letterSpacing: '-.025em', color: ink } }, '大肥鱼抖音助手'),
            h('p', { style: { ...muted, marginTop: 7 } }, '刷视频 · 好友互动 · 公开评论 · 电脑操控；人格跟随 QQ 私聊的人格与角色')),
          h('div', { style: row },
            button('开始新一轮', 'videoStart', () => post('videoStart', '/video/start', {}), runningWatch, true, 'primary', { background: ACCENT, borderColor: ACCENT, color: '#fff' }),
            button('打开抖音', 'browser', () => post('browser', '/browser/open', {}), false, true, 'primary'),
            button('刷新插件状态', 'refresh', () => { void refresh(); }, false, false))),
        h('div', { role: 'tablist', 'aria-label': '刷抖音设置分类', style: { ...row, gap: 8 } }, ...Object.keys(categories).map(name => h(Button, { key: name, type: 'button', role: 'tab', 'aria-selected': category === name, size: 'sm', variant: category === name ? 'primary' : 'outline', style: pill(category === name), onClick: () => setCategory(name) }, name))),
        !ready && h('p', { role: 'status', style: muted }, '正在核实插件状态；未就绪时不会启用或启动任何功能。'),
        error && h('div', { role: 'alert', style: { ...cardStyle, gap: 8, borderColor: 'rgba(254,44,85,.35)', color: '#c22449' } }, error),
        notice && h('p', { role: 'status', style: { ...muted, color: inkSoft } }, notice),
        section('观看主题',
          h('label', { style: labelStyle }, '观看方式', h('select', { 'aria-label': '观看方式', style: formControl, value: value('topics', 'mode', 'recommend'), disabled: !ready || runningWatch, onChange: event => { edit('topics', 'mode', event.target.value); saveTopics(); } }, h('option', { value: 'recommend' }, '自主挑选推荐'), h('option', { value: 'topic' }, '围绕指定主题观看'))),
          textarea('想看的主题，每行一个', 'topics', 'topics', 2, saveTopics),
          textarea('排除关键词，每行一个', 'topics', 'exclude', 2, saveTopics),
          note('填入后自动保存，下次启动生效。主题模式先搜索真实作品，再按人格挑片；排除词按作品标题匹配，不能保证识别画面内全部内容。')),
        section('自主观看时长与时间段',
          toggle('不限单轮时长', 'video', 'unlimited'),
          input('单轮上限（分钟）', 'video', 'sessionMinutes', { type: 'number', min: 1, max: 1000000, value: value('video', 'unlimited', false) ? '' : value('video', 'sessionMinutes'), placeholder: value('video', 'unlimited', false) ? '不限；输入分钟数可设置上限' : '请输入分钟数', onChange: event => { const minutes = event.target.value; edit('video', 'sessionMinutes', minutes); if (minutes !== '') edit('video', 'unlimited', false); } }),
          textarea('每日允许视频时段（北京时间）', 'video', 'windows'),
          toggle('周末全天允许', 'video', 'weekendAll'),
          h('div', { style: row }, button('保存视频时间', 'video', () => post('video', '/video/configure', { windows: windows('video'), weekendWindows: value('video', 'weekendAll', false) ? ['00:00-24:00'] : null, sessionMinutes: value('video', 'unlimited', false) ? null : Number(value('video', 'sessionMinutes')) }, 'video'), false, true, 'primary')),
          note(state?.video?.reason || state?.video?.remainingSeconds === null ? '本轮不限单轮时长，仍受允许时段和请求预算控制。' : `当前轮次剩余 ${remaining} 秒。`),
          h('div', { style: row }, button('开始新一轮', 'videoStart2', () => post('videoStart2', '/video/start', {}), runningWatch), button('结束本轮', 'videoStop', () => post('videoStop', '/video/stop', {}))),
          h('div', { style: row }, button('开始自主观看', 'watchStart', () => post('watchStart', '/watch/start', {}), runningWatch || !state?.video?.allowed), button('停止自主观看', 'watchStop', () => post('watchStop', '/watch/stop', {}), !runningWatch)),
          watchReason && note(watchReason), state?.watch?.lastError && h('p', { role: 'status', style: muted }, `上次自主观看停止原因：${state.watch.lastError}`),
          note('停止再开不会重置时间或请求预算；持续观看会在允许时段内自动续轮，说停才停。单轮模型请求不设上限，每日最多 20000 次。')),
        category === '好友互动' && h('section', { style: { ...column, gap: 8 } }, h('h3', { style: { ...sectionTitle, fontSize: 15 } }, h('span', { style: accentBar }), '好友互动运行状态'), ...(state?.interactions?.rows || []).map(item => note(`${item.running ? '运行中' : '未运行'} · ${item.label}：${item.message}`, item.id)), note(state?.interactions?.note)),
        section('自动续火花',
          toggle('允许主动问候', 'spark', 'enabled', toggleSave('spark', '/spark/configure', (checked) => ({ enabled: checked }), true)),
          note(`状态：${runningSpark ? '问候服务运行中' : '未在运行'}；每好友每天最多一次尝试，已有可靠发出互动、有新消息待回复或日期不明时不打扰。问候送达不等于火花增加，以抖音判定及对方互动为准。`),
          ...(state?.spark?.recipients || []).map(item => note(`${item.name || '许可好友'}：${item.reason || item.status || '等待检查'}`, item.id)), ...reviewList('spark')),
        section('自主分享作品',
          toggle('允许自主分享', 'share', 'enabled', toggleSave('share', '/share/configure', (checked) => ({ enabled: checked, dailyLimit: 0 }))),
          note('分享不设上限。好友名单与「许可好友与自动回复」共用；只在有限自主观看中选择当前观察的作品及许可好友；未确认不自动重发。'),
          ...reviewList('share')),
        state?.chat && section('许可好友与自动回复',
          note('私信自动回复永久启用（机器人侧自动运行），每日模型请求不设上限；只回复启动后的可靠新消息，不补发历史。'),
          button('读取已关注联系人', 'chatList', () => { void perform('chatList', async () => { const result = await api.request('/chat/contacts', {}); if (result.blocked || result.loginRequired || result.verificationRequired || !Array.isArray(result.contacts)) throw new Error('请在专用抖音窗口完成登录或验证。'); setContacts(result.contacts); }); }, runningChat),
          ...(contacts || state.chat.policy?.allowlist || []).map(item => h('label', { key: item.id, style: { ...row, gap: 10, cursor: 'pointer', fontSize: 13.5, fontWeight: 500, color: ink } }, h('input', { type: 'checkbox', 'aria-label': `许可联系人 ${item.name || item.displayName || '联系人'}`, checked: value('chat', 'recipientIds', []).includes(item.id), disabled: !ready || runningChat || item.followed !== true || item.isGroup !== false || !value('chat', 'recipientIds', []).includes(item.id) && value('chat', 'recipientIds', []).length >= 2, onChange: event => edit('chat', 'recipientIds', event.target.checked ? [...value('chat', 'recipientIds', []), item.id] : value('chat', 'recipientIds', []).filter(id => id !== item.id)) }), item.name || item.displayName || '许可好友')),
          h('div', { style: row }, button('保存许可好友', 'chat', () => post('chat', '/chat/configure', { recipientIds: value('chat', 'recipientIds', []), dailyReplyLimit: 0 }, 'chat'), runningChat, true, 'primary')),
          ...(state.chat.contacts || []).filter(item => item.status !== 'ready').map(item => h('div', { key: item.id }, note(item.reason || item.status), button('已人工核对该会话', `chatResolve:${item.id}`, () => post(`chatResolve:${item.id}`, '/chat/resolve', { recipientId: item.id }), runningChat)))),
        section('自主公开视频评论',
          toggle('允许自主发布评论', 'comments', 'enabled', toggleSave('comments', '/comments/configure', (checked) => ({ enabled: checked, dailyLimit: 0, perSessionLimit: 0 }))),
          note('评论不设上限。仅在有限自主观看中由大肥鱼决定是否公开评论，不含人格、私信或 QQ 内容。每作品永久去重，未确认时暂停，不退次数或自动重发。'),
          note(`今日已尝试 ${state?.comments?.daily?.attempts ?? 0} 次，本轮 ${state?.comments?.session?.attempts ?? 0} 次。`), ...reviewList('comments')),
        section('评论互动',
          note('自动回复评论区的 @ 与追问：短句、不带链接不带@、发布后回读核实。答不上时按设置向豆包求助。'),
          toggle('回复我的 @（需在下方填主人昵称）', 'commentDuty', 'replyOwner'),
          toggle('多轮对话（线程里继续聊）', 'commentDuty', 'multiTurn'),
          input('多轮对话上限（轮）', 'commentDuty', 'maxTurns', { type: 'number', min: 1, max: 20 }),
          toggle('回复路人', 'commentDuty', 'replyStranger'),
          toggle('答不上时 @豆包求助', 'commentDuty', 'expertAsk'),
          input('主人的抖音昵称（区分“我”和路人）', 'commentDuty', 'ownerNick', { type: 'text' }),
          input('豆包超时（分钟）', 'commentDuty', 'expertTimeoutMin', { type: 'number', min: 1, max: 30 }),
          h('div', { style: row }, button('保存评论互动设置', 'commentDutySave', () => post('commentDutySave', '/comment-duty/configure', {
            replyOwner: value('commentDuty', 'replyOwner', true) === true,
            multiTurn: value('commentDuty', 'multiTurn', true) === true,
            maxTurns: Number(value('commentDuty', 'maxTurns', 5)) || 5,
            replyStranger: value('commentDuty', 'replyStranger', false) === true,
            expertAsk: value('commentDuty', 'expertAsk', true) === true,
            expertTimeoutMin: Number(value('commentDuty', 'expertTimeoutMin', 5)) || 5,
            ownerNick: String(value('commentDuty', 'ownerNick', '')).trim(),
          }, 'commentDuty'), false, true, 'primary')),
          note(`互动值班：${state?.commentDuty?.config?.enabled !== false ? '已开启' : '已关闭'} · 今日已回 ${state?.commentDuty?.repliedToday ?? 0} 条 · 活动线程 ${state?.commentDuty?.activeThreads ?? 0} · 等豆包 ${state?.commentDuty?.pendingExpert ?? 0} 个`)),
        category === '登录与采集' && h(AgentPanel, { section }),
      );
    }
    function apply(ctx) {
      let rpc;
      try { rpc = (ctx.get?.('connection') || ctx.connection)?.rpc; } catch {}
      const Page = rpc ? () => h(SettingsPage, { rpc }) : SettingsPage;
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'douyin-browser', order: 16, label: () => '刷抖音' }, Page));
    }
    return { name: 'douyin-browser-settings', inject: ['slots', 'connection'], apply, SettingsPage, createSettingsTransport };
  },
});
