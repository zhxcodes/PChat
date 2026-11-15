// static/js/features.js
// ============================================================
// 功能模块合集（自 app.js 拆分，减少单文件体积）：
//  - 模型/接口全局设置、在线人数
//  - AI 设置模态框（点击 AI 头像 / 标题栏按钮）
//  - 自定义右键 / 长按菜单（气泡、联系人、列表空白）
//  - 删除聊天记录模态框（勾选即删该条及更晚）
//  - 密码明文切换、发送失败重发
//  - 回到最新消息按钮、加载页隐藏
// 依赖：app.js 的全局状态与函数（showToast / fetchWithAuth / sendAIMessage 等）。
// 加载顺序：必须先于 app.js（app.js 的 initApp 会调用本文件的 init* 函数）。
// 本文件内全部为函数/变量定义，加载时不执行任何逻辑。
// ============================================================

// ======================== 新功能：模型/在线状态/AI设置/右键菜单 ========================

// 发送给后端的 provider 配置（全局设置）
// 安全：不再下发 apiKey —— API Key 只存在于服务端环境变量（DEEPSEEK_API_KEY）
function getProviderPayload() {
    const p = {};
    if (aiProvider.apiBase) p.apiBase = aiProvider.apiBase;
    if (aiProvider.model) p.model = aiProvider.model;
    return p;
}

// 在线人数：与 AI 聊天时保持 1 人在线；API 不可达时显示 0 人
function updateOnlineCount(apiOk) {
    if (!onlineCountSpan) return;
    if (!currentContact || currentContact.contact_type !== 'ai') return;
    onlineCountSpan.textContent = apiOk ? '1人在线' : '0人在线';
}

// ======================== AI 设置模态（点击 AI 头像） ========================
function openAiSettings() {
    if (!currentContact || currentContact.contact_type !== 'ai') return;
    const modal = document.getElementById('ai-settings-modal');
    const title = document.getElementById('ai-settings-title');
    if (title) title.textContent = currentContact.display_name + ' · 设置';

    // 模型（全局）
    const modelInput = document.getElementById('ai-settings-model');
    if (modelInput) modelInput.value = aiProvider.model || '';
    document.querySelectorAll('.model-options .settings-option-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.model === (aiProvider.model || ''));
    });

    // AI 参数（当前联系人）
    const temp = currentContact.temperature ?? 0.7;
    const topP = currentContact.top_p ?? 0.9;
    const maxT = currentContact.max_tokens ?? 2048;
    const freqP = currentContact.frequency_penalty ?? 0;
    const presP = currentContact.presence_penalty ?? 0;
    const memWin = currentContact.memory_window ?? 30;
    const ctxWin = currentContact.context_window ?? 20;
    const setRange = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };
    setRange('ai-temp', temp);
    setRange('ai-topp', topP);
    setRange('ai-max-tokens', maxT);
    setRange('ai-freq-penalty', freqP);
    setRange('ai-pres-penalty', presP);
    setRange('ai-memory-window', memWin);
    setRange('ai-context-window', ctxWin);
    const td = document.getElementById('ai-temp-display'); if (td) td.textContent = Number(temp).toFixed(2);
    const pd = document.getElementById('ai-topp-display'); if (pd) pd.textContent = Number(topP).toFixed(2);
    const md = document.getElementById('ai-max-tokens-display'); if (md) md.textContent = maxT;
    const fd = document.getElementById('ai-freq-penalty-display'); if (fd) fd.textContent = Number(freqP).toFixed(1);
    const gd = document.getElementById('ai-pres-penalty-display'); if (gd) gd.textContent = Number(presP).toFixed(1);
    const wd = document.getElementById('ai-memory-window-display'); if (wd) wd.textContent = memWin;
    const xd = document.getElementById('ai-context-window-display'); if (xd) xd.textContent = ctxWin;
    const avatarInput = document.getElementById('ai-settings-avatar');
    if (avatarInput) avatarInput.value = currentContact.avatar || '';
    // 顶部头像预览（无配置时显示机器人图标）
    setModalAvatar(document.getElementById('ai-settings-avatar-preview'), currentContact.avatar || '', 'fa-robot');

    if (modal) showModal(modal);
}

function initAiSettingsModal() {
    const modal = document.getElementById('ai-settings-modal');
    const closeBtn = document.getElementById('close-ai-settings');
    const saveBtn = document.getElementById('save-ai-settings');
    const modelInput = document.getElementById('ai-settings-model');

    const bindRange = (rangeId, displayId, digits) => {
        const range = document.getElementById(rangeId);
        const display = document.getElementById(displayId);
        if (range && display) {
            range.addEventListener('input', () => {
                display.textContent = digits ? Number(range.value).toFixed(digits) : range.value;
            });
        }
    };
    bindRange('ai-temp', 'ai-temp-display', 2);
    bindRange('ai-topp', 'ai-topp-display', 2);
    bindRange('ai-max-tokens', 'ai-max-tokens-display', 0);
    bindRange('ai-freq-penalty', 'ai-freq-penalty-display', 1);
    bindRange('ai-pres-penalty', 'ai-pres-penalty-display', 1);
    bindRange('ai-memory-window', 'ai-memory-window-display', 0);
    bindRange('ai-context-window', 'ai-context-window-display', 0);

    // 参数详情按钮（右上角 ⓘ）
    if (window.bindParamInfoButtons) bindParamInfoButtons(modal);

    // 头像路径输入时实时预览
    const avatarInputEl = document.getElementById('ai-settings-avatar');
    if (avatarInputEl) {
        avatarInputEl.addEventListener('input', () => {
            setModalAvatar(document.getElementById('ai-settings-avatar-preview'), avatarInputEl.value.trim(), 'fa-robot');
        });
    }

    document.querySelectorAll('.model-options .settings-option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (modelInput) modelInput.value = btn.dataset.model;
            document.querySelectorAll('.model-options .settings-option-btn').forEach(b =>
                b.classList.toggle('active', b === btn));
        });
    });

    if (closeBtn) closeBtn.addEventListener('click', () => hideModal(modal));
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(modal); });

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            if (!currentContact) return;
            // 模型（全局）
            const m = modelInput ? modelInput.value.trim() : '';
            if (m) {
                aiProvider.model = m;
                saveAiProvider(aiProvider);
            }
            // AI 参数 + 头像（当前联系人，数据库）
            const temperature = parseFloat(document.getElementById('ai-temp').value);
            const top_p = parseFloat(document.getElementById('ai-topp').value);
            const max_tokens = parseInt(document.getElementById('ai-max-tokens').value, 10);
            const frequency_penalty = parseFloat(document.getElementById('ai-freq-penalty').value);
            const presence_penalty = parseFloat(document.getElementById('ai-pres-penalty').value);
            const memory_window = parseInt(document.getElementById('ai-memory-window').value, 10);
            const context_window = parseInt(document.getElementById('ai-context-window').value, 10);
            const avatar = (document.getElementById('ai-settings-avatar') || {}).value || '';
            try {
                const res = await fetchWithAuth(`/api/contacts/${currentContact.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ temperature, top_p, max_tokens, frequency_penalty, presence_penalty, memory_window, context_window, avatar: avatar.trim() })
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || '保存失败');
                }
                const updated = await res.json();
                // 更新内存与缓存
                const idx = contacts.findIndex(c => c.id === currentContact.id);
                if (idx !== -1) {
                    contacts[idx] = { ...contacts[idx], ...updated };
                    currentContact = contacts[idx];
                    setContactsCache(contacts);
                }
                showToast('已保存 ✅', 'success');
                hideModal(modal);
            } catch (err) {
                if (err.message !== '未授权') showToast('保存失败: ' + err.message, 'error');
            }
        });
    }
}

// ======================== 模型/接口 全局设置 ========================
function loadProviderSettingsForm() {
    const base = document.getElementById('provider-api-base');
    const model = document.getElementById('provider-model');
    if (base) base.value = aiProvider.apiBase || '';
    if (model) model.value = aiProvider.model || '';
}

function initProviderSettings() {
    const saveBtn = document.getElementById('save-provider');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            aiProvider.apiBase = document.getElementById('provider-api-base').value.trim();
            aiProvider.model = document.getElementById('provider-model').value.trim() || 'deepseek-flash';
            // 安全：apiKey 不再由前端保存/发送（仅服务端环境变量）
            delete aiProvider.apiKey;
            saveAiProvider(aiProvider);
            showToast('模型设置已保存 ✅', 'success');
        });
    }
}

// ======================== 用户偏好 / 安全词（第 12、15 项） ========================
// 服务端 KV 存储：preference_{userId} / safeword_{userId}
async function loadUserPrefsForm() {
    try {
        const [prefRes, safeRes] = await Promise.all([
            fetchWithAuth('/api/user/preference'),
            fetchWithAuth('/api/user/safeword'),
        ]);
        if (prefRes.ok) {
            const data = await prefRes.json();
            const el = document.getElementById('user-preference');
            if (el) el.value = data.preference || '';
        }
        if (safeRes.ok) {
            const data = await safeRes.json();
            const el = document.getElementById('user-safeword');
            if (el) el.value = data.safeword || '';
        }
    } catch (e) {
        console.debug('读取用户偏好失败:', e);
    }
}

function initUserPrefs() {
    const saveBtn = document.getElementById('save-user-prefs');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', async () => {
        const prefEl = document.getElementById('user-preference');
        const safeEl = document.getElementById('user-safeword');
        const preference = prefEl ? prefEl.value : '';
        const safeword = safeEl ? safeEl.value.trim() : '';
        if (preference.length > 1000) { showToast('用户偏好不能超过 1000 字', 'error'); return; }
        if (safeword.length > 200) { showToast('安全词不能超过 200 字', 'error'); return; }
        saveBtn.disabled = true;
        try {
            const [r1, r2] = await Promise.all([
                fetchWithAuth('/api/user/preference', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ preference }),
                }),
                fetchWithAuth('/api/user/safeword', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ safeword }),
                }),
            ]);
            if (!r1.ok || !r2.ok) throw new Error('保存失败');
            showToast('个性化设置已保存 ✅', 'success');
        } catch (err) {
            if (err.message !== '未授权') showToast('保存失败: ' + err.message, 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });
}

// ======================== 删除聊天记录（勾选即删该条及更晚） ========================
let clearHistoryMsgs = [];

// 拉取全部历史（翻页合并，按 id 升序）
async function loadAllHistoryForClear() {
    const contact = currentContact;
    if (!contact) return [];
    const all = [];
    let page = 1;
    const seen = new Set();
    for (let i = 0; i < 20; i++) { // 上限 600 条
        const res = await fetchWithAuth(`/api/ai/history?contact=${contact.contact_id}&page=${page}`);
        const data = await res.json();
        const msgs = data.messages || [];
        if (msgs.length === 0) break;
        for (const m of msgs) {
            const k = String(m.id !== undefined ? m.id : `${m.role}|${m.content}|${m.timestamp}`);
            if (!seen.has(k)) { seen.add(k); all.push(m); }
        }
        if (!data.hasMore) break;
        page++;
    }
    // 按 id 升序（id 存在时按时间亦可）
    all.sort((a, b) => {
        const ia = a.id !== undefined ? Number(a.id) : 0;
        const ib = b.id !== undefined ? Number(b.id) : 0;
        if (ia && ib) return ia - ib;
        return String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    });
    return all;
}

// 原地刷新勾选状态（只更新类名/复选/计数，不重建 DOM → 消除点击抖动）
function updateClearHistoryUI() {
    const list = document.getElementById('clear-history-list');
    const countEl = document.getElementById('clear-history-count');
    const allEl = document.getElementById('clear-history-all');

    if (list) {
        list.querySelectorAll('.clear-history-row').forEach((row, i) => {
            const msg = clearHistoryMsgs[i];
            if (!msg) return;
            row.classList.toggle('checked', !!msg.checked);
            const cb = row.querySelector('input[type=checkbox]');
            if (cb) cb.checked = !!msg.checked;
        });
    }
    const checkedCount = clearHistoryMsgs.filter(m => m.checked).length;
    if (countEl) countEl.textContent = `已选 ${checkedCount} 条`;
    if (allEl) allEl.checked = clearHistoryMsgs.length > 0 && checkedCount === clearHistoryMsgs.length;
}

function renderClearHistoryList() {
    const list = document.getElementById('clear-history-list');
    const countEl = document.getElementById('clear-history-count');
    if (!list) return;
    list.innerHTML = '';
    const checkedCount = clearHistoryMsgs.filter(m => m.checked).length;
    if (countEl) countEl.textContent = `已选 ${checkedCount} 条`;

    const allEl = document.getElementById('clear-history-all');
    if (allEl) allEl.checked = clearHistoryMsgs.length > 0 && checkedCount === clearHistoryMsgs.length;

    if (clearHistoryMsgs.length === 0) {
        list.innerHTML = '<div class="clear-history-empty">暂无聊天记录</div>';
        return;
    }

    clearHistoryMsgs.forEach(msg => {
        const row = document.createElement('div');
        row.className = 'clear-history-row' + (msg.checked ? ' checked' : '');
        const isUser = msg.role === 'user';
        const time = formatFullTime(msg.timestamp || msg.created_at);
        const text = (msg.content || '').replace(/\n+/g, ' ').slice(0, 60);
        row.innerHTML = `
            <input type="checkbox" ${msg.checked ? 'checked' : ''}>
            <span class="clear-history-role ${isUser ? 'u' : 'a'}">${isUser ? '我' : 'AI'}</span>
            <span class="clear-history-text">${escapeHtml(text) || '（空）'}</span>
            <span class="clear-history-time">${escapeHtml(time)}</span>
        `;
        row.addEventListener('click', (e) => {
            const cb = e.target.closest('input[type=checkbox]');
            if (cb && msg.checked) {
                // 手动取消单条
                msg.checked = false;
            } else {
                // 勾选该条及更晚的所有消息（强制）
                clearHistoryMsgs.forEach(m => {
                    const ma = m.id !== undefined ? Number(m.id) : Infinity;
                    const ia = msg.id !== undefined ? Number(msg.id) : Infinity;
                    if (ma >= ia) m.checked = true;
                });
            }
            // 原地更新，不重建列表（避免抖动）
            updateClearHistoryUI();
        });
        list.appendChild(row);
    });
}

function openClearHistory() {
    if (!currentContact || currentContact.contact_type !== 'ai') return;
    const modal = document.getElementById('clear-history-modal');
    if (!modal) return;
    const confirmBtn = document.getElementById('confirm-clear-history');
    if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="fas fa-trash-can"></i> 删除所选';
    }
    showModal(modal);
    loadAllHistoryForClear().then(msgs => {
        clearHistoryMsgs = msgs.map(m => ({ ...m, checked: false }));
        renderClearHistoryList();
    }).catch(() => {
        clearHistoryMsgs = [];
        renderClearHistoryList();
    });
}

function closeClearHistory() {
    hideModal(document.getElementById('clear-history-modal'));
    clearHistoryMsgs = [];
}

function initClearHistory() {
    const modal = document.getElementById('clear-history-modal');
    const closeBtn = document.getElementById('close-clear-history');
    const cancelBtn = document.getElementById('cancel-clear-history');
    const confirmBtn = document.getElementById('confirm-clear-history');
    const allEl = document.getElementById('clear-history-all');

    if (closeBtn) closeBtn.addEventListener('click', closeClearHistory);
    if (cancelBtn) cancelBtn.addEventListener('click', closeClearHistory);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeClearHistory(); });
    if (allEl) {
        allEl.addEventListener('change', () => {
            clearHistoryMsgs.forEach(m => { m.checked = allEl.checked; });
            updateClearHistoryUI();
        });
    }
    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            const ids = clearHistoryMsgs.filter(m => m.checked && m.id !== undefined).map(m => m.id);
            if (ids.length === 0) { showToast('请先勾选要删除的消息', 'info'); return; }
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 删除中...';
            try {
                const res = await fetchWithAuth(
                    `/api/ai/history?contact=${encodeURIComponent(currentContact.contact_id)}&ids=${ids.join(',')}`,
                    { method: 'DELETE' }
                );
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '删除失败');
                showToast(`已删除 ${data.deleted || ids.length} 条记录`, 'success');
                closeClearHistory();
                // 重新加载历史（本地缓存会被服务端数据覆盖）
                await loadMessagesForContact(currentContact);
            } catch (err) {
                if (err.message !== '未授权') showToast('删除失败: ' + err.message, 'error');
            } finally {
                // 成功会关闭弹窗，但按钮仍在 DOM 中；复位避免下次打开卡在「删除中...」
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = '<i class="fas fa-trash-can"></i> 删除所选';
            }
        });
    }
}

// ======================== 版本号 / 更新日志（关于项目） ========================
// 版本号唯一来源是 static/js/version.js（0.11.0 起独立成文件，管理页也要用）；
// 这里保留兜底，万一某个页面漏引 version.js 也不会显示 undefined。
window.APP_VERSION = window.APP_VERSION || '0.14.4';

// 回填页面上所有 [data-app-version] 占位（设置面板「关于项目」）
function fillVersionLabels() {
    document.querySelectorAll('[data-app-version]').forEach((el) => {
        el.textContent = 'v' + window.APP_VERSION;
    });
}

// 更新日志：createModal() 建框 → fetch CHANGELOG.md → marked 解析 → DOMPurify 清洗
async function openChangelog() {
    const { overlay, container } = createModal();
    container.style.maxWidth = '640px';
    container.style.width = '92%';
    container.innerHTML = `
        <div class="modal-header">
            <h2><i class="fas fa-book"></i> 更新日志</h2>
            <button type="button" class="close-btn" id="changelog-close">&times;</button>
        </div>
        <div class="modal-body">
            <div class="changelog-content">
                <div class="commitments-empty"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>
            </div>
        </div>
        <div class="changelog-footer">
            <a class="btn-secondary" href="/docs/" target="_blank" rel="noopener">
                <i class="fas fa-book-open"></i> 使用手册
            </a>
        </div>
    `;

    const content = container.querySelector('.changelog-content');
    const close = () => closeModalElement(overlay);
    container.querySelector('#changelog-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    try {
        // 根目录 CHANGELOG.md 不在 Pages 托管目录内，static/CHANGELOG.md 是它的副本
        const res = await fetch('/CHANGELOG.md', { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const md = await res.text();
        let html;
        if (window.marked && typeof window.marked.parse === 'function') {
            html = window.marked.parse(md);
        } else {
            html = '<pre>' + escapeHtml(md) + '</pre>';
        }
        if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
            html = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
        }
        content.innerHTML = html;
        collapseOldVersions(content);
    } catch (e) {
        content.innerHTML = '<div class="commitments-empty">暂无更新日志</div>';
    }
}

// 更新日志折叠：保留第一个版本（第一个 h2 及其后内容），其余收进 <details>
// 只搬运已 sanitize 过的节点，不拼接 HTML 字符串
function collapseOldVersions(root) {
    const versions = root.querySelectorAll('h2');
    if (versions.length < 2) return;

    const details = document.createElement('details');
    details.className = 'changelog-archive';
    const summary = document.createElement('summary');
    summary.textContent = '查看历史版本';
    details.appendChild(summary);

    // 从第二个版本标题开始，后面所有节点整体移入折叠面板
    const moved = [];
    let node = versions[1];
    while (node) {
        moved.push(node);
        node = node.nextSibling;
    }
    for (const n of moved) details.appendChild(n);
    root.appendChild(details);
}

window.openChangelog = openChangelog;

// 初始化「关于项目」：版本号回填 + 打开更新日志按钮
function initAboutSection() {
    fillVersionLabels();
    const btn = document.getElementById('openChangelogBtn');
    if (btn) btn.addEventListener('click', openChangelog);
}

// ======================== 自定义右键 / 长按菜单 ========================
let ctxMenuEl = null;
let longPressTimer = null;

function hideContextMenu() {
    if (ctxMenuEl) {
        const el = ctxMenuEl;
        ctxMenuEl = null;
        el.classList.add('closing');
        setTimeout(() => {
            // 若期间已被重新打开（closing 被移除），则不再隐藏新菜单
            if (!el.classList.contains('closing')) return;
            el.style.display = 'none';
            el.classList.remove('closing');
            el.innerHTML = '';
        }, 130);
    }
}

function showContextMenu(x, y, items) {
    hideContextMenu();
    const menu = document.getElementById('context-menu');
    if (!menu || !items || items.length === 0) return;

    menu.classList.remove('closing');
    menu.innerHTML = '';
    items.forEach(it => {
        const btn = document.createElement('button');
        btn.className = 'ctx-item' + (it.danger ? ' danger' : '');
        btn.innerHTML = `<i class="fas ${it.icon}"></i> ${it.label}`;
        // 把点击事件与菜单坐标传给菜单项：个别项（如「表情回应」）需要阻止冒泡、
        // 需要把弹层定位到鼠标/手指位置，否则会冒到 document 被「点空白处收起」立刻关掉
        btn.addEventListener('click', (e) => { hideContextMenu(); it.fn(e, x, y); });
        menu.appendChild(btn);
    });

    menu.style.display = 'block';
    ctxMenuEl = menu;
    // 边界处理
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

// 解析消息在服务端的 id（AI 实时消息只有客户端临时 id 时，按内容从历史中匹配）
async function resolveMessageId(div, contact) {
    const raw = div.dataset.id;
    if (raw && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
    try {
        // 导演词/我发的 → role='user'；AI 回复 → role='assistant'
        const isDirector = div.classList.contains('director');
        const textDiv = isDirector ? div.querySelector('.msg-director-text') : div.querySelector('.message-text');
        const content = textDiv ? (textDiv.textContent || '') : '';
        const role = (isDirector || div.classList.contains('sent')) ? 'user' : 'assistant';
        if (contact.contact_type !== 'ai') return null;
        // Bug 3：临时 id 的 AI 回复优先用 pendingAiReplies 的「内容 + 时间窗口」精确回查，
        // 避免多条相同内容的回复按 content 匹配命中错误的那一条
        const tempId = div.dataset.tempId;
        const pending = tempId ? pendingAiReplies.get(tempId) : null;
        const res = await fetchWithAuth(`/api/ai/history?contact=${encodeURIComponent(contact.contact_id)}`);
        const data = await res.json();
        const msgs = data.messages || [];
        if (pending) {
            const hit = matchServerMessage([...msgs].reverse(), pending.content, pending.timestamp, null);
            if (hit) return Number(hit.id);
        }
        // 回退：原来的内容匹配（无法区分同内容消息，仅作兜底）
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === role && msgs[i].content === content && msgs[i].id !== undefined) {
                return Number(msgs[i].id);
            }
        }
    } catch (e) {}
    return null;
}

// 删除一条消息（AI → chat_history；普通 → messages 表）
async function deleteMessageFromMenu(div) {
    if (!currentContact) return;
    const ok = await showConfirm('确定删除这条消息？删除后不可恢复。', '删除消息', '删除', '取消');
    if (!ok) return;
    const id = await resolveMessageId(div, currentContact);
    if (!id) { showToast('无法定位该消息，请刷新后重试', 'error'); return; }
    try {
        let res;
        if (currentContact.contact_type === 'ai') {
            res = await fetchWithAuth(
                `/api/ai/history?contact=${encodeURIComponent(currentContact.contact_id)}&ids=${id}`,
                { method: 'DELETE' }
            );
        } else {
            res = await fetchWithAuth(`/api/messages/${id}`, { method: 'DELETE' });
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '删除失败');
        showToast('消息已删除', 'success');
        await loadMessagesForContact(currentContact);
    } catch (err) {
        if (err.message !== '未授权') showToast('删除失败: ' + err.message, 'error');
    }
}

// 归档联系人（第 29 项：删除语义已改为归档，可在管理后台归档区恢复）
async function deleteContactFromMenu(contactId) {
    const contact = contacts.find(c => c.id === contactId);
    const name = contact ? contact.display_name : '该联系人';
    const ok = await showConfirm(
        `确定把「${name}」移入归档区？聊天记录与角色设定会完整保留，可在管理后台「归档区」恢复或彻底删除。`,
        '归档联系人', '归档'
    );
    if (!ok) return;
    try {
        const res = await fetchWithAuth(`/api/contacts/${contactId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '归档失败');
        showToast('已移入归档区 ✅', 'success');
        if (currentContact && currentContact.id === contactId) {
            currentContact = null;
            resetMessageRenderState();
            if (chatBox) chatBox.innerHTML = '';
            if (chatHeader) chatHeader.textContent = '请选择联系人';
            if (chatSubheader) chatSubheader.textContent = '选择一个联系人开始对话';
            const chatAiBtn = document.getElementById('chatAiSettingsBtn');
            const clearBtn = document.getElementById('clearHistoryBtn');
            if (chatAiBtn) chatAiBtn.style.display = 'none';
            if (clearBtn) clearBtn.style.display = 'none';
        }
        contacts = contacts.filter(c => c.id !== contactId);
        setContactsCache(contacts);
        renderContacts();
    } catch (err) {
        if (err.message !== '未授权') showToast('删除失败: ' + err.message, 'error');
    }
}

// 组装消息气泡右键菜单
function buildMessageContextItems(msgEl) {
    const contactId = currentContact ? currentContact.contact_id : '';

    // 导演词：仅当前会话展示的特别气泡（不落库）→ 只提供复制
    if (msgEl.classList.contains('director')) {
        const raw = msgEl.dataset.rawContent !== undefined && msgEl.dataset.rawContent !== ''
            ? msgEl.dataset.rawContent
            : (msgEl.textContent || '');
        return [
            { icon: 'fa-copy', label: '复制导演词', fn: () => copyText(raw) },
        ];
    }

    const isUserMsg = msgEl.classList.contains('sent');
    const textDiv = msgEl.querySelector('.message-text');
    // 复制保留原始 markdown 源文本（星号、/cmd 等标识符不丢失）
    const raw = msgEl.dataset.rawContent !== undefined && msgEl.dataset.rawContent !== ''
        ? msgEl.dataset.rawContent
        : (textDiv ? (textDiv.textContent || '') : '');
    const items = [
        { icon: 'fa-copy', label: '复制（原始）', fn: () => copyText(raw) },
        { icon: 'fa-reply', label: '回复', fn: () => setReplyTarget(msgEl) },
        { icon: 'fa-star', label: (favoriteIds.has(Number(msgEl.dataset.id)) ? '取消收藏' : '收藏'), fn: () => toggleFavorite(msgEl) },
        { icon: 'fa-face-smile', label: '表情回应', fn: (e, x, y) => {
            // 阻止冒泡：打开选择器的这次点击若继续冒到 document，
            // 会被「点空白处收起表情选择器」的监听在同一次点击里立刻关掉（PC 端表现为点了没反应）
            if (e) e.stopPropagation();
            // 定位到鼠标/手指位置（右键菜单弹出的坐标）；拿不到坐标时退回消息左上角
            if (Number.isFinite(x) && Number.isFinite(y)) {
                showReactionPicker(msgEl, x, y);
            } else {
                const rect = msgEl.getBoundingClientRect();
                showReactionPicker(msgEl, rect.left + 8, rect.top);
            }
        } },
    ];
    if (!isUserMsg) {
        items.push(
            { icon: 'fa-arrow-right', label: '继续生成', fn: () => { if (isGenerating) { showToast('正在生成中，请稍候', 'info'); return; } if (aiStreamReader) { showToast('正在生成中，请稍候', 'info'); return; } sendAIMessage('继续你刚才的回答，从上一段话末尾接着往下写，不要重复已写过的内容。', { continueMode: true }); } },
            { icon: 'fa-pen', label: '编辑', fn: () => editAIMessage(msgEl, contactId, isUserMsg ? 'user' : 'assistant') },
            { icon: 'fa-rotate', label: '重新生成', fn: () => { if (isGenerating) { showToast('正在生成中，请稍候', 'info'); return; } if (aiStreamReader) { showToast('正在生成中，请稍候', 'info'); return; } sendAIMessage('', { regenerate: true }); } },
            { icon: 'fa-wand-magic-sparkles', label: '用自定义指令重新生成', fn: () => regenerateWithInstruction() }
        );
    } else {
        items.push({ icon: 'fa-pen', label: '编辑', fn: () => editAIMessage(msgEl, contactId, 'user') });
    }
    items.push({ icon: 'fa-clock-rotate-left', label: '查看编辑历史', fn: () => openEditHistory(msgEl) });
    items.push({ icon: 'fa-trash-can', label: '删除消息', danger: true, fn: () => deleteMessageFromMenu(msgEl) });
    return items;
}

function initContextMenu() {
    // 桌面：右键
    if (chatBox) {
        chatBox.addEventListener('contextmenu', (e) => {
            const msgEl = e.target.closest('.message:not(.system)');
            if (!msgEl) return;
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, buildMessageContextItems(msgEl));
        });
    }
    // 联系人列表：右键联系人 / 空白处
    if (contactsList) {
        contactsList.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.contact-item');
            if (item) {
                e.preventDefault();
                const contactId = parseInt(item.dataset.id, 10);
                showContextMenu(e.clientX, e.clientY, [
                    { icon: 'fa-trash-can', label: '归档联系人', danger: true, fn: () => deleteContactFromMenu(contactId) },
                ]);
                return;
            }
            if (e.target === contactsList || contactsList.contains(e.target)) {
                e.preventDefault();
                const items = [];
                if (currentContact) {
                    items.push({ icon: 'fa-trash-can', label: '归档当前联系人', danger: true, fn: () => deleteContactFromMenu(currentContact.id) });
                }
                items.push({ icon: 'fa-plus', label: '新建联系人', fn: () => { window.location.href = '/admin/roles.html'; } });
                showContextMenu(e.clientX, e.clientY, items);
            }
        });
    }

    // 移动端长按（气泡 + 联系人）
    const longPressTarget = (e) => {
        const msgEl = e.target.closest('.message:not(.system)');
        if (msgEl) return { x: e.touches[0].clientX, y: e.touches[0].clientY, items: buildMessageContextItems(msgEl) };
        const item = e.target.closest('.contact-item');
        if (item) {
            const contactId = parseInt(item.dataset.id, 10);
            return { x: e.touches[0].clientX, y: e.touches[0].clientY, items: [{ icon: 'fa-trash-can', label: '归档联系人', danger: true, fn: () => deleteContactFromMenu(contactId) }] };
        }
        if (contactsList && contactsList.contains(e.target)) {
            const items = [];
            if (currentContact) items.push({ icon: 'fa-trash-can', label: '归档当前联系人', danger: true, fn: () => deleteContactFromMenu(currentContact.id) });
            items.push({ icon: 'fa-plus', label: '新建联系人', fn: () => { window.location.href = '/admin/roles.html'; } });
            return { x: e.touches[0].clientX, y: e.touches[0].clientY, items };
        }
        return null;
    };
    const longPressStart = (e) => {
        const target = longPressTarget(e);
        if (!target) return;
        if (e.target.closest('.editing')) return;
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => showContextMenu(target.x, target.y, target.items), 500);
    };
    document.addEventListener('touchstart', longPressStart, { passive: true });
    document.addEventListener('touchend', () => clearTimeout(longPressTimer));
    document.addEventListener('touchmove', () => clearTimeout(longPressTimer));

    document.addEventListener('click', (e) => {
        if (ctxMenuEl && !ctxMenuEl.contains(e.target)) hideContextMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
    window.addEventListener('resize', hideContextMenu);
}

// ======================== AI 答应你的事（承诺/待办，第 18 项） ========================
function openCommitments() {
    const modal = document.getElementById('commitments-modal');
    if (!modal) return;
    showModal(modal);
    if (currentContact && currentContact.contact_type === 'ai') loadCommitments(currentContact.contact_id);
}

async function loadCommitments(contactId) {
    const list = document.getElementById('commitments-list');
    if (!list) return;
    if (!contactId) { list.innerHTML = '<div class="commitments-empty">请先选择联系人</div>'; return; }
    list.innerHTML = '<div class="commitments-empty"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
    try {
        const res = await fetchWithAuth(`/api/commitments?contact=${encodeURIComponent(contactId)}`);
        if (!res.ok) throw new Error('加载失败');
        const data = await res.json();
        renderCommitments(data.commitments || []);
    } catch (err) {
        if (err.message !== '未授权') {
            list.innerHTML = `<div class="commitments-empty">❌ 加载失败: ${escapeHtml(err.message)}</div>`;
        }
    }
}

function renderCommitments(items) {
    const list = document.getElementById('commitments-list');
    if (!list) return;
    if (!items || items.length === 0) {
        list.innerHTML = '<div class="commitments-empty">暂无记录（AI 在对话中做出承诺后会自动出现在这里）</div>';
        return;
    }
    list.innerHTML = '';
    items.forEach(it => {
        const row = document.createElement('div');
        row.className = 'commitment-item' + (it.done ? ' done' : '');
        const time = it.created_at ? formatFullTime(it.created_at) : '';
        row.innerHTML = `
            <input type="checkbox" ${it.done ? 'checked' : ''} title="标记完成">
            <div class="commitment-body">
                <div class="commitment-content">${escapeHtml(it.content)}</div>
                <div class="commitment-time">${escapeHtml(it.due_at ? '截止 ' + it.due_at : (time ? '记录于 ' + time : ''))}</div>
            </div>
            <button class="commitment-del" title="删除"><i class="fas fa-xmark"></i></button>
        `;
        row.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
            updateCommitment(it.id, { done: e.target.checked });
        });
        row.querySelector('.commitment-del').addEventListener('click', () => deleteCommitment(it.id));
        list.appendChild(row);
    });
}

async function updateCommitment(id, patch) {
    try {
        const res = await fetchWithAuth(`/api/commitments?id=${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error('更新失败');
        if (currentContact) loadCommitments(currentContact.contact_id);
    } catch (err) {
        if (err.message !== '未授权') showToast('更新失败: ' + err.message, 'error');
    }
}

async function deleteCommitment(id) {
    const ok = await showConfirm('确定删除这条记录？', '删除承诺', '删除');
    if (!ok) return;
    try {
        const res = await fetchWithAuth(`/api/commitments?id=${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('删除失败');
        showToast('已删除', 'success');
        if (currentContact) loadCommitments(currentContact.contact_id);
    } catch (err) {
        if (err.message !== '未授权') showToast('删除失败: ' + err.message, 'error');
    }
}

async function addCommitment() {
    if (!currentContact || currentContact.contact_type !== 'ai') { showToast('请先选择 AI 联系人', 'info'); return; }
    const content = await showPrompt('请输入要让 AI 记住的承诺：', '', '手动添加承诺');
    if (!content || !content.trim()) return;
    try {
        const res = await fetchWithAuth('/api/commitments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact: currentContact.contact_id, content: content.trim() }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || '添加失败');
        }
        showToast('已添加 ✅', 'success');
        loadCommitments(currentContact.contact_id);
    } catch (err) {
        if (err.message !== '未授权') showToast('添加失败: ' + err.message, 'error');
    }
}

function initCommitments() {
    const btn = document.getElementById('commitmentsBtn');
    const modal = document.getElementById('commitments-modal');
    const closeBtn = document.getElementById('close-commitments');
    const refreshBtn = document.getElementById('commitments-refresh');
    const addBtn = document.getElementById('add-commitment');
    if (btn) btn.addEventListener('click', openCommitments);
    if (closeBtn) closeBtn.addEventListener('click', () => hideModal(modal));
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(modal); });
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
        if (currentContact) loadCommitments(currentContact.contact_id);
    });
    if (addBtn) addBtn.addEventListener('click', addCommitment);
}

// ======================== 搜索聊天记录（第 20 项） ========================
let searchPage = 1;
let searchKeyword = '';

function openSearch() {
    const modal = document.getElementById('search-modal');
    if (!modal) return;
    showModal(modal);
    const input = document.getElementById('search-input');
    if (input) { input.value = searchKeyword || ''; setTimeout(() => input.focus(), 180); }
}

async function doSearch(page = 1) {
    const input = document.getElementById('search-input');
    const box = document.getElementById('search-results');
    if (!input || !box) return;
    const q = input.value.trim();
    if (!q) { box.innerHTML = '<div class="commitments-empty">输入关键词开始搜索</div>'; return; }
    if (!currentContact) return;
    searchKeyword = q;
    searchPage = page;
    box.innerHTML = '<div class="commitments-empty"><i class="fas fa-spinner fa-spin"></i> 搜索中...</div>';
    try {
        const res = await fetchWithAuth(`/api/ai/search?contact=${encodeURIComponent(currentContact.contact_id)}&q=${encodeURIComponent(q)}&page=${page}`);
        if (!res.ok) throw new Error('搜索失败');
        const data = await res.json();
        renderSearchResults(data.results || [], q, data.hasMore);
    } catch (err) {
        if (err.message !== '未授权') box.innerHTML = `<div class="commitments-empty">❌ ${escapeHtml(err.message)}</div>`;
    }
}

function renderSearchResults(list, q, hasMore) {
    const box = document.getElementById('search-results');
    if (!box) return;
    if (list.length === 0) {
        box.innerHTML = '<div class="commitments-empty">没有匹配的消息</div>';
        return;
    }
    box.innerHTML = '';
    list.forEach(m => {
        const row = document.createElement('div');
        row.className = 'search-item';
        const roleLabel = m.role === 'user' ? '我' : 'AI';
        const time = formatFullTime(m.created_at || '');
        // 关键词高亮（先转义再插入 mark，避免 XSS）
        const safe = escapeHtml(String(m.content || '')).replace(/\n/g, ' ');
        const idx = safe.toLowerCase().indexOf(escapeHtml(q).toLowerCase());
        let preview = safe.slice(0, 160);
        if (idx >= 0) {
            const start = Math.max(0, idx - 40);
            preview = (start > 0 ? '…' : '') + safe.slice(start, start + 160);
        } else {
            preview += safe.length > 160 ? '…' : '';
        }
        row.innerHTML = `
            <div class="search-item-head"><span class="search-role">${roleLabel}</span><span class="search-time">${escapeHtml(time)}</span></div>
            <div class="search-item-text">${preview}</div>
        `;
        row.addEventListener('click', () => jumpToMessage(m.id));
        box.appendChild(row);
    });
    if (hasMore) {
        const more = document.createElement('button');
        more.className = 'btn-secondary';
        more.style.width = '100%';
        more.innerHTML = '<i class="fas fa-chevron-down"></i> 加载更多';
        more.addEventListener('click', () => doSearch(searchPage + 1));
        box.appendChild(more);
    }
}

// 跳转定位：若目标消息不在当前 DOM 中，先加载更多历史再定位
function jumpToMessage(msgId) {
    const modal = document.getElementById('search-modal');
    if (modal) hideModal(modal);
    const el = chatBox ? chatBox.querySelector(`.message[data-id="${msgId}"]`) : null;
    if (!el) {
        showToast('该消息较早，正在加载历史...', 'info');
        (async () => {
            for (let i = 0; i < 6; i++) {
                const before = chatBox.querySelectorAll('.message').length;
                await loadEarlierHistory();
                const found = chatBox.querySelector(`.message[data-id="${msgId}"]`);
                if (found) { highlightAndScroll(found); return; }
                if (chatBox.querySelectorAll('.message').length === before) break;
            }
            showToast('未能定位该消息，可能已被删除', 'error');
        })();
        return;
    }
    highlightAndScroll(el);
}

function highlightAndScroll(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(() => el.classList.remove('msg-highlight'), 2000);
}

// ======================== 收藏（第 23 项） ========================
let favoriteIds = new Set();

function openFavorites() {
    const modal = document.getElementById('favorites-modal');
    if (!modal) return;
    showModal(modal);
    if (currentContact) loadFavorites(currentContact.contact_id);
}

async function loadFavorites(contactId) {
    const box = document.getElementById('favorites-list');
    if (!box || !contactId) return;
    box.innerHTML = '<div class="commitments-empty"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
    try {
        const res = await fetchWithAuth(`/api/favorites?contact=${encodeURIComponent(contactId)}`);
        if (!res.ok) throw new Error('加载失败');
        const data = await res.json();
        const list = data.favorites || [];
        favoriteIds = new Set(list.map(f => f.message_id));
        refreshFavoriteMarks();
        if (list.length === 0) {
            box.innerHTML = '<div class="commitments-empty">暂无收藏（右键消息 → 收藏）</div>';
            return;
        }
        box.innerHTML = '';
        list.forEach(f => {
            const row = document.createElement('div');
            row.className = 'search-item';
            row.innerHTML = `
                <div class="search-item-head"><span class="search-role">★</span><span class="search-time">${escapeHtml(formatFullTime(f.created_at || ''))}</span></div>
                <div class="search-item-text">${escapeHtml(String(f.content || '（消息已删除）')).slice(0, 200)}</div>
            `;
            row.addEventListener('click', () => { hideModal(document.getElementById('favorites-modal')); jumpToMessage(f.message_id); });
            const del = document.createElement('button');
            del.className = 'memory-del';
            del.style.cssText = 'margin-left:8px;flex-shrink:0;';
            del.innerHTML = '<i class="fas fa-xmark"></i>';
            del.title = '取消收藏';
            del.addEventListener('click', async (e) => {
                e.stopPropagation();
                await fetchWithAuth(`/api/favorites?id=${f.id}`, { method: 'DELETE' });
                loadFavorites(contactId);
            });
            row.appendChild(del);
            box.appendChild(row);
        });
    } catch (err) {
        if (err.message !== '未授权') box.innerHTML = `<div class="commitments-empty">❌ ${escapeHtml(err.message)}</div>`;
    }
}

// 给已收藏的气泡加 ★ 标记
function refreshFavoriteMarks() {
    if (!chatBox) return;
    chatBox.querySelectorAll('.message[data-id]').forEach(el => {
        const id = Number(el.dataset.id);
        const has = favoriteIds.has(id);
        el.classList.toggle('favorited', has);
        el.dataset.favorited = has ? '1' : '0';
    });
}

// 切换收藏状态
async function toggleFavorite(msgEl) {
    if (!msgEl || !currentContact) return;
    const id = Number(msgEl.dataset.id);
    if (!Number.isInteger(id) || id <= 0) { showToast('该消息尚未保存，无法收藏', 'info'); return; }
    try {
        if (favoriteIds.has(id)) {
            await fetchWithAuth(`/api/favorites?message_id=${id}`, { method: 'DELETE' });
            favoriteIds.delete(id);
            showToast('已取消收藏', 'success');
        } else {
            const res = await fetchWithAuth('/api/favorites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contact: currentContact.contact_id, message_id: id }),
            });
            if (!res.ok) throw new Error('收藏失败');
            favoriteIds.add(id);
            showToast('已收藏 ★', 'success');
        }
        refreshFavoriteMarks();
    } catch (err) {
        if (err.message !== '未授权') showToast('操作失败: ' + err.message, 'error');
    }
}

// 切换联系人后重新拉取收藏集合（用于标记显示）
async function syncFavorites() {
    if (!currentContact || currentContact.contact_type !== 'ai') { favoriteIds = new Set(); refreshFavoriteMarks(); return; }
    try {
        const res = await fetchWithAuth(`/api/favorites?contact=${encodeURIComponent(currentContact.contact_id)}`);
        if (!res.ok) return;
        const data = await res.json();
        favoriteIds = new Set((data.favorites || []).map(f => f.message_id));
        refreshFavoriteMarks();
    } catch (e) {}
}

// ======================== 表情回应（第 24 项） ========================
const REACTION_EMOJIS = ['❤', '😂', '😢', '😮', '👍'];
let reactionsMap = new Map(); // message_id -> Set(emoji)

function showReactionPicker(msgEl, x, y) {
    const picker = document.getElementById('reaction-picker');
    if (!picker || !msgEl) return;
    picker.innerHTML = '';
    REACTION_EMOJIS.forEach(em => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'reaction-opt';
        b.textContent = em;
        b.addEventListener('click', () => {
            hideReactionPicker();
            toggleReaction(Number(msgEl.dataset.id), em, msgEl);
        });
        picker.appendChild(b);
    });
    // 先在 0,0 显示以量出实际尺寸，再把选择器「居中放在鼠标/手指上方」并夹在视口内
    // （之前用消息元素的 rect.left/top，位置总在消息左上角，离鼠标很远）
    picker.style.display = 'flex';
    picker.style.left = '0px';
    picker.style.top = '0px';
    const w = picker.offsetWidth || 200;
    const h = picker.offsetHeight || 40;
    const px = Number.isFinite(x) ? x : window.innerWidth / 2;
    const py = Number.isFinite(y) ? y : window.innerHeight / 2;
    const left = Math.max(8, Math.min(px - w / 2, window.innerWidth - w - 8));
    const top = Math.max(8, py - h - 10);
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
}

function hideReactionPicker() {
    const picker = document.getElementById('reaction-picker');
    if (picker) picker.style.display = 'none';
}

async function toggleReaction(messageId, emoji, msgEl) {
    if (!currentContact || !Number.isInteger(messageId) || messageId <= 0) { showToast('该消息尚未保存', 'info'); return; }
    try {
        const res = await fetchWithAuth('/api/reactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact: currentContact.contact_id, message_id: messageId, emoji }),
        });
        if (!res.ok) throw new Error('操作失败');
        await loadReactions();
        if (msgEl) renderReactionsOn(msgEl);
    } catch (err) {
        if (err.message !== '未授权') showToast('操作失败: ' + err.message, 'error');
    }
}

async function loadReactions() {
    if (!currentContact) return;
    reactionsMap = new Map();
    try {
        const res = await fetchWithAuth(`/api/reactions?contact=${encodeURIComponent(currentContact.contact_id)}`);
        if (!res.ok) return;
        const data = await res.json();
        (data.reactions || []).forEach(r => {
            if (!reactionsMap.has(r.message_id)) reactionsMap.set(r.message_id, new Set());
            reactionsMap.get(r.message_id).add(r.emoji);
        });
        if (chatBox) chatBox.querySelectorAll('.message[data-id]').forEach(el => renderReactionsOn(el));
    } catch (e) {}
}

// 在气泡下方渲染已选表情
function renderReactionsOn(msgEl) {
    if (!msgEl) return;
    const id = Number(msgEl.dataset.id);
    const set = reactionsMap.get(id);
    let bar = msgEl.querySelector('.reaction-bar');
    if (!set || set.size === 0) {
        if (bar) bar.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'reaction-bar';
        msgEl.appendChild(bar);
    }
    bar.innerHTML = '';
    [...set].forEach(em => {
        const chip = document.createElement('span');
        chip.className = 'reaction-chip';
        chip.textContent = em;
        chip.title = '点击取消';
        chip.addEventListener('click', () => toggleReaction(id, em, msgEl));
        bar.appendChild(chip);
    });
}

// ======================== 编辑历史（第 25 项） ========================
async function openEditHistory(msgEl) {
    if (!msgEl || !currentContact) return;
    const id = Number(msgEl.dataset.id);
    const modal = document.getElementById('edits-modal');
    const box = document.getElementById('edits-list');
    if (!modal || !box) return;
    showModal(modal);
    if (!Number.isInteger(id) || id <= 0) {
        box.innerHTML = '<div class="commitments-empty">该消息尚未保存，无编辑历史</div>';
        return;
    }
    box.innerHTML = '<div class="commitments-empty"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
    try {
        const res = await fetchWithAuth(`/api/ai/message?contact=${encodeURIComponent(currentContact.contact_id)}&id=${id}`);
        if (!res.ok) throw new Error('加载失败');
        const data = await res.json();
        const edits = data.edits || [];
        box.innerHTML = '';
        const cur = document.createElement('div');
        cur.className = 'edit-version current';
        cur.innerHTML = `<div class="edit-version-head">当前版本</div><div class="edit-version-text">${escapeHtml(data.current || '')}</div>`;
        box.appendChild(cur);
        if (edits.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'commitments-empty';
            empty.textContent = '没有更早的版本';
            box.appendChild(empty);
            return;
        }
        [...edits].reverse().forEach(e => {
            const row = document.createElement('div');
            row.className = 'edit-version';
            row.innerHTML = `<div class="edit-version-head">${escapeHtml(formatFullTime(e.edited_at || ''))} 之前的版本</div><div class="edit-version-text">${escapeHtml(e.old_content || '')}</div>`;
            box.appendChild(row);
        });
    } catch (err) {
        if (err.message !== '未授权') box.innerHTML = `<div class="commitments-empty">❌ ${escapeHtml(err.message)}</div>`;
    }
}

// ======================== 引用回复（第 21 项） ========================
function setReplyTarget(msgEl) {
    if (!msgEl) return;
    const id = Number(msgEl.dataset.id);
    const raw = msgEl.dataset.rawContent !== undefined && msgEl.dataset.rawContent !== ''
        ? msgEl.dataset.rawContent
        : (msgEl.textContent || '');
    replyTarget = { id: Number.isInteger(id) && id > 0 ? id : null, content: raw };
    const box = document.getElementById('quoteBox');
    const text = document.getElementById('quoteText');
    if (text) text.textContent = raw.replace(/\s+/g, ' ').slice(0, 50) + (raw.length > 50 ? '…' : '');
    if (box) box.style.display = 'flex';
    if (msgInput) msgInput.focus();
}

function clearReplyTarget() {
    replyTarget = null;
    const box = document.getElementById('quoteBox');
    if (box) box.style.display = 'none';
}

// ======================== 自定义指令重新生成（第 22 项） ========================
async function regenerateWithInstruction() {
    if (isGenerating) { showToast('正在生成中，请稍候', 'info'); return; }
    if (aiStreamReader) { showToast('正在生成中，请稍候', 'info'); return; } // 双保险：保留原检查
    const instruction = await showPrompt('附加一句临时指令（仅本次生成生效，可留空直接重新生成）：', '', '重新生成');
    if (instruction === null) return; // 取消
    sendAIMessage('', { regenerate: true, instruction: instruction.trim() });
}

// ======================== 聊天扩展功能初始化 ========================
function initChatExtras() {
    // 搜索
    const searchBtn = document.getElementById('searchBtn');
    const searchModal = document.getElementById('search-modal');
    const closeSearch = document.getElementById('close-search');
    const searchInput = document.getElementById('search-input');
    if (searchBtn) searchBtn.addEventListener('click', openSearch);
    if (closeSearch) closeSearch.addEventListener('click', () => hideModal(searchModal));
    if (searchModal) searchModal.addEventListener('click', (e) => { if (e.target === searchModal) hideModal(searchModal); });
    if (searchInput) {
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); doSearch(1); }
        });
    }

    // 收藏
    const favBtn = document.getElementById('favoritesBtn');
    const favModal = document.getElementById('favorites-modal');
    const closeFav = document.getElementById('close-favorites');
    if (favBtn) favBtn.addEventListener('click', openFavorites);
    if (closeFav) closeFav.addEventListener('click', () => hideModal(favModal));
    if (favModal) favModal.addEventListener('click', (e) => { if (e.target === favModal) hideModal(favModal); });

    // 编辑历史
    const editsModal = document.getElementById('edits-modal');
    const closeEdits = document.getElementById('close-edits');
    if (closeEdits) closeEdits.addEventListener('click', () => hideModal(editsModal));
    if (editsModal) editsModal.addEventListener('click', (e) => { if (e.target === editsModal) hideModal(editsModal); });

    // 引用条取消
    const quoteCancel = document.getElementById('quoteCancel');
    if (quoteCancel) quoteCancel.addEventListener('click', clearReplyTarget);

    // 导出对话（第 26 项）
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            if (!currentContact) { showToast('请先选择联系人', 'info'); return; }
            if (typeof window.openExportDialog === 'function') {
                window.openExportDialog(currentContact.contact_id, currentContact.display_name);
            }
        });
    }

    // 点空白处收起表情选择器
    document.addEventListener('click', (e) => {
        const picker = document.getElementById('reaction-picker');
        if (picker && picker.style.display !== 'none' && !picker.contains(e.target)) hideReactionPicker();
    });
}

// ======================== 回到最新消息按钮 ========================
function initJumpBottom() {
    if (!chatBox || !jumpBottomBtn) return;
    jumpBottomBtn.addEventListener('click', () => {
        chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: 'smooth' });
        // 点击弹跳反馈（动画结束后移除类，避免影响 show/hide 位移）
        jumpBottomBtn.classList.remove('bounced');
        void jumpBottomBtn.offsetWidth;
        jumpBottomBtn.classList.add('bounced');
        setTimeout(() => jumpBottomBtn.classList.remove('bounced'), 380);
    });
    chatBox.addEventListener('scroll', () => {
        const nearBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 120;
        jumpBottomBtn.classList.toggle('show', !nearBottom);
    }, { passive: true });
}

// ======================== 加载页 ========================
function hideSplash() {
    const splash = document.getElementById('splash-screen');
    if (!splash) return;
    splash.classList.add('hide');
    setTimeout(() => { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 500);
}

// ======================== 密码明文切换 / 发送失败重发 ========================

// 密码框右侧的眼睛按钮：明文/密文切换
function initPasswordToggles() {
    document.querySelectorAll('.toggle-password').forEach(btn => {
        btn.addEventListener('click', () => {
            const container = btn.closest('.password-container');
            const input = container ? container.querySelector('input') : null;
            if (!input) return;
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            btn.innerHTML = show
                ? '<i class="fas fa-eye-slash"></i>'
                : '<i class="fas fa-eye"></i>';
        });
    });
}

// 给消息挂"发送失败 · 重新发送"
function markSendFailed(div, retryFn) {
    if (!div) return;
    div.classList.add('send-failed');
    const row = document.createElement('div');
    row.className = 'send-failed-row';
    const btn = document.createElement('button');
    btn.className = 'ai-action-btn';
    btn.innerHTML = '<i class="fas fa-rotate-right"></i> 重新发送';
    btn.addEventListener('click', async () => {
        div.remove();
        try { await retryFn(); } catch (e) {}
    });
    row.appendChild(btn);
    div.appendChild(row);
}

// 发送普通（非 AI）消息：乐观渲染 + 失败重发
async function sendHumanMessage(content, contactType, contactId) {
    const userMsg = {
        id: Date.now(),
        username: currentUser.username,
        content: content,
        created_at: new Date().toISOString(),
        contact_type: contactType,
        contact_id: contactId,
    };
    const div = renderMessage(userMsg, currentUser.username);
    try {
        const res = await fetchWithAuth('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, contact_type: contactType, contact_id: contactId })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || '发送失败');
        }
        msgInput.value = '';
        msgInput.focus();
        return true;
    } catch (err) {
        if (err.message !== '未授权') {
            markSendFailed(div, () => sendHumanMessage(content, contactType, contactId));
            addSystemMessage('发送失败: ' + err.message);
        }
        return false;
    }
}

// ======================== 我的 API Key / 我的登录日志（Phase 4） ========================
// 后端：GET|PUT|DELETE /api/user/api-key、GET /api/user/login-logs
// 依赖全局的 fetchWithAuth / showToast / showAlert / showConfirm / escapeHtml / showLoading。
let userApiKeyFeatureEnabled = true;

const LOGIN_LOG_REASONS = {
    bad_password: '密码错误',
    user_not_found: '账号不存在',
    env_admin_protected: '环境管理员占位账号',
    bad_admin_password: '管理员密码错误',
    account_disabled: '账号已停用',
    account_banned: '账号已封禁',
    user_rate_limited: '账号失败次数过多',
};

// 服务端时间（SQLite CURRENT_TIMESTAMP / ISO）→ 本地时间 YYYY-MM-DD HH:mm
function formatAccountTime(value) {
    if (!value) return '—';
    let s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function loginLogMeta(status, reason) {
    if (status === 'success') return { label: '登录成功', cls: 'login-log-ok', reason: reason === 'env_admin' ? '环境管理员' : '' };
    const reasonText = LOGIN_LOG_REASONS[reason] || reason || '';
    if (status === 'blocked') return { label: '已拦截', cls: 'login-log-block', reason: reasonText };
    return { label: '登录失败', cls: 'login-log-fail', reason: reasonText };
}

async function loadUserApiKeyForm() {
    const statusEl = document.getElementById('user-api-key-status');
    const input = document.getElementById('user-api-key');
    const saveBtn = document.getElementById('save-user-api-key');
    const delBtn = document.getElementById('delete-user-api-key');
    if (!statusEl) return;

    statusEl.style.color = '';
    statusEl.textContent = '正在检查配置状态…';
    try {
        const res = await fetchWithAuth('/api/user/api-key');
        const data = await res.json().catch(() => ({}));

        if (res.status === 403) {
            userApiKeyFeatureEnabled = false;
            statusEl.style.color = '#f59e0b';
            statusEl.textContent = '管理员已关闭自定义 API Key，当前统一使用系统 Key';
            if (input) { input.value = ''; input.disabled = true; }
            if (saveBtn) saveBtn.disabled = true;
            if (delBtn) delBtn.disabled = true;
            return;
        }

        userApiKeyFeatureEnabled = true;
        if (input) input.disabled = false;
        if (saveBtn) saveBtn.disabled = false;
        if (delBtn) delBtn.disabled = false;

        if (!res.ok) throw new Error(data.error || '读取配置状态失败');
        if (data.configured) {
            statusEl.style.color = '#10b981';
            statusEl.textContent = '已配置 ✅ 聊天时优先使用你的 Key（服务端加密保存）';
        } else {
            statusEl.textContent = '未配置，当前使用系统默认 Key';
            if (delBtn) delBtn.disabled = true;
        }
    } catch (err) {
        if (err.message !== '未授权') {
            statusEl.style.color = '#ef4444';
            statusEl.textContent = '读取配置状态失败：' + err.message;
        }
    }
}

async function saveUserApiKey() {
    if (!userApiKeyFeatureEnabled) return;
    const input = document.getElementById('user-api-key');
    const saveBtn = document.getElementById('save-user-api-key');
    const key = input ? input.value.trim() : '';
    if (!key) { await showAlert('请输入 API Key'); return; }
    if (key.length < 8) { await showAlert('API Key 长度至少 8 个字符'); return; }

    showLoading(saveBtn, '保存中...');
    try {
        const res = await fetchWithAuth('/api/user/api-key', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: key }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '保存失败');
        if (input) input.value = '';
        showToast('API Key 已加密保存 ✅', 'success');
        await loadUserApiKeyForm();
    } catch (err) {
        if (err.message !== '未授权') await showAlert(err.message);
    } finally {
        hideLoading(saveBtn);
    }
}

async function deleteUserApiKey() {
    if (!userApiKeyFeatureEnabled) return;
    const ok = await showConfirm('删除已保存的 API Key？删除后将回退使用系统 Key。', '删除 API Key', '删除', '取消');
    if (!ok) return;
    try {
        const res = await fetchWithAuth('/api/user/api-key', { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '删除失败');
        showToast('API Key 已删除', 'success');
        await loadUserApiKeyForm();
    } catch (err) {
        if (err.message !== '未授权') await showAlert(err.message);
    }
}

async function loadMyLoginLogs() {
    const box = document.getElementById('login-logs-list');
    if (!box) return;

    // 已展开 → 再点一次收起
    if (box.style.display !== 'none' && box.innerHTML.trim()) {
        box.style.display = 'none';
        return;
    }

    box.style.display = 'block';
    box.innerHTML = '<div class="login-log-empty">加载中…</div>';
    try {
        const res = await fetchWithAuth('/api/user/login-logs?limit=20');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '读取登录日志失败');
        const logs = Array.isArray(data.logs) ? data.logs : [];
        if (logs.length === 0) {
            box.innerHTML = '<div class="login-log-empty">暂无登录记录</div>';
            return;
        }
        box.innerHTML = logs.map((log) => {
            const meta = loginLogMeta(log.status, log.reason);
            return `<div class="login-log-item">
                <div class="login-log-main">
                    <span class="${meta.cls}">${escapeHtml(meta.label)}</span>
                    ${meta.reason ? `<span class="login-log-sub">· ${escapeHtml(meta.reason)}</span>` : ''}
                    <div class="login-log-sub">${escapeHtml(log.ip || '未知 IP')}</div>
                </div>
                <div class="login-log-time">${escapeHtml(formatAccountTime(log.created_at))}</div>
            </div>`;
        }).join('');
    } catch (err) {
        box.innerHTML = `<div class="login-log-empty">读取失败：${escapeHtml(err.message)}</div>`;
    }
}

function initAccountSection() {
    const saveBtn = document.getElementById('save-user-api-key');
    const delBtn = document.getElementById('delete-user-api-key');
    const logsBtn = document.getElementById('load-login-logs');
    const input = document.getElementById('user-api-key');
    if (saveBtn) saveBtn.addEventListener('click', saveUserApiKey);
    if (delBtn) delBtn.addEventListener('click', deleteUserApiKey);
    if (logsBtn) logsBtn.addEventListener('click', loadMyLoginLogs);
    if (input) {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') saveUserApiKey();
        });
    }
}

// 打开设置面板时刷新状态（并收起上次展开的登录日志）
function loadAccountSettings() {
    loadUserApiKeyForm();
    const box = document.getElementById('login-logs-list');
    if (box) {
        box.style.display = 'none';
        box.innerHTML = '';
    }
}
