// ======================== 全局变量 ========================
let currentUser = null;
let token = null;
let receiveMode = localStorage.getItem('receiveMode') || 'sse';
let eventSource = null;
let pollInterval = null;
let longPollActive = false;
let scrollPending = false;
let lastChatScrollTop = 0;      // 上一次聊天区滚动位置（判断是否在向上滚）
let earlierLoadTimer = null;    // 顶部触发「加载更早」的防抖定时器
let lastSyncTime = 0;
let toastTimeout = null;
let themeTransitionTimer = null;


// ========== 新增：联系人相关 ==========
let currentContact = null;          // 当前选中的联系人
let contacts = [];                 // 联系人列表
let aiStreamReader = null;         // AI 流式响应 reader
let isGenerating = false;          // AI 生成中标志（统一拦截生成期间的发送/继续/重新生成/自定义指令）
let aiTypingTimer = null;          // 打字机定时器（切换联系人/停止接收时清理）
let replyTarget = null;            // 当前引用的消息 { id, content }（第 21 项）

// ========== 模型/接口全局设置（localStorage） ==========
const AI_PROVIDER_KEY = 'ai_provider';
function loadAiProvider() {
    try {
        const raw = localStorage.getItem(AI_PROVIDER_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            if (p && typeof p === 'object') {
                // 安全：历史版本可能存过 apiKey，读取时直接丢弃，绝不下发到请求
                delete p.apiKey;
                return p;
            }
        }
    } catch (e) {}
    return { apiBase: '', model: 'deepseek-flash' };
}
function saveAiProvider(p) {
    // 安全：只持久化 apiBase / model（API Key 仅存在于服务端环境变量）
    const safe = { apiBase: p?.apiBase || '', model: p?.model || 'deepseek-flash' };
    localStorage.setItem(AI_PROVIDER_KEY, JSON.stringify(safe));
}
let aiProvider = loadAiProvider();

// DOM 元素
const authContainer = document.getElementById('auth-container');
const chatContainer = document.getElementById('chat-container');
const chatBox = document.getElementById('chatBox');
const msgInput = document.getElementById('msgInput');
const directorInput = document.getElementById('directorInput');
const directorToggleBtn = document.getElementById('directorToggleBtn');
const sendButton = document.getElementById('sendButton');
const statusSpan = document.getElementById('status');
const onlineCountSpan = document.getElementById('online-count');
const usernameSpan = document.getElementById('username');
const userAvatarImg = document.getElementById('user-avatar');
const userStatusSpan = document.getElementById('user-status');
const logoutBtn = document.getElementById('logout-btn');
const profileBtn = document.getElementById('profile-btn');
const profileModal = document.getElementById('profile-modal');
const closeProfileBtn = document.getElementById('close-profile');
const profileUsernameInput = document.getElementById('profile-username');
const profileAvatarPathInput = document.getElementById('profile-avatar-path');
const saveProfileBtn = document.getElementById('save-profile');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings');
const currentModeDisplay = document.getElementById('current-mode-display');
const jumpBottomBtn = document.getElementById('jumpBottomBtn');

// ========== 新增：联系人列表 DOM ==========
const contactsList = document.getElementById('contacts-list');
const chatHeader = document.getElementById('chat-header');
const chatSubheader = document.getElementById('chat-subheader');
const modeSelector = document.getElementById('mode-selector');
const SYNC_COOLDOWN = 60 * 1000; // 1分钟冷却
// ======================== 加载动画工具函数 ========================
function showLoading(element, text = '加载中') {
    if (!element) return;
    const originalText = element.innerHTML;
    element.setAttribute('data-original-text', originalText);
    element.disabled = true;
    element.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${text}`;
}

function hideLoading(element) {
    if (!element) return;
    const originalText = element.getAttribute('data-original-text');
    if (originalText !== null) {
        element.innerHTML = originalText;
        element.removeAttribute('data-original-text');
    }
    element.disabled = false;
}

// ======================== 辅助函数 ========================
// 注：escapeHtml 由 modal.js 提供（先加载），此处不再重复定义

// 程序化定位滚动条：先临时关掉容器的 scroll-behavior:smooth。
// 否则加载历史时 scrollTop 会被平滑动画拖着从顶部一路滚到底（表现为滚动条乱跳、内容上翻）
function setScrollTopInstant(el, top) {
    if (!el) return;
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = top;
    // 下一帧恢复：用户手动滚动 /「回到最新消息」仍使用 CSS 的平滑滚动
    requestAnimationFrame(() => { el.style.scrollBehavior = prev || ''; });
}

function isNearBottom(el, threshold = 120) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

// 贴底：同步定位 + 下一帧补一次（Markdown 图片/字体在布局后可能撑高内容）
function pinChatToBottom() {
    if (!chatBox) return;
    setScrollTopInstant(chatBox, chatBox.scrollHeight);
    requestAnimationFrame(() => {
        if (chatBox) setScrollTopInstant(chatBox, chatBox.scrollHeight);
    });
}

function scrollToBottom() {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
        if (chatBox) setScrollTopInstant(chatBox, chatBox.scrollHeight);
        scrollPending = false;
    });
}

function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message system';
    div.innerHTML = `<div class="message-text">${escapeHtml(text)}</div>`;
    chatBox.appendChild(div);
    scrollToBottom();
}

// ============================================================
// 时间标签（微信风格）：显示在气泡上方，格式 XXXX年XX月XX日 XX:XX
// 首条消息必定显示；与上一条间隔超过 5 分钟时再次显示
// ============================================================
let lastRenderedMsgTime = null;

function formatFullTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 纯函数：不读写任何全局状态，只根据「上一条已渲染消息的时间」推算本条标签。
// 返回 { text, nextTime }：text 为本条要显示的标签（无标签为 null），nextTime 为下一条比较用的时间。
function computeTimeLabel(iso, prevTime) {
    if (!iso) return { text: null, nextTime: prevTime };
    const t = new Date(iso).getTime();
    if (!prevTime) return { text: formatFullTime(iso), nextTime: t };
    const show = Math.abs(t - prevTime) > 5 * 60 * 1000;
    return { text: show ? formatFullTime(iso) : null, nextTime: t };
}

// 计算并返回时间标签文本（带间隔判断），同时推进全局 lastRenderedMsgTime。
// 仅用于「正常渲染路径」（renderMessages / renderAIMessage / renderMessage）；
// 向前插入历史消息（loadEarlierHistory）必须用 computeTimeLabel 按局部变量推算，不得污染全局。
function timeLabelFor(iso) {
    const { text, nextTime } = computeTimeLabel(iso, lastRenderedMsgTime);
    lastRenderedMsgTime = nextTime;
    return text;
}

// ============================================================
// 增量渲染状态：切换联系人时重置；同内容只渲染一次（按 id 或内容指纹去重）
// ============================================================
let renderedMsgKeys = new Set();
let renderedMessageCount = 0;
let renderedContentSeq = [];  // 已渲染（可见）消息的内容序列（role|content），用于与服务端内容序列比对
let historyPage = 1;          // 已加载的历史页数（用于“加载更早消息”）
let historyTotalPages = 1;
let loadingEarlier = false;
let versionGroups = [];       // 版本组：{ contactId, els:[...], currentIdx } —— 重新生成的回复版本切换
const MAX_DOM_MESSAGES = 300; // DOM 中最多保留的消息节点数（防止一次性渲染全部历史）

function resetMessageRenderState() {
    renderedMsgKeys = new Set();
    renderedMessageCount = 0;
    renderedContentSeq = [];
    lastRenderedMsgTime = null;
    versionGroups = [];
    historyPage = 1;
    historyTotalPages = 1;
    loadingEarlier = false;
}

// 内容序列键：忽略 id/时间戳（客户端缓存与服务端对同一消息的 id/时间戳不同，
// 若按 id 去重会在刷新时把同一条消息渲染两次）
function contentKey(msg) {
    return `${msg.role || 'm'}|${msg.content}`;
}

// 版本分组：连续出现的 assistant 消息属于同一“重新生成”版本组。
// 返回 { visible: [可见消息], visibleKeys: Set, groups: [{ids:[...]}] }
function buildVersionView(messages) {
    const groups = [];
    let cur = null;
    for (const m of messages) {
        if (m.role === 'user') {
            cur = null;
        } else if (m.role === 'assistant') {
            if (!cur) { cur = { ids: [] }; groups.push(cur); }
            cur.ids.push(m.id !== undefined ? String(m.id) : `${m.content}|${m.timestamp}`);
        }
    }
    const visibleIds = new Set();
    groups.forEach(g => { if (g.ids.length) visibleIds.add(g.ids[g.ids.length - 1]); });
    const visible = [];
    const visibleKeys = new Set();
    for (const m of messages) {
        const k = m.id !== undefined ? String(m.id) : `${m.content}|${m.timestamp}`;
        if (m.role === 'user' || visibleIds.has(k)) {
            visible.push(m);
            visibleKeys.add(msgKey(m));
        }
    }
    return { visible, visibleKeys, groups };
}

// 切换版本：隐藏/显示组内版本，并把操作栏重新挂到当前可见版本
function moveVersionToggleTo(group) {
    group.els.forEach((el, i) => el.classList.toggle('ai-version-hidden', i !== group.currentIdx));
    attachActionsToLatestAiMessage();
}

// 现场重新生成完成后：并入最近一组，隐藏旧版本，显示新版本
function finalizeAIVersion(newEl, contactId) {
    let group = null;
    for (let i = versionGroups.length - 1; i >= 0; i--) {
        if (versionGroups[i].contactId === contactId && versionGroups[i].els.length) {
            group = versionGroups[i];
            break;
        }
    }
    if (!group) {
        group = { contactId, els: [], currentIdx: 0 };
        versionGroups.push(group);
    }
    group.els.forEach(el => el.classList.add('ai-version-hidden'));
    group.els.push(newEl);
    group.currentIdx = group.els.length - 1;
    newEl.classList.remove('ai-version-hidden');
    attachActionsToLatestAiMessage();
}

// 普通新回复：开启一个新版本组
function newVersionGroup(newEl, contactId) {
    versionGroups.push({ contactId, els: [newEl], currentIdx: 0 });
}

// 消息去重键：优先 id；AI 历史消息可能无 id，退化为 role|content|timestamp
function msgKey(msg) {
    if (msg.id !== undefined && msg.id !== null) return String(msg.id);
    return `${msg.role || 'm'}|${msg.content}|${msg.timestamp || msg.created_at || ''}`;
}

// 当用户停留在底部附近时，裁剪顶部超出上限的旧消息节点
function capDomMessages() {
    if (!chatBox) return;
    if (historyPage > 1) return; // 已翻页查看更早消息时不移除
    const nearBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 200;
    if (!nearBottom) return;
    if (chatBox.children.length <= MAX_DOM_MESSAGES) return;
    const prevTop = chatBox.scrollTop;
    const prevHeight = chatBox.scrollHeight;
    while (chatBox.children.length > MAX_DOM_MESSAGES) {
        chatBox.removeChild(chatBox.firstChild);
    }
    // 从顶部移除节点会让内容整体上移：按移除的高度把 scrollTop 同步下移（等于「视口内容不动」），
    // 否则正在看的内容会突然上跳
    const removed = prevHeight - chatBox.scrollHeight;
    if (removed > 0) setScrollTopInstant(chatBox, Math.max(0, prevTop - removed));
}

// 批量渲染（增量：只追加尚未渲染的消息；微信式时间标签；版本分组）
function renderMessages(messages, resolveSender) {
    if (!messages || messages.length === 0) return;
    const view = buildVersionView(messages);
    const elById = new Map();

    for (const msg of messages) {
        const key = msgKey(msg);
        if (renderedMsgKeys.has(key)) continue;
        renderedMsgKeys.add(key);
        const visible = view.visibleKeys.has(key);
        if (visible) {
            renderedContentSeq.push(contentKey(msg));
        }
        // 每条消息都计算自己的时间标签（嵌入元素内，隐藏版本随之隐藏）
        const labelText = timeLabelFor(msg.timestamp || msg.created_at);
        const senderName = resolveSender(msg);
        const el = buildMessageElement({
            content: msg.content,
            username: msg.role === 'user' ? (currentUser?.username || senderName) : senderName,
            created_at: msg.timestamp || msg.created_at || new Date().toISOString(),
            id: msg.id || undefined,
            kind: msg.kind, // 导演词行 → 特别气泡
        }, senderName, labelText);
        if (!visible) el.classList.add('ai-version-hidden');
        elById.set(msg.id !== undefined ? String(msg.id) : `${msg.content}|${msg.timestamp}`, el);
        chatBox.appendChild(el);
        renderedMessageCount++;
    }

    // 组装版本组（连续 assistant）并挂切换按钮
    versionGroups = [];
    let curGroup = null;
    for (const m of messages) {
        const k = m.id !== undefined ? String(m.id) : `${m.content}|${m.timestamp}`;
        const el = elById.get(k);
        if (!el) continue;
        if (m.role === 'user') {
            curGroup = null;
        } else {
            if (!curGroup) { curGroup = { contactId: currentContact?.contact_id, els: [] }; versionGroups.push(curGroup); }
            curGroup.els.push(el);
        }
    }
    for (const g of versionGroups) {
        g.currentIdx = g.els.length - 1;
        g.els.forEach((el, i) => {
            if (i !== g.currentIdx) el.classList.add('ai-version-hidden');
            else el.classList.remove('ai-version-hidden');
        });
        if (g.els.length > 1) moveVersionToggleTo(g);
    }
    capDomMessages();
}

// ========== 消息渲染 ==========
// Markdown 渲染结果缓存（LRU 上限 500 条），避免同一内容反复 marked.parse
const markdownCache = new Map();
const MARKDOWN_CACHE_MAX = 500;

// ===== Markdown 自定义渲染：**文字** / *文字* 不加粗不加斜，统一蓝色高亮 =====
let markdownRendererInstalled = false;

// 兼容新旧 marked：从 strong/em token 中解析出内部行内内容
function resolveInlineToken(token) {
    if (token && typeof token === 'object' && Array.isArray(token.tokens)) {
        return (this.parser && typeof this.parser.parseInline === 'function')
            ? this.parser.parseInline(token.tokens)
            : '';
    }
    return String(token);
}

// ===== 星号强调预处理：**文字** → 占位符 =====
// CommonMark 对强调有左右边界限制：
//  - 闭合的 ** 后面紧跟字母/中文（如 **……眯了眯眼。**老板）→ 不识别为强调
//  - 强调内容跨行（**第一行\n第二行**）→ 同样可能不识别
// 因此在 markdown 解析前把 **...** 整体替换成占位符（绕过边界规则），
// 解析完再把占位符还原成蓝色 <span class="ai-em">。
// 代码块/行内代码内的星号保持原样。
let aiEmBlocks = [];
function preprocessAiEmphasis(content) {
    aiEmBlocks = [];
    const parts = String(content).split(/(```[\s\S]*?```|`[^`\n]*`)/g);
    return parts.map((seg, i) => {
        if (i % 2 === 1) return seg; // 代码片段原样保留
        // 1) 单星号 * 文字 * 去内部空格（双星号由第 2 步占位处理，此处不会误伤）
        let s = seg.replace(/(^|[^*\w])\*\s+([^*]+?)\s+\*(?!\*)/g, '$1*$2*');
        // 2) ** 文字 **（含跨行、紧邻中文）→ 占位符
        s = s.replace(/\*\*([\s\S]*?)\*\*/g, (match, inner) => {
            aiEmBlocks.push(inner.replace(/^\s+|\s+$/g, ''));
            return '@@AIEM' + (aiEmBlocks.length - 1) + '@@';
        });
        return s;
    }).join('');
}

// 解析完成后把占位符还原为蓝色强调（内部换行 → <br>，与 breaks:true 表现一致）
function restoreAiEmphasis(html) {
    if (!aiEmBlocks || aiEmBlocks.length === 0) return html;
    return html.replace(/@@AIEM(\d+)@@/g, (m, idx) => {
        const inner = aiEmBlocks[Number(idx)];
        if (inner === undefined) return '';
        return '<span class="ai-em">' + escapeHtml(inner).replace(/\n/g, '<br>') + '</span>';
    });
}

function installMarkdownBoldHighlight() {
    if (markdownRendererInstalled || !window.marked) return;

    const blueFn = function (token) {
        return '<span class="ai-em">' + resolveInlineToken.call(this, token) + '</span>';
    };

    try {
        if (typeof marked.use === 'function') {
            // strong（**文字**）与 em（*文字*）都渲染为蓝色；
            // breaks:true → 单个换行也显示为换行（聊天场景更直观）
            marked.use({
                breaks: true,
                renderer: { strong: blueFn, em: blueFn },
            });
            markdownRendererInstalled = true;
        } else if (marked.Renderer && typeof marked.setOptions === 'function') {
            const r = new marked.Renderer();
            r.strong = blueFn;
            r.em = blueFn;
            marked.setOptions({ renderer: r, breaks: true });
            markdownRendererInstalled = true;
        }
    } catch (e) {
        console.debug('安装 markdown 蓝色强调渲染失败:', e);
    }
}

function renderMarkdown(content) {
    // 0.10.0：/me 开头的消息渲染为「动作气泡」（斜体、无底色），由 enhance.js 提供
    if (typeof renderActionText === 'function') {
        const actionHtml = renderActionText(content);
        if (actionHtml !== null) return actionHtml;
    }
    const key = String(content);
    if (markdownCache.has(key)) return markdownCache.get(key);

    // 渲染前确保自定义渲染器已安装（marked 为 defer 加载，首次渲染时已就绪）
    installMarkdownBoldHighlight();

    let html;
    try {
        if (window.marked && typeof marked.parse === 'function') {
            // 先预处理星号强调（占位符绕过 CommonMark 边界限制），再解析，最后还原蓝色
            html = restoreAiEmphasis(marked.parse(preprocessAiEmphasis(content)));
            // DOMPurify 清洗，防止 Markdown 注入 XSS（CDN 不可用时退化为纯文本转义）
            if (window.DOMPurify && typeof DOMPurify.sanitize === 'function') {
                html = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
            } else {
                html = escapeHtml(content);
            }
        } else {
            html = escapeHtml(content);
        }
    } catch (e) {
        html = escapeHtml(content);
    }

    if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
        const oldest = markdownCache.keys().next().value;
        markdownCache.delete(oldest);
    }
    markdownCache.set(key, html);
    return html;
}

// 构造消息 DOM（微信式：时间标签[可选，嵌入元素内，随版本切换正确移动] + 头像 + 气泡）
// 消息 id → 原始文本（引用预览用，第 21 项）
const messageTextById = new Map();

function buildMessageElement(msg, senderName = null, labelText = null) {
    const isCurrent = currentUser && msg.username === currentUser.username;
    const div = document.createElement('div');
    div.className = `message ${isCurrent ? 'sent' : 'received'}`;
    // Bug 3：实时 AI 回复只有客户端临时 id（local: true），这里记为 dataset.tempId，
    // 由 backfillServerIds 回填服务端真实 id；不写 dataset.id，避免被当成服务端 id 直接使用
    if (msg.local === true && msg.id !== undefined && msg.id !== null) {
        div.dataset.tempId = String(msg.id);
    } else if (msg.id !== undefined) {
        div.dataset.id = msg.id;
    }
    div.dataset.createdAt = msg.created_at;
    // 保存原始 markdown 源文本（编辑时恢复，星号标记与空行不丢失）
    div.dataset.rawContent = msg.content !== undefined && msg.content !== null ? String(msg.content) : '';
    if (msg.id !== undefined && msg.id !== null) messageTextById.set(Number(msg.id), div.dataset.rawContent);
    if (msg.reply_to) div.dataset.replyTo = String(msg.reply_to);

    // 导演词：独立于普通消息的特别气泡（无头像、虚线边框、居中）
    if (msg.kind === 'director') {
        div.className = 'message director';
        const bubble = document.createElement('div');
        bubble.className = 'msg-director';
        bubble.innerHTML = '<i class="fas fa-clapperboard"></i>';
        const span = document.createElement('span');
        span.className = 'msg-director-text';
        span.textContent = msg.content;
        bubble.appendChild(span);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'director-copy';
        copyBtn.title = '复制导演词';
        copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
        copyBtn.addEventListener('click', () => copyText(msg.content));
        bubble.appendChild(copyBtn);
        div.appendChild(bubble);
        return div;
    }

    // 时间标签放在元素内部（隐藏版本时随之隐藏，切换版本时始终位于该消息上方）
    if (labelText) {
        const label = document.createElement('div');
        label.className = 'msg-time-label';
        label.textContent = labelText;
        div.appendChild(label);
    }

    // 头像（自己 → 用户头像图；对方 → 自定义头像或单色图标；支持 images/xxx.png 相对路径）
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    const avatarSrc = isCurrent
        ? (currentUser && currentUser.avatar)
        : (currentContact && currentContact.avatar);
    if (avatarSrc) {
        const img = document.createElement('img');
        img.src = avatarSrc;
        img.alt = '';
        img.loading = 'lazy';
        // 加载失败回退为图标
        img.onerror = () => {
            const icon = isCurrent ? 'fa-user' : 'fa-robot';
            avatar.innerHTML = `<i class="fas ${icon}"></i>`;
        };
        avatar.appendChild(img);
    } else if (isCurrent) {
        const img = document.createElement('img');
        const uname = (currentUser && currentUser.username) || 'U';
        img.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(uname)}&background=555&color=fff&size=64`;
        img.alt = '';
        img.loading = 'lazy';
        avatar.appendChild(img);
    } else {
        const isAi = currentContact && currentContact.contact_type === 'ai';
        avatar.innerHTML = `<i class="fas ${isAi ? 'fa-robot' : 'fa-user'}"></i>`;
    }
    // AI 头像可点击打开设置
    if (!isCurrent && currentContact && currentContact.contact_type === 'ai') {
        avatar.classList.add('ai-avatar-btn');
        avatar.title = '点击设置 AI 参数与模型';
    }

    // 气泡
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    // 引用预览（第 21 项）：被引用消息原文缩略（最多 50 字）
    if (msg.reply_to) {
        const quoted = messageTextById.get(Number(msg.reply_to));
        const q = document.createElement('div');
        q.className = 'msg-quote';
        if (quoted) {
            q.innerHTML = '<i class="fas fa-reply"></i>';
            const qs = document.createElement('span');
            qs.textContent = quoted.replace(/\s+/g, ' ').slice(0, 50) + (quoted.length > 50 ? '…' : '');
            q.appendChild(qs);
            q.addEventListener('click', () => {
                const target = chatBox ? chatBox.querySelector(`.message[data-id="${msg.reply_to}"]`) : null;
                if (target) highlightAndScroll(target);
            });
        } else {
            q.innerHTML = '<i class="fas fa-reply"></i><span>引用的消息未加载</span>';
        }
        bubble.appendChild(q);
    }
    const textDiv = document.createElement('div');
    textDiv.className = 'message-text markdown-body';
    textDiv.innerHTML = renderMarkdown(msg.content);
    bubble.appendChild(textDiv);
    // 收藏 / 已编辑标记（第 23、25 项）
    if (msg.edited) {
        const mark = document.createElement('span');
        mark.className = 'msg-edited';
        mark.textContent = '已编辑';
        mark.title = '查看编辑历史';
        mark.addEventListener('click', () => openEditHistory(div));
        bubble.appendChild(mark);
    }

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.appendChild(avatar);
    row.appendChild(bubble);
    div.appendChild(row);
    // 收藏星标 + 已选表情
    if (favoriteIds.has(Number(msg.id))) div.classList.add('favorited');
    if (typeof renderReactionsOn === 'function') renderReactionsOn(div);
    return div;
}

function renderMessage(msg, senderName = null) {
    const labelText = timeLabelFor(msg.created_at || msg.timestamp);
    const div = buildMessageElement(msg, senderName, labelText);
    chatBox.appendChild(div);
    scrollToBottom();
    
    return div;
}

// 导演词特别气泡（乐观渲染时用；历史加载走 buildMessageElement 的 director 分支）
function renderDirectorMessage(content) {
    return renderMessage({
        role: 'user',
        username: currentUser ? currentUser.username : '导演',
        content: content,
        created_at: new Date().toISOString(),
        kind: 'director'
    }, currentUser ? currentUser.username : '导演');
}

// ========== 新增：AI 消息渲染（微信式，支持流式更新） ==========
function renderAIMessage(content, isStreaming = false, labelText = null) {
    if (labelText === null) labelText = timeLabelFor(new Date().toISOString());

    const div = document.createElement('div');
    div.className = 'message received ai-message';
    div.dataset.isStreaming = isStreaming ? 'true' : 'false';
    // 保存原始 markdown 源文本（流式完成后由 updateAIMessage 同步更新）
    div.dataset.rawContent = content !== undefined && content !== null ? String(content) : '';

    // 时间标签嵌入元素内（隐藏版本随之隐藏，切换版本时始终位于该消息上方）
    if (labelText) {
        const label = document.createElement('div');
        label.className = 'msg-time-label';
        label.textContent = labelText;
        div.appendChild(label);
    }

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    // 支持自定义头像图片（images/xxx.png）
    if (currentContact && currentContact.avatar) {
        const img = document.createElement('img');
        img.src = currentContact.avatar;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => { avatar.innerHTML = '<i class="fas fa-robot"></i>'; };
        avatar.appendChild(img);
    } else {
        avatar.innerHTML = '<i class="fas fa-robot"></i>';
    }
    // AI 头像可点击打开设置（与 buildMessageElement 一致）
    avatar.classList.add('ai-avatar-btn');
    avatar.title = '点击设置 AI 参数与模型';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    const textDiv = document.createElement('div');
    textDiv.className = 'message-text markdown-body';
    // 流式状态用纯文本，完成后再渲染 Markdown
    textDiv.innerHTML = isStreaming ? escapeHtml(content) : renderMarkdown(content);
    bubble.appendChild(textDiv);
    if (isStreaming) {
        const badge = document.createElement('span');
        badge.className = 'streaming-badge';
        badge.textContent = '正在思考';
        bubble.appendChild(badge);
    }

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.appendChild(avatar);
    row.appendChild(bubble);
    div.appendChild(row);

    chatBox.appendChild(div);
    scrollToBottom();
    return div;
}

function updateAIMessage(element, content, isComplete = false) {
    if (!element) return;
    const textDiv = element.querySelector('.message-text');
    if (textDiv) {
        // 流式过程中显示纯文本（避免闪烁），完成后渲染 Markdown
        if (isComplete) {
            textDiv.innerHTML = renderMarkdown(content);
            element.dataset.rawContent = content !== undefined && content !== null ? String(content) : '';
        } else {
            textDiv.textContent = content;
        }
    }
    if (isComplete) {
        element.dataset.isStreaming = 'false';
        const badge = element.querySelector('.streaming-badge');
        if (badge) badge.remove();
    }
    scrollToBottom();
}

// ======================== 联系人列表加载 ========================
async function loadContacts() {
  if (!getAuthToken()) return; // 无 token 直接返回

  // 1. 尝试从缓存加载
  const cached = getContactsCache();
  if (cached && cached.length > 0) {
    contacts = cached;
    renderContacts();
    // 后台静默刷新
    refreshContactsInBackground();
    return;
  }

  // 2. 缓存未命中，请求服务器
  try {
    const res = await fetchWithAuth('/api/contacts');
    contacts = await res.json();
    setContactsCache(contacts);
    renderContacts();
  } catch (err) {
    if (err.message !== '未授权') {
      console.error('加载联系人失败:', err);
      if (contactsList) {
        contactsList.innerHTML = '<div class="error-tip">加载失败，请刷新</div>';
      }
    }
  }
}

// 新增辅助函数：后台刷新联系人
async function refreshContactsInBackground() {
  try {
    const res = await fetchWithAuth('/api/contacts');
    const newContacts = await res.json();
    contacts = newContacts;
    setContactsCache(newContacts);
    if (currentContact) {
      const updatedCurrent = contacts.find(c => c.contact_id === currentContact.contact_id);
      if (updatedCurrent && chatHeader) {
        chatHeader.textContent = updatedCurrent.display_name;
      }
    }
    renderContacts();
  } catch (e) {
    if (e.message !== '未授权') {
      console.debug('后台刷新联系人失败:', e);
    }
  }
}



function renderContacts() {
    if (!contactsList) return;
    contactsList.innerHTML = '';

    if (contacts.length === 0) {
        contactsList.innerHTML = '<div class="empty-tip">暂无联系人</div>';
        return;
    }

    contacts.forEach(contact => {
        const div = document.createElement('div');
        div.className = 'contact-item';
        div.dataset.contactType = contact.contact_type;
        div.dataset.contactId = contact.contact_id;
        div.dataset.id = contact.id;
        const icon = contact.contact_type === 'ai' ? 'fa-robot' : 'fa-user';
        const avatarHtml = contact.avatar
            ? `<img src="${escapeHtml(contact.avatar)}" alt="">`
            : `<i class="fas ${icon}"></i>`;
        div.innerHTML = `
            <span class="contact-avatar">${avatarHtml}</span>
            <span class="contact-name">${escapeHtml(contact.display_name)}</span>
            <span class="contact-badge">${contact.contact_type === 'ai' ? 'AI' : '用户'}</span>
        `;
        div.addEventListener('click', () => selectContact(contact));
        contactsList.appendChild(div);
    });

    // 选中当前联系人（如果有）
    if (currentContact) {
        const targetEl = findContactItem(currentContact.contact_id);
        if (targetEl) targetEl.classList.add('active');
    } else if (contacts.length > 0) {
        selectContact(contacts[0]);
    }
}

// 通过 dataset 精确查找联系人元素（避免用 contact_id 拼接 CSS 选择器造成注入/误匹配）
function findContactItem(contactId) {
    const items = document.querySelectorAll('.contact-item');
    for (const el of items) {
        if (el.dataset.contactId === contactId) return el;
    }
    return null;
}

// ======================== 选择联系人 ========================
function selectContact(contact) {
    currentContact = contact;
    
    // 更新 UI 高亮
    document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
    const targetEl = findContactItem(contact.contact_id);
    if (targetEl) targetEl.classList.add('active');
    
    // 更新聊天头部
    if (chatHeader) chatHeader.textContent = contact.display_name;
    if (chatSubheader) {
        chatSubheader.textContent = contact.contact_type === 'ai' ? 'AI 对话 · 流式输出' : '用户对话';
    }
    
    // 根据类型显示/隐藏模式切换
    if (modeSelector) {
        modeSelector.style.display = contact.contact_type === 'ai' ? 'none' : 'flex';
    }

    // 移动端：选中联系人后自动关闭抽屉
    if (isMobileView()) closeMobileSidebar();
    
    // 标题栏按钮：AI 联系人显示「模型设置 / 删除聊天记录」
    const isAiContact = contact.contact_type === 'ai';
    const chatAiBtn = document.getElementById('chatAiSettingsBtn');
    const clearBtn = document.getElementById('clearHistoryBtn');
    const commitBtn = document.getElementById('commitmentsBtn');
    const favBtn = document.getElementById('favoritesBtn');
    const exportBtn2 = document.getElementById('exportBtn');
    if (chatAiBtn) chatAiBtn.style.display = isAiContact ? 'inline-flex' : 'none';
    if (clearBtn) clearBtn.style.display = isAiContact ? 'inline-flex' : 'none';
    if (commitBtn) commitBtn.style.display = isAiContact ? 'inline-flex' : 'none';
    if (favBtn) favBtn.style.display = isAiContact ? 'inline-flex' : 'none';
    if (exportBtn2) exportBtn2.style.display = 'inline-flex';
    // 收藏标记与表情回应随联系人刷新（第 23、24 项）
    if (typeof syncFavorites === 'function') syncFavorites();
    if (typeof loadReactions === 'function') loadReactions();

    // 清空聊天框
    if (chatBox) chatBox.innerHTML = '';
    
    // 停止所有接收器
    stopAllReceivers();
    
    // 如果是 AI，强制 SSE
    if (isAiContact) {
        receiveMode = 'sse';
        localStorage.setItem('receiveMode', 'sse');
        updateOnlineCount(true); // 乐观显示 1 人在线，加载失败时改为 0
        if (currentModeDisplay) currentModeDisplay.textContent = 'sse (AI)';
        // 更新模式按钮高亮
        document.querySelectorAll('.mode-options .settings-option-btn').forEach(btn => {
            if (btn.dataset.mode === 'sse') btn.classList.add('active');
            else btn.classList.remove('active');
        });
        statusSpan.textContent = '模式: SSE (AI)';
    } else {
        // 真人：恢复用户选择的模式
        receiveMode = localStorage.getItem('receiveMode') || 'sse';
        if (currentModeDisplay) currentModeDisplay.textContent = receiveMode;
        statusSpan.textContent = `模式: ${receiveMode}`;
        switchReceiveMode(receiveMode);
    }
    
    // 加载历史消息
    loadMessagesForContact(contact);

    // 恢复该联系人的输入草稿（第 27 项）
    if (typeof restoreDraft === 'function') restoreDraft();
}

// ============================================================
// AI 消息 id 回填（Bug 3 修复）
// 实时 AI 回复只有客户端临时 id（Date.now()），服务端真实 id 要等落库后才知道。
// 这里把临时 id 与服务端历史按「内容 + 时间窗口（±5s）」匹配，回写 dataset.id，
// 从而消除「同内容回复按 content 回查命中错误消息」的串位问题。
// ============================================================
const pendingAiReplies = new Map();              // key: 临时 id，value: { content, timestamp }
const SERVER_ID_MATCH_WINDOW_MS = 5 * 1000;      // 内容 + 时间的匹配窗口：±5s
const PENDING_REPLY_MAX_AGE_MS = 10 * 60 * 1000; // 超时未回填的临时记录直接丢弃（防残留）

// 时间戳解析：兼容 ISO 与 SQLite CURRENT_TIMESTAMP（"YYYY-MM-DD HH:MM:SS"，UTC）
function parseMsgTime(value) {
    if (!value) return NaN;
    const s = String(value);
    const norm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
    const t = new Date(norm).getTime();
    return Number.isNaN(t) ? NaN : t;
}

// 从服务端历史倒序池中按「内容 + 时间窗口」找最接近的一条；
// used 记录已被占用的服务端 id，避免两条临时消息抢同一条历史记录。
function matchServerMessage(pool, content, timestamp, used) {
    const wanted = String(content || '').replace(/【删除记忆[:：]\s*\d+】/g, '').trim();
    const t = parseMsgTime(timestamp);
    if (!wanted || Number.isNaN(t)) return null;
    let best = null;
    let bestDiff = Infinity;
    for (const msg of pool) {
        if (!msg || msg.id === undefined || msg.id === null) continue;
        if (used && used.has(String(msg.id))) continue;
        const text = String(msg.content || '').replace(/【删除记忆[:：]\s*\d+】/g, '').trim();
        if (text !== wanted) continue;
        const mt = parseMsgTime(msg.timestamp || msg.created_at);
        if (Number.isNaN(mt)) continue;
        const diff = Math.abs(mt - t);
        if (diff <= SERVER_ID_MATCH_WINDOW_MS && diff < bestDiff) {
            best = msg;
            bestDiff = diff;
        }
    }
    return best;
}

// 把 DOM 上带临时 id 的 AI 回复回填为服务端真实 id（messages：服务端历史，升序）
function backfillServerIds(messages) {
    if (!chatBox || !Array.isArray(messages) || messages.length === 0) return;
    const pool = messages
        .filter(m => m && m.role === 'assistant' && m.id !== undefined && m.id !== null)
        .reverse();
    if (pool.length === 0) return;

    // 丢弃超时未回填的临时记录（断网、服务端未落库等），避免 Map 无限增长
    const now = Date.now();
    for (const [tempId, entry] of pendingAiReplies) {
        const t = parseMsgTime(entry && entry.timestamp);
        if (Number.isNaN(t) || now - t > PENDING_REPLY_MAX_AGE_MS) pendingAiReplies.delete(tempId);
    }

    const used = new Set();
    chatBox.querySelectorAll('.message[data-temp-id]').forEach(div => {
        const tempId = div.dataset.tempId;
        if (!tempId) return;
        const pending = pendingAiReplies.get(tempId);
        const content = pending ? pending.content : (div.dataset.rawContent || '');
        const timestamp = pending ? pending.timestamp : div.dataset.createdAt;
        const hit = matchServerMessage(pool, content, timestamp, used);
        if (!hit) return;
        used.add(String(hit.id));
        div.dataset.id = String(hit.id);
        delete div.dataset.tempId;
        pendingAiReplies.delete(tempId);
    });

    // 收藏星标按真实 id 重新标记（用临时 id 渲染时无法匹配 favoriteIds）
    if (typeof refreshFavoriteMarks === 'function') refreshFavoriteMarks();
}

// ======================== 加载联系人历史消息（增量渲染） ========================
async function loadMessagesForContact(contact) {
  if (!getAuthToken() || !contact) return;

  // 切换联系人：重置增量渲染状态
  resetMessageRenderState();
  if (chatBox) chatBox.innerHTML = '';

  const sessionVersion = sessionStorage.getItem('sessionVersion') || '';
  const cacheKey = `pchat_history_${contact.contact_id}`;
  const raw = localStorage.getItem(cacheKey);
  let localHistory = [];
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (data.version === sessionVersion) {
        localHistory = data.messages || [];
      } else {
        localStorage.removeItem(cacheKey);
      }
    } catch (e) {
      localStorage.removeItem(cacheKey);
    }
  }

  const senderResolver = (msg) => msg.role === 'user' ? (currentUser?.username || contact.display_name) : contact.display_name;

  // 先渲染本地缓存（快速响应）
  if (localHistory.length > 0) {
    renderMessages(localHistory, senderResolver);
    statusSpan.textContent = '已加载本地缓存';
  } else {
    const greeting = contact.contact_type === 'ai' ? '👋 开始与 AI 对话吧！' : '暂无消息，开始聊天吧';
    addSystemMessage(greeting);
  }
  // 首屏立刻贴底（同步定位）：不要等服务器返回再滚到底，否则会先看到顶部再被拽到底部
  pinChatToBottom();

  // 从服务器拉取最新数据，仅增量追加（不再全量重绘）
  try {
    let url;
    if (contact.contact_type === 'ai') {
      url = `/api/ai/history?contact=${contact.contact_id}`;
    } else {
      url = `/api/messages?contact_type=${contact.contact_type}&contact_id=${contact.contact_id}`;
    }
    const res = await fetchWithAuth(url);
    const data = await res.json();

    // 竞态防护：请求期间用户切换了联系人 → 丢弃本次结果
    if (currentContact !== contact) return;

    const serverMessages = Array.isArray(data) ? data : (data.messages || []);

    // 更新本地缓存
    localStorage.setItem(cacheKey, JSON.stringify({
      version: sessionVersion,
      messages: serverMessages.slice(-50)
    }));

    // 用户此刻是否停留在底部：同步过程中若已向上翻历史，就不要把他拽回底部
    const stickToBottom = isNearBottom(chatBox);

    // —— 与服务端做“内容序列”比对，避免刷新时因 id/时间戳不一致导致重复渲染 ——
    // 比对使用“可见版本”序列（重新生成产生的旧版本不参与）
    const serverSeq = buildVersionView(serverMessages).visible.map(contentKey);
    const renderedSeq = renderedContentSeq;
    const isPrefix = renderedSeq.length <= serverSeq.length &&
        renderedSeq.every((k, i) => k === serverSeq[i]);

    if (renderedSeq.length === serverSeq.length && isPrefix) {
      // 完全一致：无需任何操作（本地缓存渲染的内容与服务器相同）
      statusSpan.textContent = '已是最新';
    } else if (isPrefix) {
      // 服务器只是多出尾部（新消息）→ 仅增量追加
      renderMessages(serverMessages.slice(renderedSeq.length), senderResolver);
      statusSpan.textContent = '已同步新消息';
    } else {
      // 不一致（远端被清空/内容变化）→ 以服务器为准全量重建
      renderedMsgKeys = new Set();
      renderedMessageCount = 0;
      renderedContentSeq = [];
      if (chatBox) chatBox.innerHTML = '';
      if (serverMessages.length === 0) {
        const greeting = contact.contact_type === 'ai' ? '👋 开始与 AI 对话吧！' : '暂无消息，开始聊天吧';
        addSystemMessage(greeting);
      } else {
        renderMessages(serverMessages, senderResolver);
      }
      statusSpan.textContent = '已从服务器同步';
    }
    if (data.totalPages !== undefined) historyTotalPages = data.totalPages;

    // Bug 3：服务端历史到手 → 把 DOM 上的临时 id 回填为真实 id
    backfillServerIds(serverMessages);

    // 为最新一条可见消息挂载操作按钮
    attachActionsToLatestAiMessage();

    // 同步完成：仍在底部就贴底显示新消息；已经在看历史则保持当前视口不动
    if (stickToBottom) pinChatToBottom();
    if (jumpBottomBtn) jumpBottomBtn.classList.toggle('show', !isNearBottom(chatBox));
    // 在线状态：能拉到历史说明服务正常
    if (contact.contact_type === 'ai') updateOnlineCount(true);
  } catch (err) {
    if (err.message !== '未授权') {
      console.error('同步历史消息失败:', err);
      if (contact.contact_type === 'ai') updateOnlineCount(false);
      if (renderedMessageCount === 0) {
        addSystemMessage('加载历史消息失败，但您可以继续聊天');
      }
    }
  }
}

// ======================== 加载更早的 AI 历史（滚动到顶部触发） ========================
async function loadEarlierHistory() {
  if (!currentContact || currentContact.contact_type !== 'ai') return;
  if (!chatBox) return;
  if (loadingEarlier) return;
  if (historyPage >= historyTotalPages) return;

  loadingEarlier = true;
  try {
    const nextPage = historyPage + 1;
    const res = await fetchWithAuth(`/api/ai/history?contact=${currentContact.contact_id}&page=${nextPage}`);
    const data = await res.json();
    const messages = data.messages || [];
    historyTotalPages = data.totalPages || historyTotalPages;

    if (messages.length > 0) {
      // 用「插入前后 scrollHeight 的差值」保持视口位置：比 sentinel.offsetTop 更可靠
      // （offsetTop 依赖 offsetParent，遇到定位祖先/内边距会算偏，表现为加载后视口上跳）
      const prevTop = chatBox.scrollTop;
      const prevHeight = chatBox.scrollHeight;
      const frag = document.createDocumentFragment();

      // Bug 2：更早的消息是按「旧 → 新」插入的，这里用局部变量 prevTime 推算时间标签，
      // 不读写全局 lastRenderedMsgTime，避免污染聊天底部新消息的时间标签
      let prevTime = null;
      for (const msg of messages) {
        const key = msgKey(msg);
        if (renderedMsgKeys.has(key)) continue;
        renderedMsgKeys.add(key);
        const msgTime = msg.timestamp || msg.created_at;
        const { text: labelText, nextTime } = computeTimeLabel(msgTime, prevTime);
        prevTime = nextTime;
        const senderName = msg.role === 'user' ? (currentUser?.username || currentContact.display_name) : currentContact.display_name;
        const el = buildMessageElement({
          content: msg.content,
          username: msg.role === 'user' ? (currentUser?.username || currentContact.display_name) : currentContact.display_name,
          created_at: msgTime || new Date().toISOString(),
          id: msg.id || undefined,
        }, senderName, labelText);
        frag.appendChild(el);
        renderedMessageCount++;
      }

      // 一次性插入（DocumentFragment）：避免逐条插入触发多次重排
      if (frag.childNodes.length > 0) {
        chatBox.insertBefore(frag, chatBox.firstChild);
        const added = chatBox.scrollHeight - prevHeight;
        // 同步下移相同高度（瞬时，无平滑动画）：旧消息仍在原来的视觉位置，不会上跳/乱跳
        if (added > 0) setScrollTopInstant(chatBox, prevTop + added);
      }
      historyPage = nextPage;
      statusSpan.textContent = `已加载更早消息（第 ${historyPage} 页）`;
    }
  } catch (err) {
    if (err.message !== '未授权') {
      console.error('加载更早消息失败:', err);
    }
  } finally {
    loadingEarlier = false;
  }
}

// ======================== 消息接收模式控制 ========================
function stopAllReceivers() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (longPollActive) longPollActive = false;
    if (aiStreamReader) { 
        aiStreamReader.cancel(); 
        aiStreamReader = null; 
    }
    // 停止打字机（切换联系人时避免继续往旧气泡吐字）
    if (aiTypingTimer) { clearInterval(aiTypingTimer); aiTypingTimer = null; }
}

function startSSE() {
    if (!token) return;
    if (!currentContact || currentContact.contact_type === 'ai') return; // AI 用专用流
    eventSource = new EventSource(`/api/messages/stream?token=${encodeURIComponent(token)}`);
    eventSource.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        // 只显示当前联系人的消息
        if (msg.contact_id === currentContact?.contact_id || msg.username !== currentUser?.username) {
            renderMessage(msg);
        }
    };
    eventSource.onerror = () => {
        if (eventSource) eventSource.close();
        eventSource = null;
        setTimeout(() => { if (receiveMode === 'sse') startSSE(); }, 3000);
    };
}

function startShortPolling() {
    let lastTime = new Date().toISOString();
    pollInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/messages?since=${encodeURIComponent(lastTime)}`);
            const msgs = await res.json();
            if (msgs.length) {
                msgs.forEach(msg => {
                    if (msg.contact_id === currentContact?.contact_id || msg.username !== currentUser?.username) {
                        renderMessage(msg);
                    }
                });
                lastTime = msgs[msgs.length - 1].created_at;
            }
        } catch (err) {}
    }, 3000);
}

async function longPollLoop() {
    if (!longPollActive) return;
    const lastMsg = document.querySelector('.message:last-child');
    const lastId = lastMsg ? parseInt(lastMsg.dataset.id) : 0;
    try {
        const res = await fetch(`/api/messages/long-poll?lastId=${lastId}`);
        const data = await res.json();
        if (data && !data.timeout && data.id) {
            if (data.contact_id === currentContact?.contact_id || data.username !== currentUser?.username) {
                renderMessage(data);
            }
        }
    } catch (err) {
        console.error('长轮询错误:', err);
    }
    if (longPollActive) {
        setTimeout(longPollLoop, 500);
    }
}

function startLongPolling() {
    if (longPollActive) return;
    longPollActive = true;
    longPollLoop();
}

function switchReceiveMode(mode) {
    if (currentContact?.contact_type === 'ai') {
        statusSpan.textContent = 'AI 使用 SSE 模式';
        return;
    }
    const originalStatus = statusSpan.textContent;
    statusSpan.textContent = `切换模式至 ${mode}...`;
    receiveMode = mode;
    localStorage.setItem('receiveMode', mode);
    stopAllReceivers();
    setTimeout(() => {
        if (mode === 'sse') startSSE();
        else if (mode === 'short') startShortPolling();
        else if (mode === 'long') startLongPolling();
        statusSpan.textContent = `模式: ${mode}`;
        if (currentModeDisplay) currentModeDisplay.textContent = mode;
        document.querySelectorAll('.mode-options .settings-option-btn').forEach(btn => {
            if (btn.dataset.mode === mode) btn.classList.add('active');
            else btn.classList.remove('active');
        });
    }, 50);
}

// ======================== 发送消息 ========================
async function sendMessage() {
    // 生成中拦截：发送按钮与 Enter 键都走这里
    if (isGenerating) { showToast('正在生成中，请稍候', 'info'); return; }

    const raw = msgInput.value;
    const content = raw.trim();
    if (!token || !currentContact) return;

    // 0.10.0：本地彩蛋指令（/help /roll /coin /pick /time）
    // 由 enhance.js 提供；返回 true 表示这条输入已在本地消费，不发送到服务端。
    // 其余指令（/cmd 、/me ）仍走原有逻辑。
    if (typeof handleLocalCommand === 'function' && handleLocalCommand(raw)) {
        if (msgInput) {
            msgInput.value = '';
            msgInput.style.height = 'auto';
        }
        clearDraft();
        if (msgInput) msgInput.focus();
        return;
    }

    // /cmd 指令：消息【以 "/cmd "（带空格）开头】→ 剩余部分作为导演词，且不产生普通消息
    // （导演词可单独发送；开头有换行则不识别为指令，作为普通消息）
    let director = directorInput ? directorInput.value.trim() : '';
    let message = content;
    if (raw.startsWith('/cmd ')) {
        const rest = content.slice(5).trim();
        director = rest;
        message = '';
    }
    if (!message && !director) return;

    // 真人联系人没有导演词概念：仅发送普通消息
    if (currentContact.contact_type !== 'ai') {
        if (!message) { showToast('请先输入消息', 'info'); return; }
        director = '';
    }

    // 显示发送中动画
    sendButton.disabled = true;
    const originalBtnHtml = sendButton.innerHTML;
    sendButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 发送中...';
    
    try {
        if (currentContact.contact_type === 'ai') {
            // ===== AI 对话（流式 SSE） =====
            await sendAIMessage(message, { director });
        }
        else {
            // 普通消息：乐观渲染 + 失败自动出现"重新发送"
            await sendHumanMessage(message, currentContact.contact_type, currentContact.contact_id);
        }
    } catch (err) {
        if (err.message !== '未授权') {
            console.error('发送消息错误:', err);
            addSystemMessage('发送失败: ' + err.message);
        }
    } finally {
        sendButton.disabled = false;
        sendButton.innerHTML = originalBtnHtml;
        // 发送成功：清空输入与导演词（导演词仅本次对话生效）
        if (msgInput) {
            msgInput.value = '';
            msgInput.style.height = 'auto';
        }
        clearDraft();   // 发送后清空草稿（第 27 项）
        // Turnstile 令牌一次性，发送后重置（第 9 项）
        //if (typeof resetTurnstile === 'function') resetTurnstile('turnstile-chat');
        if (directorInput) directorInput.value = '';
        // 引用只对本次发送生效
        if (typeof clearReplyTarget === 'function') clearReplyTarget();
        if (msgInput) msgInput.focus();
    }
}

// ======================== AI 消息发送（流式） ========================
// options.continueMode = true ：不渲染/不缓存“继续”这条用户消息，仅产生 AI 续写气泡
// options.regenerate  = true ：以最后一条用户消息重新生成，旧回复保留并进入版本组
async function sendAIMessage(content, options = {}) {
    const continueMode = options.continueMode === true;
    const regenerateMode = options.regenerate === true;
    const director = (typeof options.director === 'string') ? options.director : '';
    // 自定义重新生成指令（第 22 项）：仅本次生成生效
    const instruction = (typeof options.instruction === 'string') ? options.instruction : '';
    if (!continueMode && !regenerateMode && aiStreamReader) {
        showToast('正在生成中，请稍候', 'info');
        return;
    }

    // 捕获发送时的联系人：流式期间用户可能切换联系人，
    // 缓存写入与 UI 收尾都以本快照为准，防止串到其他会话
    const contactAtStart = currentContact;
    const contactIdAtStart = currentContact ? currentContact.contact_id : null;

    // 1. 获取 AI 配置（从缓存）
    const cached = getContactsCache();
    const contactConfig = cached ? cached.find(c => c.contact_id === contactIdAtStart) : null;
    const config = {
        temperature: contactConfig?.temperature ?? 0.7,
        top_p: contactConfig?.top_p ?? 0.9,
        max_tokens: contactConfig?.max_tokens ?? 2048,
        frequency_penalty: contactConfig?.frequency_penalty ?? 0,
        presence_penalty: contactConfig?.presence_penalty ?? 0,
        memory_window: contactConfig?.memory_window ?? 30,
        context_window: contactConfig?.context_window ?? 20,
    };

    // 2. 显示用户消息（继续/重新生成模式不显示新用户消息）
    let userDiv = null;
    if (!continueMode && !regenerateMode) {
        // 普通消息（有的话）
        if (content) {
            const userMsg = {
                role: 'user',
                content: content,
                timestamp: new Date().toISOString(),
                id: Date.now(),
                kind: 'normal',
                reply_to: replyTarget && replyTarget.id ? replyTarget.id : null,
            };
            userDiv = renderMessage({
                content: userMsg.content,
                username: currentUser.username,
                created_at: userMsg.timestamp,
                id: userMsg.id,
                kind: 'normal',
                reply_to: userMsg.reply_to,
            }, currentUser.username);
            appendChatMessageCache(contactIdAtStart, userMsg);
        }
        // 导演词：特别气泡（位于普通消息下方，仅当前会话展示，不落库/不写缓存）
        if (director) {
            renderDirectorMessage(director);
        }
        msgInput.value = '';
    }

    // 3. 创建 AI 消息占位
    const aiMsgDiv = renderAIMessage('', true);
    // Bug 3：实时 AI 回复先分配客户端临时 id（服务端 id 要流式结束后才落库），
    // 记在 dataset.tempId 上，由 backfillServerIds 在拿到服务端历史后回填真实 id
    const aiTempId = Date.now() + 1;
    if (aiMsgDiv) aiMsgDiv.dataset.tempId = String(aiTempId);
    let fullReply = '';
    let lastFinishReason = null;
    let streamDone = false;

    // ---- 打字机效果（第 19 项）：按字符逐字显示，速度略慢于真实阅读速度 ----
    const TYPING_MS = 30;          // 每 tick 间隔
    let typingBuffer = '';         // 待显示字符
    let displayedText = '';        // 已显示字符
    let typingTimer = null;        // 定时器（全局变量便于切换联系人时清理）
    const typeTick = () => {
        if (typingBuffer.length === 0) {
            if (streamDone) {
                clearInterval(typingTimer);
                typingTimer = null;
                aiTypingTimer = null;
                // 全部吐完 → 渲染 markdown（蓝色强调等）
                updateAIMessage(aiMsgDiv, fullReply, true);
            }
            return;
        }
        // 积压过多时加速（最多一次 6 字），避免长回复等待过久
        const step = typingBuffer.length > 240 ? 6 : typingBuffer.length > 120 ? 3 : 1;
        for (let i = 0; i < step && typingBuffer.length > 0; i++) {
            const cp = typingBuffer.codePointAt(0);
            const ch = String.fromCodePoint(cp);
            typingBuffer = typingBuffer.slice(ch.length);
            displayedText += ch;
        }
        updateAIMessage(aiMsgDiv, displayedText, false);
    };
    const startTyping = () => {
        if (typingTimer) return;
        typingTimer = setInterval(typeTick, TYPING_MS);
        aiTypingTimer = typingTimer;
    };

    try {
        // 进入生成态：放在 try 首行 —— 从这里到 finally 之间任何抛出都会复位，
        // 不会因「置位后、进 try 前」的同步渲染异常（如 localStorage 配额超限）把标志卡死。
        // 本行之前没有 await，连点/双击的第二次调用不可能插进来，原子性不受影响。
        isGenerating = true;

        const token = getAuthToken();
        if (!token) throw new Error('未登录');

        const res = await fetch('/api/ai/stream', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            message: content,
            contact: contactIdAtStart,
            config: config,
            director: director,
            reply_to: replyTarget && replyTarget.id ? replyTarget.id : undefined,
            regenerate_instruction: instruction || undefined,
            // 第 9 项：Turnstile 令牌（未配置站点密钥时为空，后端自动跳过）
            //turnstile_token: (typeof getTurnstileToken === 'function') ? getTurnstileToken('turnstile-chat') : '',
            continue: continueMode,
            regenerate: regenerateMode,
            provider: getProviderPayload()
        })
        });

        if (res.status === 401) {
        sessionStorage.clear();
        await showAlert('登录已过期，请重新登录');
        window.location.reload();
        throw new Error('未授权');
        }

        if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'AI 请求失败');
        }


        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        aiStreamReader = reader;

        // 行缓冲：SSE 事件可能被网络分块切断在 JSON 中间，
        // 必须跨 chunk 保留未完成的行，等下一块补齐后再解析，否则会丢字
        let lineBuffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // stream:true 保证多字节 UTF-8 字符跨块时不产生乱码
            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop() || ''; // 最后一段可能不完整，留给下一块

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const json = JSON.parse(line.slice(6));
                        // 安全词触发标记（服务端下发的自定义 SSE 事件）
                        if (json.dsh_safeword) {
                            showToast('🛑 安全词已触发，已中止角色扮演', 'info');
                            addSystemMessage('安全词已触发：本次回复已切换为冷静、中性的语气');
                        }
                        if (json.choices && json.choices[0].finish_reason) {
                            lastFinishReason = json.choices[0].finish_reason;
                        }
                        if (json.choices && json.choices[0].delta && json.choices[0].delta.content) {
                            const delta = json.choices[0].delta.content;
                            fullReply += delta;
                            typingBuffer += delta;
                            startTyping();
                            // 首个字到达 → 气泡内提示"正在输入…"
                            const badge = aiMsgDiv ? aiMsgDiv.querySelector('.streaming-badge') : null;
                            if (badge && badge.textContent !== '正在输入…') badge.textContent = '正在输入…';
                        }
                    } catch (e) {}
                }
            }
        }

        // 冲刷解码器，处理最后一个无换行结尾的事件
        lineBuffer += decoder.decode();
        if (lineBuffer.trim() && lineBuffer.startsWith('data: ')) {
            try {
                const json = JSON.parse(lineBuffer.slice(6));
                if (json.choices && json.choices[0].finish_reason) {
                    lastFinishReason = json.choices[0].finish_reason;
                }
                if (json.choices && json.choices[0].delta && json.choices[0].delta.content) {
                    const delta = json.choices[0].delta.content;
                    fullReply += delta;
                    typingBuffer += delta;
                }
            } catch (e) {}
        }

        // 流结束：置位 streamDone，让打字机把剩余字符吐完后再渲染 markdown
        streamDone = true;
        startTyping();
        // 流成功 → 在线
        updateOnlineCount(true);

        // 达到 max_tokens 被截断时给出提示
        if (lastFinishReason === 'length') {
            const hint = document.createElement('div');
            hint.className = 'ai-truncated-hint';
            hint.textContent = '已达到单次回复长度上限，可点击下方「继续」延伸';
            aiMsgDiv.appendChild(hint);
        }

        // 保存到本地缓存（继续/重新生成模式同样保存续写结果；按发送时的联系人写入，防止串会话）
        // local: true —— 这里的 id 只是客户端临时 id，下次加载时由服务端历史回填真实 id
        const aiMsg = {
            role: 'assistant',
            content: fullReply,
            timestamp: new Date().toISOString(),
            id: aiTempId,
            local: true
        };
        appendChatMessageCache(contactIdAtStart, aiMsg);

        // 竞态防护：流式期间切换了联系人 → 不再操作当前聊天区
        if (currentContact !== contactAtStart) return;

        // Bug 3：登记「临时 id → 内容/时间戳」，供 backfillServerIds 匹配服务端真实 id。
        // 只在流式成功且仍停留在同一会话、且确实有回复时登记：断网/失败不会留下残留。
        if (fullReply) {
            pendingAiReplies.set(String(aiTempId), { content: fullReply, timestamp: aiMsg.timestamp });
        }

        // 版本归属：重新生成 → 并入最近版本组（旧回复隐藏，气泡右下角出现切换按钮）；
        // 普通/继续 → 开启新版本组
        if (regenerateMode) {
            finalizeAIVersion(aiMsgDiv, contactIdAtStart);
        } else {
            newVersionGroup(aiMsgDiv, contactIdAtStart);
        }
        // 操作按钮挂到最新一条可见消息下
        attachActionsToLatestAiMessage();

    } catch (err) {
        // 出错时停止打字机，避免继续吐字覆盖错误提示
        if (typingTimer) { clearInterval(typingTimer); typingTimer = null; aiTypingTimer = null; }
        if (err.message !== '未授权') {
            console.error('AI 流式错误:', err);
            updateAIMessage(aiMsgDiv, '⚠️ ' + err.message, true);
            updateOnlineCount(false); // API 不可达 → 0 人在线
            // 普通发送失败：移除失败的 AI 占位，给用户消息挂"重新发送"
            if (!continueMode && !regenerateMode) {
                aiMsgDiv.remove();
                if (userDiv) {
                    // 第 7 个入口：失败重发的「重新发送」按钮（只在发送失败后渲染，此时标志必为 false）
                    markSendFailed(userDiv, () => {
                        if (isGenerating) { showToast('正在生成中，请稍候', 'info'); return; }
                        sendAIMessage(content, {});
                    });
                    addSystemMessage('发送失败: ' + err.message);
                }
            }
        }
    } finally {
        aiStreamReader = null;
        // 退出生成态：成功、失败、提前 return（切换联系人）都会走到这里
        isGenerating = false;
    }
}

// ======================== 消息操作（继续 / 编辑 / 重新生成） ========================

// 把操作按钮挂到【最新一条可见消息】下（无论是我发的还是 AI 发的）
function attachActionsToLatestAiMessage() {
    if (!chatBox || !currentContact) return;
    chatBox.querySelectorAll('.ai-actions').forEach(el => el.remove());
    const msgs = [...chatBox.querySelectorAll('.message:not(.system):not(.director)')]
        .filter(el => !el.classList.contains('ai-version-hidden'));
    if (msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    addMessageActions(last, currentContact.contact_id, last.classList.contains('sent'));
}

// 给消息挂操作按钮（最新一条可见消息）：
// 我的消息 → [复制][编辑]；AI 消息 → [版本胶囊] + [复制][继续][编辑][重新生成]
function addMessageActions(div, contactId, isUserMsg) {
    if (!div) return;
    const existing = div.querySelector('.ai-actions');
    if (existing) existing.remove();

    const actions = document.createElement('div');
    actions.className = 'ai-actions';

    // 版本胶囊（AI 多版本组时显示，放在最前）
    if (!isUserMsg) {
        const group = versionGroups.find(g => g.els.includes(div));
        if (group && group.els.length > 1) {
            const verBtn = document.createElement('button');
            verBtn.className = 'ai-action-btn ai-version-pill';
            verBtn.title = '切换版本';
            verBtn.innerHTML = `‹ ${group.currentIdx + 1}/${group.els.length} ›`;
            verBtn.addEventListener('click', () => {
                group.currentIdx = (group.currentIdx + 1) % group.els.length;
                moveVersionToggleTo(group);
            });
            actions.appendChild(verBtn);
        }
    }

    // 复制（保留原始 markdown 源文本：星号、/cmd 等标识符不丢失）
    const copyBtn = document.createElement('button');
    copyBtn.className = 'ai-action-btn';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i> 复制';
    copyBtn.title = '复制消息文本（保留原始符号）';
    copyBtn.addEventListener('click', () => {
        const raw = div.dataset.rawContent;
        copyText(raw !== undefined && raw !== '' ? raw : (div.textContent || ''));
    });
    actions.appendChild(copyBtn);

    // 编辑
    const editBtn = document.createElement('button');
    editBtn.className = 'ai-action-btn';
    editBtn.innerHTML = '<i class="fas fa-pen"></i> 编辑';
    editBtn.title = '编辑这条消息';
    editBtn.addEventListener('click', () => editAIMessage(div, contactId, isUserMsg ? 'user' : 'assistant'));
    actions.appendChild(editBtn);

    if (!isUserMsg) {
        // 继续
        const contBtn = document.createElement('button');
        contBtn.className = 'ai-action-btn';
        contBtn.innerHTML = '<i class="fas fa-arrow-right"></i> 继续';
        contBtn.title = '让 AI 接着上一段继续写';
        contBtn.addEventListener('click', () => {
            if (isGenerating) { showToast('正在生成中，请稍候', 'info'); return; }
            if (aiStreamReader) { showToast('正在生成中，请稍候', 'info'); return; } // 双保险：保留原检查
            sendAIMessage('继续你刚才的回答，从上一段话末尾接着往下写，不要重复已写过的内容。', { continueMode: true });
        });
        actions.appendChild(contBtn);

        // 重新生成
        const regenBtn = document.createElement('button');
        regenBtn.className = 'ai-action-btn';
        regenBtn.innerHTML = '<i class="fas fa-rotate"></i> 重新生成';
        regenBtn.title = '以最后一条消息重新生成，旧回复保留在历史中';
        regenBtn.addEventListener('click', () => {
            if (isGenerating) { showToast('正在生成中，请稍候', 'info'); return; }
            if (aiStreamReader) { showToast('正在生成中，请稍候', 'info'); return; } // 双保险：保留原检查
            sendAIMessage('', { regenerate: true });
        });
        actions.appendChild(regenBtn);
    }

    div.appendChild(actions);
}

// 复制文本（含剪贴板 API 回退）
function copyText(text) {
    if (!text) { showToast('没有可复制的内容', 'info'); return; }
    const done = () => showToast('success');
    const fail = () => showToast('error');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done, fail));
    } else {
        fallbackCopy(text, done, fail);
    }
}
function fallbackCopy(text, done, fail) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        ok ? done() : fail();
    } catch (e) { fail(); }
}

// 编辑最新一条消息（就地文本域编辑；role 决定改 user 还是 assistant 行）
// 导演词气泡同样支持编辑（结构不同：.msg-director / .msg-director-text）
async function editAIMessage(div, contactId, role = 'assistant') {
    if (!div || !contactId) return;
    const isDirector = div.classList.contains('director');
    const bubble = isDirector ? div.querySelector('.msg-director') : div.querySelector('.msg-bubble');
    const textDiv = isDirector ? div.querySelector('.msg-director-text') : div.querySelector('.message-text');
    if (!bubble || !textDiv) return;
    if (div.querySelector('.ai-edit-input')) return; // 已在编辑中

    const originalHtml = textDiv.innerHTML;
    // 用原始 markdown 源文本（含星号标记与空行），而不是渲染后的纯文本，
    // 保证编辑时识别标蓝的符号一直存在
    const originalText = (div.dataset.rawContent !== undefined && div.dataset.rawContent !== '')
        ? div.dataset.rawContent
        : (textDiv.textContent || '');

    // 进入编辑态：放大气泡，避免编辑框过小
    div.classList.add('editing');

    const textarea = document.createElement('textarea');
    textarea.className = 'ai-edit-input';
    textarea.value = originalText;

    const btnRow = document.createElement('div');
    btnRow.className = 'ai-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'ai-action-btn ai-action-primary';
    saveBtn.innerHTML = '<i class="fas fa-check"></i> 保存';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ai-action-btn';
    cancelBtn.innerHTML = '<i class="fas fa-xmark"></i> 取消';

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);

    // 关键：文本域与按钮都放在【气泡内部】，编辑完文本仍留在气泡内
    textDiv.replaceWith(textarea);
    bubble.appendChild(btnRow);
    textarea.focus();

    const cleanup = () => {
        div.classList.remove('editing');
        textarea.remove();
        btnRow.remove();
        textDiv.innerHTML = originalHtml;
        bubble.appendChild(textDiv);
    };

    const doSave = async () => {
        const newContent = textarea.value.trim();
        if (!newContent) { showToast('内容不能为空', 'error'); return; }
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
        try {
            // 按消息 id 精确定位（导演词等任意消息均可编辑；无 id 时回退到该角色最新一条）
            const msgId = div.dataset.id && /^\d+$/.test(div.dataset.id) ? div.dataset.id : '';
            const editUrl = `/api/ai/message?contact=${encodeURIComponent(contactId)}&role=${role}` + (msgId ? `&id=${msgId}` : '');
            const res = await fetchWithAuth(editUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: newContent })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || '保存失败');
            }
            // 更新 DOM（文本回到气泡内部）
            div.classList.remove('editing');
            textarea.remove();
            btnRow.remove();
            if (isDirector) {
                // 导演词：纯文本显示，不做 markdown 渲染
                textDiv.textContent = newContent;
            } else {
                textDiv.innerHTML = renderMarkdown(newContent);
            }
            div.dataset.rawContent = newContent;
            bubble.appendChild(textDiv);
            // 标记"已编辑"（第 25 项）+ 记录映射供引用预览使用
            div.dataset.edited = '1';
            if (div.dataset.id) messageTextById.set(Number(div.dataset.id), newContent);
            if (!bubble.querySelector('.msg-edited')) {
                const mark = document.createElement('span');
                mark.className = 'msg-edited';
                mark.textContent = '已编辑';
                mark.title = '查看编辑历史';
                mark.addEventListener('click', () => openEditHistory(div));
                bubble.appendChild(mark);
            }
            // 更新本地缓存中对应角色的最新消息
            const cacheKey = `pchat_history_${contactId}`;
            const raw = localStorage.getItem(cacheKey);
            if (raw) {
                try {
                    const data = JSON.parse(raw);
                    const msgs = Array.isArray(data.messages) ? data.messages : [];
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        if (msgs[i].role === role) {
                            msgs[i].content = newContent;
                            break;
                        }
                    }
                    localStorage.setItem(cacheKey, JSON.stringify(data));
                } catch (e) {}
            }
            showToast('已保存 ✅', 'success');
        } catch (err) {
            if (err.message !== '未授权') {
                showToast('保存失败: ' + err.message, 'error');
            }
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fas fa-check"></i> 保存';
        }
    };

    saveBtn.addEventListener('click', doSave);
    cancelBtn.addEventListener('click', cleanup);
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSave();
        if (e.key === 'Escape') cleanup();
    });
}

// ======================== 主题切换 ========================
function setTheme(theme) {
    const html = document.documentElement;
    // 开启一次性过渡类，让明暗切换丝滑（400ms 后移除，避免常驻影响性能）
    html.classList.add('theme-transition');
    if (theme === 'system') {
        html.removeAttribute('data-theme');
    } else {
        html.setAttribute('data-theme', theme);
    }
    localStorage.setItem('theme', theme);
    document.querySelectorAll('.theme-options .settings-option-btn').forEach(btn => {
        if (btn.dataset.theme === theme) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    // 图标随主题切换
    if (window.updateFavicon) window.updateFavicon();
    clearTimeout(themeTransitionTimer);
    themeTransitionTimer = setTimeout(() => html.classList.remove('theme-transition'), 450);
}

function loadSavedTheme() {
    // 默认明亮，优先本地存储
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
}

// ======================== 退出登录 ========================
async function logout() {
    showLoading(logoutBtn, '退出中');
    try {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
        stopAllReceivers();
        currentUser = null;
        token = null;
        currentContact = null;
        contacts = [];
        sessionStorage.clear();
        // 聊天界面淡出后再切回登录页
        chatContainer.classList.add('fade-out');
        setTimeout(() => {
            authContainer.style.display = '';
            chatContainer.style.display = 'none';
            chatContainer.classList.remove('fade-out');
            loadLoginPage();
        }, 220);
    } catch (err) {
        addSystemMessage('退出失败');
    } finally {
        hideLoading(logoutBtn);
    }
}

// ======================== 用户信息更新 ========================
function updateUserInfo() {
    if (!currentUser) return;
    if (usernameSpan) usernameSpan.textContent = currentUser.username;
    if (userStatusSpan) userStatusSpan.textContent = '在线';
    const avatarUrl = currentUser.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.username)}&background=random`;
    if (userAvatarImg) userAvatarImg.src = avatarUrl;
    if (profileUsernameInput) profileUsernameInput.value = currentUser.username;
    if (profileAvatarPathInput) profileAvatarPathInput.value = currentUser.avatar || '';
    if (document.getElementById('current-password')) document.getElementById('current-password').value = '';
    if (document.getElementById('new-password')) document.getElementById('new-password').value = '';
    // 系统管理入口仅管理员可见（普通用户误点会被 adminFetch 清 session）
    const adminLink = document.getElementById('adminLink');
    if (adminLink) adminLink.style.display = currentUser.role === 'admin' ? '' : 'none';
    // 个人资料模态框顶部头像预览
    const preview = document.getElementById('profile-avatar-preview');
    if (preview) {
        const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.username)}&background=555&color=fff&size=128`;
        setModalAvatar(preview, currentUser.avatar || fallback, 'fa-user');
    }
}

// 保存个人资料（用户名 / 密码 / 头像路径）
async function saveProfile() {
    const saveBtn = document.getElementById('save-profile');
    showLoading(saveBtn, '保存中...');
    try {
        const currentPassword = document.getElementById('current-password').value;
        if (!currentPassword) {
            await showAlert('请输入当前密码用于验证');
            return;
        }
        const username = document.getElementById('profile-username').value.trim();
        const newPassword = document.getElementById('new-password').value;
        const avatarPath = document.getElementById('profile-avatar-path').value.trim();

        const payload = { current_password: currentPassword };
        if (username && username !== currentUser.username) payload.username = username;
        if (newPassword) payload.password = newPassword;
        if (avatarPath !== (currentUser.avatar || '')) payload.avatar = avatarPath;

        if (Object.keys(payload).length === 1) {
            await showAlert('没有需要修改的内容');
            return;
        }

        const res = await fetchWithAuth('/api/auth/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '保存失败');

        currentUser = { ...currentUser, ...data.user };
        sessionStorage.setItem('user', JSON.stringify(currentUser));
        updateUserInfo();
        // 若有重名渲染，刷新联系人列表显示
        if (contactsList) renderContacts();
        await showAlert('已保存 ✅');
    } catch (err) {
        if (err.message !== '未授权') {
            await showAlert('保存失败: ' + err.message);
        }
    } finally {
        hideLoading(saveBtn);
    }
}

// ======================== 登录界面渲染 ========================
function loadLoginPage() {
    const authContent = document.getElementById('auth-content');
    authContent.innerHTML = `
        <div class="auth-page">
            <div class="auth-header">
                <h1>Personal Chat</h1>
                <p id="auth-subtitle">登录你的账户</p>
            </div>
            <div class="auth-tabs" role="tablist">
                <button type="button" class="auth-tab active" data-auth-tab="login" role="tab">登录</button>
                <button type="button" class="auth-tab" data-auth-tab="register" role="tab">注册</button>
            </div>
            <div class="auth-content">
                <div id="login-panel" class="auth-panel active">
                    <div class="form-group">
                        <label>用户名</label>
                        <input type="text" id="login-username" placeholder="用户名" value="" autocomplete="username">
                    </div>
                    <div class="form-group">
                        <label>密码</label>
                        <input type="password" id="login-password" placeholder="密码" autocomplete="current-password">
                    </div>
                    <div id="turnstile-login" class="turnstile-slot"></div>
                    <button id="login-btn" class="btn-primary">登录</button>
                </div>
                <div id="register-panel" class="auth-panel">
                    <div class="form-group">
                        <label>用户名</label>
                        <input type="text" id="register-username" placeholder="3~32 个字符" autocomplete="username">
                    </div>
                    <div class="form-group">
                        <label>密码</label>
                        <input type="password" id="register-password" placeholder="至少 8 位" autocomplete="new-password">
                    </div>
                    <div class="form-group">
                        <label>确认密码</label>
                        <input type="password" id="register-password-confirm" placeholder="再次输入密码" autocomplete="new-password">
                    </div>
                    <div class="form-group">
                        <label>邀请码（服务器开启邀请制时必填）</label>
                        <input type="text" id="register-invite" placeholder="填写邀请码" autocomplete="off">
                    </div>
                    <div id="turnstile-register" class="turnstile-slot"></div>
                    <button id="register-btn" class="btn-primary">注册</button>
                </div>
                <!-- 版本号 + 更新日志（版本号取 window.APP_VERSION，与 package.json / CHANGELOG.md 一致） -->
                <div class="auth-version">
                    <span id="authVersionLabel">v${window.APP_VERSION}</span>
                </div>
            </div>
        </div>
    `;

    // 第 9 项：配置了站点密钥时渲染 Turnstile 组件
    if (typeof renderTurnstile === 'function') renderTurnstile('turnstile-login');
    
    const loginBtn = document.getElementById('login-btn');
    const pwdInput = document.getElementById('login-password');
    const sessionVersion = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
    
    loginBtn.addEventListener('click', async () => {
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value.trim();
        if (!username || !password) await showAlert('请输入用户名和密码');
        
        showLoading(loginBtn, '登录中...');
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    password,
                    // 第 9 项：Turnstile 令牌（未配置站点密钥时为空字符串，后端自动跳过）
                    turnstile_token: (typeof getTurnstileToken === 'function') ? getTurnstileToken('turnstile-login') : '',
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '登录失败');
            currentUser = data.user;
            token = data.token;
            sessionStorage.setItem('user', JSON.stringify(currentUser));
            sessionStorage.setItem('token', token);
            sessionStorage.setItem('sessionVersion', sessionVersion);

            // 清理所有旧的历史缓存（可选，但推荐）
            const keys = Object.keys(localStorage);
            keys.forEach(key => {
            if (key.startsWith('pchat_history_')) {
                localStorage.removeItem(key);
            }
            });

            authContainer.classList.add('fade-out');
            chatContainer.style.display = 'flex';
            updateUserInfo();
            loadSavedTheme();
            // 加载联系人列表
            await loadContacts();
            setTimeout(() => {
                authContainer.style.display = 'none';
                authContainer.classList.remove('fade-out');
            }, 220);
        } catch (err) {
            // 登录失败：重置 Turnstile（令牌一次性）
            if (typeof resetTurnstile === 'function') resetTurnstile('turnstile-login');
            await showAlert(err.message);
        } finally {
            hideLoading(loginBtn);
        }
    });
    
    pwdInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loginBtn.click();
    });

    // ---- 登录 / 注册选项卡（Phase 4） ----
    const authSubtitle = document.getElementById('auth-subtitle');
    let registerTurnstileRendered = false;

    function switchAuthTab(tab) {
        document.querySelectorAll('.auth-tab').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.authTab === tab);
        });
        document.querySelectorAll('.auth-panel').forEach((panel) => {
            panel.classList.toggle('active', panel.id === `${tab}-panel`);
        });
        if (authSubtitle) authSubtitle.textContent = tab === 'register' ? '创建一个新账户' : '登录你的账户';
        // 注册面板显示后再渲染 Turnstile（隐藏容器里渲染会得到 0 尺寸）
        if (tab === 'register' && !registerTurnstileRendered) {
            registerTurnstileRendered = true;
            if (typeof renderTurnstile === 'function') renderTurnstile('turnstile-register');
        }
    }

    document.querySelectorAll('.auth-tab').forEach((btn) => {
        btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab));
    });

    const registerBtn = document.getElementById('register-btn');
    if (registerBtn) {
        const doRegister = async () => {
            const username = document.getElementById('register-username').value.trim();
            const password = document.getElementById('register-password').value;
            const confirm = document.getElementById('register-password-confirm').value;
            const inviteCode = document.getElementById('register-invite').value.trim();

            if (!username || !password) { await showAlert('请输入用户名和密码'); return; }
            if (password.length < 8) { await showAlert('密码长度至少 8 个字符'); return; }
            if (password !== confirm) { await showAlert('两次输入的密码不一致'); return; }

            showLoading(registerBtn, '注册中...');
            try {
                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username,
                        password,
                        invite_code: inviteCode,
                        // 与登录同一套 Turnstile（未配置站点密钥时为空字符串，后端自动跳过）
                        turnstile_token: (typeof getTurnstileToken === 'function') ? getTurnstileToken('turnstile-register') : '',
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || '注册失败');

                await showAlert('注册成功，请使用新账号登录');
                switchAuthTab('login');
                const loginUsername = document.getElementById('login-username');
                const loginPassword = document.getElementById('login-password');
                if (loginUsername) loginUsername.value = username;
                if (loginPassword) { loginPassword.value = ''; loginPassword.focus(); }
            } catch (err) {
                if (typeof resetTurnstile === 'function') resetTurnstile('turnstile-register');
                await showAlert(err.message);
            } finally {
                hideLoading(registerBtn);
            }
        };

        registerBtn.addEventListener('click', doRegister);
        ['register-password', 'register-password-confirm', 'register-invite'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('keypress', (e) => { if (e.key === 'Enter') doRegister(); });
        });
    }

    // 登录页「更新日志」入口
    const authChangelogBtn = document.getElementById('authChangelogBtn');
    if (authChangelogBtn) authChangelogBtn.addEventListener('click', () => window.openChangelog());
}

// ======================== 设置面板初始化 ========================
function initSettingsModal() {
    document.querySelectorAll('.theme-options .settings-option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const theme = btn.dataset.theme;
            setTheme(theme);
        });
    });
    document.querySelectorAll('.mode-options .settings-option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (currentContact?.contact_type === 'ai') {
                showAlert('AI 对话强制使用 SSE 模式');
                return;
            }
            switchReceiveMode(mode);
        });
    });
    // 注：settingsBtn 的打开逻辑统一在 initApp 中绑定（含模型接口表单加载）
    const closeSettings = () => hideModal(settingsModal);
    closeSettingsBtn.addEventListener('click', closeSettings);
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettings();
    });
}

// ===== 侧边栏收回/展开功能 =====
// ======================== 移动端侧边栏（抽屉） ========================
function isMobileView() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function openMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (!sidebar) return;
    sidebar.classList.remove('collapsed');
    sidebar.classList.add('active');
    if (overlay) overlay.classList.add('active');
}

function closeMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
}

function initMobileSidebar() {
    const menuBtn = document.getElementById('mobileMenuBtn');
    const overlay = document.getElementById('sidebarOverlay');
    if (menuBtn) {
        menuBtn.addEventListener('click', () => {
            const sidebar = document.getElementById('sidebar');
            if (sidebar && sidebar.classList.contains('active')) closeMobileSidebar();
            else openMobileSidebar();
        });
    }
    if (overlay) overlay.addEventListener('click', closeMobileSidebar);
}

// ======================== 移动端「更多」收纳面板（0.14.4） ========================
// 移动端把顶部低频按钮藏进「⋮」面板：面板项用 data-more-target 指向原按钮，
// 点击时先关闭面板，再触发原按钮的 click 处理器 —— 完全沿用原有逻辑，不复制业务代码。
// 面板项的可用性跟着原按钮走：原按钮被 JS 用 inline display:none 隐藏时（例如
// 未选联系人时的「收藏 / 导出」、非管理员看到的「系统管理」），对应项也不显示。
function initMorePanels() {
    const GROUPS = [
        { panel: document.getElementById('chatMorePanel'), btn: document.getElementById('chatMoreBtn') },
        { panel: document.getElementById('userMorePanel'), btn: document.getElementById('userMoreBtn') },
    ].filter((g) => g.panel && g.btn);
    if (!GROUPS.length) return;

    let openedPanel = null;

    function closeMorePanels() {
        GROUPS.forEach(({ panel, btn }) => {
            panel.classList.remove('active');
            panel.setAttribute('aria-hidden', 'true');
            btn.setAttribute('aria-expanded', 'false');
        });
        openedPanel = null;
    }

    // 原按钮是否「当前可用」：只看 JS 写在按钮上的 inline display（CSS 的移动端隐藏不算）
    function isTargetAvailable(target) {
        if (!target) return false;
        return target.style.display !== 'none' && !target.hidden;
    }

    function syncPanelItems(panel) {
        panel.querySelectorAll('[data-more-target]').forEach((item) => {
            item.style.display = isTargetAvailable(document.querySelector(item.dataset.moreTarget))
                ? ''
                : 'none';
        });
    }

    GROUPS.forEach(({ panel, btn }) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (openedPanel === panel) {
                closeMorePanels();
                return;
            }
            closeMorePanels();
            syncPanelItems(panel);
            panel.classList.add('active');
            panel.setAttribute('aria-hidden', 'false');
            btn.setAttribute('aria-expanded', 'true');
            openedPanel = panel;
        });

        // 点遮罩 / 关闭按钮收起
        panel.addEventListener('click', (e) => {
            if (e.target === panel || e.target.closest('[data-more-close]')) closeMorePanels();
        });
    });

    // 面板项：关闭面板后转发点击到原按钮
    document.querySelectorAll('.more-panel [data-more-target]').forEach((item) => {
        item.addEventListener('click', () => {
            const selector = item.dataset.moreTarget;
            closeMorePanels();
            const target = document.querySelector(selector);
            if (!target) return;
            target.click();
        });
    });

    // Esc 收起；视口离开移动端时自动收起，避免面板残留
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && openedPanel) closeMorePanels();
    });
    window.addEventListener('resize', () => {
        if (openedPanel && !isMobileView()) closeMorePanels();
    });
}

function initSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const collapseBtn = document.getElementById('collapseBtn');
    const expandBtn = document.getElementById('expandBtn');

    if (!sidebar || !collapseBtn) return;

    // 从 localStorage 恢复状态（仅桌面端）
    const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
    if (isCollapsed && !isMobileView()) {
        sidebar.classList.add('collapsed');
        if (expandBtn) expandBtn.style.display = 'flex';
    }

    // 收回按钮（移动端=关闭抽屉，桌面端=收起侧栏）
    collapseBtn.addEventListener('click', () => {
        if (isMobileView()) {
            closeMobileSidebar();
            return;
        }
        sidebar.classList.add('collapsed');
        if (expandBtn) expandBtn.style.display = 'flex';
        localStorage.setItem('sidebar_collapsed', 'true');
    });

    // 展开按钮
    if (expandBtn) {
        expandBtn.addEventListener('click', () => {
            sidebar.classList.remove('collapsed');
            expandBtn.style.display = 'none';
            localStorage.setItem('sidebar_collapsed', 'false');
        });
    }
}

// ======================== 强制同步云端数据 ========================
async function forceSync() {
  const token = getAuthToken();
  if (!token) {
    await showAlert('登录已过期，请重新登录');
    window.location.reload();
    return;
  }

  const now = Date.now();
  if (now - lastSyncTime < SYNC_COOLDOWN) {
    const remaining = Math.ceil((SYNC_COOLDOWN - (now - lastSyncTime)) / 1000);
    await showAlert(`⏳ 请等待 ${remaining} 秒后再同步`);
    return;
  }

  const syncBtn = document.getElementById('syncBtn');
  const originalHtml = syncBtn.innerHTML;
  syncBtn.disabled = true;
  syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  try {
    // 1. 同步联系人列表
    const contactsRes = await fetchWithAuth('/api/contacts?t=' + Date.now());
    const newContacts = await contactsRes.json();
    contacts = newContacts;
    setContactsCache(newContacts);
    renderContacts();
    if (currentContact) {
      const updated = contacts.find(c => c.contact_id === currentContact.contact_id);
      if (updated && chatHeader) {
        chatHeader.textContent = updated.display_name;
      }
    }

    // 2. 同步当前联系人的历史消息
    if (currentContact) {
      let url;
      if (currentContact.contact_type === 'ai') {
        url = `/api/ai/history?contact=${currentContact.contact_id}&t=${Date.now()}`;
      } else {
        url = `/api/messages?contact_type=${currentContact.contact_type}&contact_id=${currentContact.contact_id}&t=${Date.now()}`;
      }
      const historyRes = await fetchWithAuth(url);
      const data = await historyRes.json();
      const serverMessages = Array.isArray(data) ? data : (data.messages || []);
      const sessionVersion = sessionStorage.getItem('sessionVersion') || '';
      const cacheKey = `pchat_history_${currentContact.contact_id}`;
      const cacheData = {
        version: sessionVersion,
        messages: serverMessages.slice(-50)
      };
      localStorage.setItem(cacheKey, JSON.stringify(cacheData));

      // 重新渲染（手动强制同步：全量重绘一次，保持与服务器完全一致）
      resetMessageRenderState();
      if (chatBox) chatBox.innerHTML = '';
      if (serverMessages.length === 0) {
        const greeting = currentContact.contact_type === 'ai' ? '👋 开始与 AI 对话吧！' : '暂无消息，开始聊天吧';
        addSystemMessage(greeting);
      } else {
        const senderResolver = (msg) => msg.role === 'user' ? (currentUser?.username || currentContact.display_name) : currentContact.display_name;
        renderMessages(serverMessages, senderResolver);
      }
      if (data.totalPages !== undefined) historyTotalPages = data.totalPages;
      attachActionsToLatestAiMessage();
      // 全量重绘后直接贴底：否则同步完成时会停在顶部，看起来像「消息被上翻」
      pinChatToBottom();
      statusSpan.textContent = '✅ 已同步云端数据';
    }

    // 3. 如果是 AI 角色，同步角色设定（KV）
    if (currentContact && currentContact.contact_type === 'ai') {
      // 同步 Meta
      const metaRes = await fetchWithAuth(`/api/role/${currentContact.contact_id}/meta?t=${Date.now()}`);
      const meta = await metaRes.json();
      const cached = getContactsCache();
      if (cached) {
        const idx = cached.findIndex(c => c.contact_id === currentContact.contact_id);
        if (idx !== -1) {
          cached[idx] = { ...cached[idx], greeting: meta.greeting, format: meta.format };
          setContactsCache(cached);
          contacts = cached;
        }
      }

      // 同步 Prompt（仅触发，无需存储）
      await fetchWithAuth(`/api/role/${currentContact.contact_id}/prompt?t=${Date.now()}`);
    }

    lastSyncTime = Date.now();
    showToast('success');

  } catch (err) {
    if (err.message !== '未授权') {
      console.error('同步失败:', err);
      showToast('❌ 同步失败: ' + err.message, 'error');
    }
  } finally {
    syncBtn.disabled = false;
    syncBtn.innerHTML = originalHtml;
  }
}

// ======================== Toast 消息 ========================
function showToast(message, type = 'info') {
    // 移除已有 Toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // 触发显示动画
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 420);
    }, 3000);
}

// ======================== 输入草稿自动保存（第 27 项） ========================
// localStorage key: draft_{contact_id}；切换联系人/刷新时恢复，发送成功后清空
function draftKey(contactId) {
    return contactId ? `draft_${contactId}` : '';
}

function saveDraft() {
    if (!currentContact || !msgInput) return;
    const key = draftKey(currentContact.contact_id);
    if (!key) return;
    try {
        const v = msgInput.value;
        if (v && v.trim()) localStorage.setItem(key, v);
        else localStorage.removeItem(key);
    } catch (e) {}
}

function restoreDraft() {
    if (!currentContact || !msgInput) return;
    const key = draftKey(currentContact.contact_id);
    if (!key) return;
    let v = '';
    try { v = localStorage.getItem(key) || ''; } catch (e) { v = ''; }
    msgInput.value = v;
    // 触发自动增高
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.max(Math.min(msgInput.scrollHeight, 120), 38) + 'px';
}

function clearDraft() {
    if (!currentContact) return;
    const key = draftKey(currentContact.contact_id);
    if (!key) return;
    try { localStorage.removeItem(key); } catch (e) {}
}

// ======================== 认证工具 ========================
function getAuthToken() {
  return sessionStorage.getItem('token');
}

async function fetchWithAuth(url, options = {}) {
  const token = getAuthToken();
  if (!token) {
    await showAlert('登录已过期，请重新登录');
    window.location.reload();
    throw new Error('未登录');
  }

  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    }
  });

  if (res.status === 401) {
    sessionStorage.clear();
    await showAlert('登录已过期，请重新登录');
    window.location.reload();
    throw new Error('未授权');
  }
  return res;
}



// 注：以下功能模块（模型设置/AI设置/右键菜单/删除聊天记录/密码切换/重发/跳底/加载页）
// 已拆分到 static/js/features.js（先于本文件加载），函数名保持不变。

// 应用初始化扩展
function initApp() {
    const savedUser = sessionStorage.getItem('user');
    const savedToken = sessionStorage.getItem('token');
    if (savedUser && savedToken) {
        currentUser = JSON.parse(savedUser);
        token = savedToken;
        authContainer.style.display = 'none';
        chatContainer.style.display = 'flex';
        updateUserInfo();
        loadSavedTheme();
        loadContacts();
    } else {
        loadLoginPage();
        authContainer.style.display = '';        // 显示登录
        chatContainer.style.display = 'none';    // 隐藏聊天
    }
    
    sendButton.addEventListener('click', sendMessage);
    // 输入框：Enter 发送；Ctrl+Enter / Shift+Enter 换行（显式插入，兼容浏览器差异）；自动增高
    msgInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        // 中文输入法确认候选词时不触发发送/换行
        if (e.isComposing) return;
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            sendMessage();
            return;
        }
        // Ctrl/Shift+Enter → 显式插入换行（避免浏览器默认行为缺失导致"换行无效果"）
        e.preventDefault();
        const start = msgInput.selectionStart ?? msgInput.value.length;
        const end = msgInput.selectionEnd ?? msgInput.value.length;
        msgInput.value = msgInput.value.slice(0, start) + '\n' + msgInput.value.slice(end);
        msgInput.selectionStart = msgInput.selectionEnd = start + 1;
        msgInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const growInput = () => {
        msgInput.style.height = 'auto';
        const h = Math.min(msgInput.scrollHeight, 120);
        msgInput.style.height = Math.max(h, 38) + 'px';
    };
    msgInput.addEventListener('input', () => {
        growInput();
        saveDraft();   // 草稿自动保存（第 27 项）
    });
    // 导演词按钮：显示/隐藏导演词输入框
    if (directorToggleBtn && directorInput) {
        directorToggleBtn.addEventListener('click', () => {
            const box = document.getElementById('directorBox');
            if (!box) return;
            const showing = box.style.display !== 'none';
            box.style.display = showing ? 'none' : 'flex';
            directorToggleBtn.classList.toggle('active', !showing);
            if (!showing) directorInput.focus();
        });
    }
    logoutBtn.addEventListener('click', logout);
    // 安全绑定
    if (profileBtn) {
        profileBtn.addEventListener('click', () => {
            // 打开前刷新顶部头像预览（含 ui-avatars 兜底）
            const preview = document.getElementById('profile-avatar-preview');
            if (preview && currentUser) {
                const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.username)}&background=555&color=fff&size=128`;
                setModalAvatar(preview, currentUser.avatar || fallback, 'fa-user');
            }
            showModal(profileModal);
        });
    }
    if (closeProfileBtn) {
        closeProfileBtn.addEventListener('click', () => hideModal(profileModal));
    }
    if (profileModal) {
        profileModal.addEventListener('click', (e) => {
            if (e.target === profileModal) hideModal(profileModal);
        });
    }
    // 头像路径输入时实时预览
    const profileAvatarInput = document.getElementById('profile-avatar-path');
    if (profileAvatarInput) {
        profileAvatarInput.addEventListener('input', () => {
            const preview = document.getElementById('profile-avatar-preview');
            if (!preview || !currentUser) return;
            const v = profileAvatarInput.value.trim();
            if (v) {
                setModalAvatar(preview, v, 'fa-user');
            } else {
                const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.username)}&background=555&color=fff&size=128`;
                setModalAvatar(preview, fallback, 'fa-user');
            }
        });
    }
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            // 同步主题/模式按钮高亮
            const currentTheme = localStorage.getItem('theme') || 'light';
            document.querySelectorAll('.theme-options .settings-option-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.theme === currentTheme);
            });
            const effMode = currentContact?.contact_type === 'ai' ? 'sse' : receiveMode;
            document.querySelectorAll('.mode-options .settings-option-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === effMode);
            });
            if (currentModeDisplay) {
                currentModeDisplay.textContent = currentContact?.contact_type === 'ai' ? 'sse (AI)' : receiveMode;
            }
            // 加载模型接口表单并打开
            loadProviderSettingsForm();
            loadUserPrefsForm();
            loadAccountSettings();
            showModal(settingsModal);
        });
    }
    // 注：closeSettingsBtn / settingsModal 的关闭绑定已在 initSettingsModal 中完成，避免重复
    if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', saveProfile);
    }

    // 同步按钮
    const syncBtn = document.getElementById('syncBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', forceSync);
    }

    //初始化网页跳转按钮
    const adminBtn = document.getElementById('adminLink');
    const rolesBtn = document.getElementById('rolesLink');
    if (rolesBtn) {
        rolesBtn.addEventListener('click', () => {
            window.location.href = '/admin/roles.html';
        });
    }
    if (adminBtn) {
        adminBtn.addEventListener('click', () => {
            window.location.href = '/admin/admin.html';
        });
    }

    initSettingsModal();
    // 初始化侧边栏
    initSidebarToggle();
    initMobileSidebar();
    // 移动端「更多」收纳面板（顶部操作栏 + 右上角账号区）
    initMorePanels();

    // 滚动到顶部时加载更早的 AI 历史（按需分页，避免一次性渲染全部消息）
    if (chatBox) {
        chatBox.addEventListener('scroll', () => {
            const top = chatBox.scrollTop;
            const goingUp = top < lastChatScrollTop;
            lastChatScrollTop = top;
            // 只在「向上」滚到顶部时触发：加载贴底/回到最新这类程序化滚动不会误触
            if (!goingUp || top > 40 || loadingEarlier) return;
            // 120ms 防抖：切换联系人时清空聊天区也会把 scrollTop 打到 0，
            // 等布局稳定（首屏已贴底）再判断，避免历史页连环插入导致滚动条乱跳
            clearTimeout(earlierLoadTimer);
            earlierLoadTimer = setTimeout(() => {
                if (!loadingEarlier && chatBox.scrollTop <= 40) loadEarlierHistory();
            }, 120);
        }, { passive: true });
        // AI 头像点击 → AI 设置
        chatBox.addEventListener('click', (e) => {
            const avatarEl = e.target.closest('.ai-avatar-btn');
            if (avatarEl) openAiSettings();
        });
    }

    // 新功能初始化
    initAiSettingsModal();
    initProviderSettings();
    initUserPrefs();
    initAccountSection();
    initCommitments();
    initChatExtras();
    initContextMenu();
    initJumpBottom();
    initClearHistory();
    initPasswordToggles();
    initAboutSection();

    // 聊天标题栏按钮：AI 设置 / 删除聊天记录
    const chatAiBtn = document.getElementById('chatAiSettingsBtn');
    if (chatAiBtn) chatAiBtn.addEventListener('click', openAiSettings);
    const clearBtn = document.getElementById('clearHistoryBtn');
    if (clearBtn) clearBtn.addEventListener('click', openClearHistory);

    // 隐藏加载页
    hideSplash();

    // 第 9 项：配置了站点密钥时渲染聊天区的 Turnstile 组件
    //if (typeof renderTurnstile === 'function') renderTurnstile('turnstile-chat');

    // ===== 键盘快捷键（第 32 项）=====
    document.addEventListener('keydown', (e) => {
        // Ctrl+K / Cmd+K：打开搜索
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            if (typeof openSearch === 'function') openSearch();
            return;
        }
        // Esc：关闭最上层打开的模态 / 收起表情选择器 / 取消引用
        if (e.key === 'Escape') {
            if (typeof hideReactionPicker === 'function') hideReactionPicker();
            const opened = [...document.querySelectorAll('.modal.active')];
            if (opened.length > 0) {
                const top = opened[opened.length - 1];
                if (typeof hideModal === 'function') hideModal(top);
                return;
            }
            if (replyTarget && typeof clearReplyTarget === 'function') clearReplyTarget();
            return;
        }
        // ↑（输入框为空时）：编辑我发的上一条消息
        if (e.key === 'ArrowUp' && document.activeElement === msgInput && msgInput.value === '') {
            const mine = [...chatBox.querySelectorAll('.message.sent:not(.director)')]
                .filter(el => !el.classList.contains('ai-version-hidden'));
            const last = mine[mine.length - 1];
            if (last) {
                e.preventDefault();
                editAIMessage(last, currentContact ? currentContact.contact_id : '', 'user');
            }
        }
    });
    }

// 启动应用
initApp();