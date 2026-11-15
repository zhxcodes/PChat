// static/admin/roles.js
// ========================================
// 管理页面逻辑（完整版：含提示词 + 开场白 + 回复格式）
// ========================================

// ===== DOM 引用 =====
const contactsBody = document.getElementById('contactsBody');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const refreshBtn = document.getElementById('refreshBtn');
const backBtn = document.getElementById('backBtn');
const totalCount = document.getElementById('totalCount');
const aiCount = document.getElementById('aiCount');
const userCount = document.getElementById('userCount');
const adminUser = document.getElementById('adminUser');

// 编辑模态框
const editModal = document.getElementById('editModal');
const closeEditModal = document.getElementById('closeEditModal');
const cancelEdit = document.getElementById('cancelEdit');
const saveEdit = document.getElementById('saveEdit');

const editName = document.getElementById('editName');
const editType = document.getElementById('editType');
const editAvatar = document.getElementById('editAvatar');
const editContactId = document.getElementById('editContactId');
const editTemp = document.getElementById('editTemp');
const editTopP = document.getElementById('editTopP');
const editMaxTokens = document.getElementById('editMaxTokens');
const editFreqPenalty = document.getElementById('editFreqPenalty');
const editPresencePenalty = document.getElementById('editPresencePenalty');
const editMemoryWindow = document.getElementById('editMemoryWindow');
const editContextWindow = document.getElementById('editContextWindow');
const tempDisplay = document.getElementById('tempDisplay');
const topPDisplay = document.getElementById('topPDisplay');
const maxTokensDisplay = document.getElementById('maxTokensDisplay');
const freqPenaltyDisplay = document.getElementById('freqPenaltyDisplay');
const presencePenaltyDisplay = document.getElementById('presencePenaltyDisplay');
const memoryWindowDisplay = document.getElementById('memoryWindowDisplay');
const contextWindowDisplay = document.getElementById('contextWindowDisplay');
const memoryList = document.getElementById('memoryList');
const addMemoryBtn = document.getElementById('addMemoryBtn');
const extractMemoryBtn = document.getElementById('extractMemoryBtn');
const clearMemoryBtn = document.getElementById('clearMemoryBtn');
const memoryManage = document.getElementById('memoryManage');
const editGreeting = document.getElementById('editGreeting');
const editPrompt = document.getElementById('editPrompt');
const editFormat = document.getElementById('editFormat');
const editScene = document.getElementById('editScene');
const editAppearance = document.getElementById('editAppearance');
const editMood = document.getElementById('editMood');
const editIntimacy = document.getElementById('editIntimacy');
const paramStatus = document.getElementById('paramStatus');
const toast = document.getElementById('toast');

// 删除确认模态框
const deleteModal = document.getElementById('deleteModal');
const closeDeleteModal = document.getElementById('closeDeleteModal');
const cancelDelete = document.getElementById('cancelDelete');
const confirmDelete = document.getElementById('confirmDelete');
const deleteNameEl = document.getElementById('deleteName');
let pendingDeleteId = null;

// ===== 全局状态 =====
let contacts = [];
let editingId = null;          // 当前编辑的联系人 DB id；'new' 表示新建
let token = null;
let currentUser = null;
let isSaving = false;
let showArchived = false;      // 是否处于「归档区」视图（第 29 项）

// ===== 模态框开关助手（本页未加载 modal.js 时的兜底定义） =====
window.showModal = window.showModal || function (modal) {
    if (modal) modal.classList.add('active');
};
window.hideModal = window.hideModal || function (modal) {
    if (modal) modal.classList.remove('active');
};

// ===== 模态框顶部头像预览（兜底定义，与 modal.js 一致） =====
window.setModalAvatar = window.setModalAvatar || function (previewEl, src, fallbackIcon = 'fa-user') {
    if (!previewEl) return;
    const s = String(src || '').trim();
    const path = (!s || /^(https?:)?\/\//i.test(s) || s.startsWith('/') || s.startsWith('data:')) ? s : ('/' + s);
    if (!path) {
        previewEl.innerHTML = `<i class="fas ${fallbackIcon}"></i>`;
        return;
    }
    previewEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = path;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { previewEl.innerHTML = `<i class="fas ${fallbackIcon}"></i>`; };
    previewEl.appendChild(img);
};

// ===== 初始化 =====
async function init() {
    const savedUser = sessionStorage.getItem('user');
    const savedToken = sessionStorage.getItem('token');
    if (!savedUser || !savedToken) {
        window.location.href = '/index.html';
        return;
    }

    currentUser = JSON.parse(savedUser);
    token = savedToken;
    adminUser.textContent = `👤 ${currentUser.username}`;

    bindEvents();
    await loadContacts();
    updateStats();

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeModal(); closeDeleteModalFn(); }
    });

    // 隐藏加载页
    const splash = document.getElementById('splash-screen');
    if (splash) {
        splash.classList.add('hide');
        setTimeout(() => { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 500);
    }
}

// ===== 绑定事件 =====
function bindEvents() {

    const createContactBtn = document.getElementById('createContactBtn');
    if (createContactBtn) {
        createContactBtn.addEventListener('click', openCreateModal);
    }

    // 归档区切换（第 29 项）
    const archiveToggleBtn = document.getElementById('archiveToggleBtn');
    if (archiveToggleBtn) {
        archiveToggleBtn.addEventListener('click', async () => {
            showArchived = !showArchived;
            archiveToggleBtn.classList.toggle('active', showArchived);
            archiveToggleBtn.innerHTML = showArchived
                ? '<i class="fas fa-rotate-left"></i> 返回列表'
                : '<i class="fas fa-box-archive"></i> 归档区';
            if (createContactBtn) createContactBtn.style.display = showArchived ? 'none' : '';
            await loadContacts(true);
            showToast(showArchived ? '已进入归档区' : '已返回角色列表', 'info');
        });
    }

    backBtn.addEventListener('click', () => {
        window.location.href = '/index.html';
    });

    refreshBtn.addEventListener('click', async () => {
        const icon = refreshBtn.querySelector('i');
        if (icon) icon.classList.add('spinning');
        try {
            await loadContacts(true);
            showToast('已刷新', 'success');
        } finally {
            if (icon) icon.classList.remove('spinning');
        }
    });

    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        renderContacts();
    });

    searchInput.addEventListener('input', renderContacts);

    // 头像路径输入时实时预览
    editAvatar.addEventListener('input', () => {
        setModalAvatar(document.getElementById('edit-avatar-preview'), editAvatar.value.trim(), 'fa-robot');
    });

    closeEditModal.addEventListener('click', closeModal);
    cancelEdit.addEventListener('click', closeModal);
    editModal.addEventListener('click', (e) => {
        if (e.target === editModal) closeModal();
    });

    saveEdit.addEventListener('click', saveContact);

    // 滑块实时显示
    editTemp.addEventListener('input', () => {
        tempDisplay.textContent = parseFloat(editTemp.value).toFixed(2);
    });
    editTopP.addEventListener('input', () => {
        topPDisplay.textContent = parseFloat(editTopP.value).toFixed(2);
    });
    editMaxTokens.addEventListener('input', () => {
        maxTokensDisplay.textContent = editMaxTokens.value;
    });
    editFreqPenalty.addEventListener('input', () => {
        freqPenaltyDisplay.textContent = parseFloat(editFreqPenalty.value).toFixed(1);
    });
    editPresencePenalty.addEventListener('input', () => {
        presencePenaltyDisplay.textContent = parseFloat(editPresencePenalty.value).toFixed(1);
    });
    editMemoryWindow.addEventListener('input', () => {
        memoryWindowDisplay.textContent = editMemoryWindow.value;
    });
    editContextWindow.addEventListener('input', () => {
        contextWindowDisplay.textContent = editContextWindow.value;
    });

    // 参数详情按钮（右上角 ⓘ，由 param-info.js 提供）
    if (window.bindParamInfoButtons) bindParamInfoButtons(editModal);

    // 记忆管理
    if (addMemoryBtn) addMemoryBtn.addEventListener('click', addMemory);
    if (extractMemoryBtn) extractMemoryBtn.addEventListener('click', forceExtractMemories);
    if (clearMemoryBtn) clearMemoryBtn.addEventListener('click', clearAllMemories);

    // 删除确认模态框
    if (closeDeleteModal) closeDeleteModal.addEventListener('click', closeDeleteModalFn);
    if (cancelDelete) cancelDelete.addEventListener('click', closeDeleteModalFn);
    if (deleteModal) {
        deleteModal.addEventListener('click', (e) => {
            if (e.target === deleteModal) closeDeleteModalFn();
        });
    }
    if (confirmDelete) confirmDelete.addEventListener('click', doDelete);
}

// ===== 加载联系人（含 KV 数据） =====

// 读取单个 AI 角色的 KV 附加数据（开场白 / 回复格式 / 场景 / 外貌 / 角色提示词）
async function loadRoleExtra(contact) {
    if (!contact || contact.contact_type !== 'ai') return;
    try {
        const metaRes = await fetch(`/api/role/${contact.contact_id}/meta`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (metaRes.ok) {
            const meta = await metaRes.json();
            contact.greeting = meta.greeting || '';
            contact.format = meta.format || '';
            contact.scene = meta.scene || '';
            contact.appearance = meta.appearance || '';
        }
        const promptRes = await fetch(`/api/role/${contact.contact_id}/prompt`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (promptRes.ok) {
            const data = await promptRes.json();
            contact.prompt = data.prompt || '';
        }
    } catch (e) {
        console.debug('读取角色设定失败:', e);
    }
}

async function loadContacts(forceRefresh = false) {
    try {
        if (forceRefresh) {
            localStorage.removeItem('pchat_contacts');
            localStorage.removeItem('pchat_contacts_time');
        }

        // 归档区不读缓存，直接请求服务端
        const cached = showArchived ? null : getContactsCache();
        if (cached && !forceRefresh) {
            contacts = cached;
            renderContacts();
            updateStats();
            return;
        }

        const res = await fetch(`/api/contacts${showArchived ? '?archived=1' : ''}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('加载失败');

        contacts = await res.json();

        // 对每个 AI 角色，尝试从 KV 读取额外数据（开场白/格式/场景/外貌/提示词）
        if (!showArchived) {
            for (const contact of contacts) {
                await loadRoleExtra(contact);
            }
            setContactsCache(contacts);
        }

        renderContacts();
        updateStats();
    } catch (err) {
        console.error('加载联系人失败:', err);
        contactsBody.innerHTML = `<tr><td colspan="3" class="loading-text">❌ 加载失败: ${err.message}</td></tr>`;
        showToast('加载失败: ' + err.message, 'error');
    }
}

// ===== 渲染联系人列表 =====
function renderContacts() {
    if (!contacts || contacts.length === 0) {
        contactsBody.innerHTML = `<tr><td colspan="3" class="loading-text">${showArchived ? '归档区为空' : '暂无联系人'}</td></tr>`;
        return;
    }

    const searchTerm = searchInput.value.toLowerCase().trim();

    let html = '';
    let filtered = contacts;
    if (searchTerm) {
        filtered = contacts.filter(c => c.display_name.toLowerCase().includes(searchTerm));
    }

    if (filtered.length === 0) {
        contactsBody.innerHTML = `<tr><td colspan="3" class="loading-text">没有匹配的联系人</td></tr>`;
        return;
    }

    for (const contact of filtered) {
        const isAI = contact.contact_type === 'ai';
        const typeBadge = isAI
            ? '<span class="badge-ai">🤖 AI</span>'
            : '<span class="badge-user">👤 用户</span>';

        // 归档区：只提供「恢复 / 彻底删除 / 导出」（「已归档」标记并进名称列，保持 3 列对齐）
        if (showArchived) {
            html += `
                <tr class="archived-row">
                    <td>${typeBadge}</td>
                    <td>
                        <strong>${escapeHtml(contact.display_name)}</strong>
                        <span class="archived-tag"><i class="fas fa-box-archive"></i> 已归档</span>
                    </td>
                    <td class="row-actions">
                        <button class="action-btn" data-restore-id="${contact.id}">
                            <i class="fas fa-rotate-left"></i> 恢复
                        </button>
                        <button class="action-btn" data-export-id="${contact.id}" data-export-name="${escapeHtml(contact.display_name)}" data-export-cid="${escapeHtml(contact.contact_id)}">
                            <i class="fas fa-file-export"></i> 导出
                        </button>
                        <button class="action-btn action-danger" data-purge-id="${contact.id}" data-purge-name="${escapeHtml(contact.display_name)}">
                            <i class="fas fa-trash-alt"></i> 彻底删除
                        </button>
                    </td>
                </tr>
            `;
            continue;
        }

        // 0.14.4：列表不再展示「温度 / Top P / 最大令牌」（手机端太拥挤），
        // 这些参数仍在编辑弹窗里可查可改。
        html += `
            <tr>
                <td>${typeBadge}</td>
                <td><strong>${escapeHtml(contact.display_name)}</strong></td>
                <td class="row-actions">
                    <button class="action-btn" data-id="${contact.id}" data-contact-id="${contact.contact_id}">
                        <i class="fas fa-edit"></i> 编辑
                    </button>
                    <button class="action-btn" data-export-id="${contact.id}" data-export-name="${escapeHtml(contact.display_name)}" data-export-cid="${escapeHtml(contact.contact_id)}">
                        <i class="fas fa-file-export"></i> 导出
                    </button>
                    <button class="action-btn action-danger" data-del-id="${contact.id}" data-del-name="${escapeHtml(contact.display_name)}">
                        <i class="fas fa-box-archive"></i> 归档
                    </button>
                </td>
            </tr>
        `;
    }

    contactsBody.innerHTML = html;

    // 归档区按钮绑定
    document.querySelectorAll('.action-btn[data-restore-id]').forEach(btn => {
        btn.addEventListener('click', () => restoreContact(parseInt(btn.dataset.restoreId)));
    });
    document.querySelectorAll('.action-btn[data-purge-id]').forEach(btn => {
        btn.addEventListener('click', () => purgeContact(parseInt(btn.dataset.purgeId), btn.dataset.purgeName || '该联系人'));
    });
    document.querySelectorAll('.action-btn[data-export-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (typeof window.openExportDialog === 'function') {
                window.openExportDialog(btn.dataset.exportCid, btn.dataset.exportName);
            }
        });
    });

    document.querySelectorAll('.action-btn[data-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.id);
            openEditModal(id);
        });
    });
    document.querySelectorAll('.action-btn[data-del-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.delId);
            const name = btn.dataset.delName || '该联系人';
            openDeleteModal(id, name);
        });
    });
}

// ===== 更新统计（数字滚动 + 闪烁反馈） =====
function updateStats() {
    const total = contacts.length;
    const ai = contacts.filter(c => c.contact_type === 'ai').length;
    const users = contacts.filter(c => c.contact_type === 'user').length;

    const animateCount = (el, target) => {
        if (!el) return;
        const from = parseInt(el.textContent, 10) || 0;
        if (from === target) return;
        const start = performance.now();
        const dur = 400;
        const step = (now) => {
            const p = Math.min((now - start) / dur, 1);
            const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
            el.textContent = Math.round(from + (target - from) * eased);
            if (p < 1) requestAnimationFrame(step);
            else el.classList.add('flash');
        };
        requestAnimationFrame(step);
        setTimeout(() => el.classList.remove('flash'), 700);
    };

    animateCount(totalCount, total);
    animateCount(aiCount, ai);
    animateCount(userCount, users);
}

// ===== 打开编辑模态框 =====
async function openEditModal(id) {
    const contact = contacts.find(c => c.id === id);
    if (!contact) {
        showToast('联系人不存在', 'error');
        return;
    }

    // 修复：走缓存加载时缺少角色设定（开场白/格式/场景/外貌/提示词）→ 打开前重新拉取
    if (contact.contact_type === 'ai' &&
        (contact.prompt === undefined || contact.greeting === undefined || contact.format === undefined ||
         contact.scene === undefined || contact.appearance === undefined)) {
        showToast('正在加载角色设定...');
        await loadRoleExtra(contact);
        // 回写缓存，避免每次打开都重复拉取
        setContactsCache(contacts);
    }

    editingId = id;
    const isAI = contact.contact_type === 'ai';

    // 重置模态框标题与按钮（避免新建后残留"创建"状态）
    document.querySelector('#editModal .modal-header h2').innerHTML = '<i class="fas fa-edit"></i> 编辑角色';
    saveEdit.innerHTML = '<i class="fas fa-save"></i> 保存更改';

    editName.value = contact.display_name || '';
    editType.value = isAI ? '🤖 AI 角色' : '👤 普通用户';
    editAvatar.value = contact.avatar || '';
    editContactId.value = contact.contact_id || '';
    // 顶部头像预览（无配置时显示对应默认图标）
    setModalAvatar(document.getElementById('edit-avatar-preview'), contact.avatar || '', isAI ? 'fa-robot' : 'fa-user');

    // AI 参数
    const temp = contact.temperature ?? 0.7;
    const topP = contact.top_p ?? 0.9;
    const maxTokens = contact.max_tokens ?? 2048;
    const freqPenalty = contact.frequency_penalty ?? 0;
    const presPenalty = contact.presence_penalty ?? 0;
    const memWindow = contact.memory_window ?? 30;
    const ctxWindow = contact.context_window ?? 20;

    editTemp.value = temp;
    tempDisplay.textContent = temp.toFixed(2);
    editTopP.value = topP;
    topPDisplay.textContent = topP.toFixed(2);
    editMaxTokens.value = maxTokens;
    maxTokensDisplay.textContent = maxTokens;
    editFreqPenalty.value = freqPenalty;
    freqPenaltyDisplay.textContent = Number(freqPenalty).toFixed(1);
    editPresencePenalty.value = presPenalty;
    presencePenaltyDisplay.textContent = Number(presPenalty).toFixed(1);
    editMemoryWindow.value = memWindow;
    memoryWindowDisplay.textContent = memWindow;
    editContextWindow.value = ctxWindow;
    contextWindowDisplay.textContent = ctxWindow;

    // 记忆管理（仅 AI 角色显示并加载）
    if (memoryManage) memoryManage.style.display = isAI ? '' : 'none';
    if (isAI && contact.contact_id) loadMemories(contact.contact_id);
    else if (memoryList) memoryList.innerHTML = '<div class="memory-empty">暂无记忆</div>';

    // 角色设定
    editGreeting.value = contact.greeting || '';
    editPrompt.value = contact.prompt || '';
    editFormat.value = contact.format || '';
    editScene.value = contact.scene || '';
    editAppearance.value = contact.appearance || '';

    // 心情 / 亲密度（只读展示，第 13、14 项）
    if (editMood) editMood.value = isAI ? (contact.mood || '') : '';
    if (editIntimacy) {
        const n = Math.round(Number(contact.intimacy) || 0);
        editIntimacy.value = isAI ? `${n} / 100 · ${intimacyStageLabel(n)}` : '';
    }

    // 如果是普通用户，禁用 AI 参数和角色设定
    const isDisabled = !isAI;
    editTemp.disabled = isDisabled;
    editTopP.disabled = isDisabled;
    editMaxTokens.disabled = isDisabled;
    editFreqPenalty.disabled = isDisabled;
    editPresencePenalty.disabled = isDisabled;
    editMemoryWindow.disabled = isDisabled;
    editContextWindow.disabled = isDisabled;
    editGreeting.disabled = isDisabled;
    editPrompt.disabled = isDisabled;
    editFormat.disabled = isDisabled;
    editScene.disabled = isDisabled;
    editAppearance.disabled = isDisabled;

    // 视觉提示
    const paramSections = editModal.querySelectorAll('.range-wrapper, .section-header');
    paramSections.forEach(el => {
        el.style.opacity = isDisabled ? '0.5' : '1';
    });

    paramStatus.textContent = isAI ? '✅ 可编辑' : '⛔ 仅 AI 角色';

    showModal(editModal);
    editName.focus();
}

// ===== 关闭模态框 =====
function closeModal() {
    hideModal(editModal);
    setTimeout(() => {
        editingId = null;
    }, 280);
}

// ===== 保存联系人 =====
async function saveContact() {
    // 防止重复提交
    if (isSaving) return;
    if (editingId === null) {
        showToast('请先选择要编辑的联系人', 'error');
        return;
    }

    const name = editName.value.trim();
    if (!name) {
        showToast('请输入名称', 'error');
        return;
    }

    const isNew = editingId === 'new';
    const contactId = editContactId.value.trim() || name.toLowerCase().replace(/\s/g, '_');

    // 如果是新建，创建新联系人
    if (isNew) {
        try {
            const res = await fetch('/api/contacts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    contact_id: contactId,
                    display_name: name,
                    contact_type: 'ai',
                    avatar: editAvatar.value.trim(),
                    temperature: parseFloat(editTemp.value),
                    top_p: parseFloat(editTopP.value),
                    max_tokens: parseInt(editMaxTokens.value),
                    frequency_penalty: parseFloat(editFreqPenalty.value),
                    presence_penalty: parseFloat(editPresencePenalty.value),
                    memory_window: parseInt(editMemoryWindow.value),
                    context_window: parseInt(editContextWindow.value),
                    greeting: editGreeting.value.trim(),
                    prompt: editPrompt.value.trim(),
                    format: editFormat.value.trim(),
                    scene: editScene.value.trim(),
                    appearance: editAppearance.value.trim()
                })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || '创建失败');
            }
            await loadContacts(true);
            closeModal();
            showToast('创建成功 ✅', 'success');
            pulseCreateBtn();
        } catch (err) {
            showToast('创建失败: ' + err.message, 'error');
        }
        return;
    }

    // 更新已有联系人
    const contact = contacts.find(c => c.id === editingId);
    if (!contact) {
        showToast('联系人不存在', 'error');
        return;
    }

    const isAI = contact.contact_type === 'ai';

    // 构建更新数据
    const updates = {
        display_name: name,
        avatar: editAvatar.value.trim(),
    };

    if (isAI) {
        updates.temperature = parseFloat(editTemp.value);
        updates.top_p = parseFloat(editTopP.value);
        updates.max_tokens = parseInt(editMaxTokens.value);
        updates.frequency_penalty = parseFloat(editFreqPenalty.value);
        updates.presence_penalty = parseFloat(editPresencePenalty.value);
        updates.memory_window = parseInt(editMemoryWindow.value);
        updates.context_window = parseInt(editContextWindow.value);
        updates.greeting = editGreeting.value.trim();
        updates.prompt = editPrompt.value.trim();
        updates.format = editFormat.value.trim();
        updates.scene = editScene.value.trim();
        updates.appearance = editAppearance.value.trim();
    }

    isSaving = true;
    saveEdit.disabled = true;
    saveEdit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';

    try {
        // 1. 更新 contacts 表
        const res = await fetch(`/api/contacts/${editingId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(updates)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || '保存失败');
        }

        // 2. 如果是 AI，更新 KV
        if (isAI) {
            // 更新 meta (greeting, format)
            await fetch(`/api/role/${contact.contact_id}/meta`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    greeting: updates.greeting,
                    format: updates.format,
                    scene: updates.scene,
                    appearance: updates.appearance,
                    name: updates.display_name
                })
            });

            // 更新 prompt
            await fetch(`/api/role/${contact.contact_id}/prompt`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    prompt: updates.prompt
                })
            });
        }

        // 3. 刷新联系人列表
        await loadContacts(true);

        closeModal();
        showToast('保存成功 ✅', 'success');
        pulseCreateBtn();

    } catch (err) {
        console.error('保存失败:', err);
        showToast('保存失败: ' + err.message, 'error');
    } finally {
        isSaving = false;
        saveEdit.disabled = false;
        saveEdit.innerHTML = '<i class="fas fa-save"></i> 保存更改';
    }
}
// ===== Toast =====
let toastTimeout = null;

function showToast(message, type = 'info') {
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    toast.innerHTML = `${icon} ${escapeHtml(message)}`;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');

    clearTimeout(toastTimeout);
    void toast.offsetWidth;
    toast.classList.add('show');

    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 300);
    }, 3000);
}

// ===== 工具函数 =====
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"]/g, (m) => {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
        return map[m] || m;
    });
}

// 新建按钮脉动反馈（保存/创建成功后触发）
function pulseCreateBtn() {
    const btn = document.getElementById('createContactBtn');
    if (!btn) return;
    btn.classList.remove('pulse');
    void btn.offsetWidth;
    btn.classList.add('pulse');
    setTimeout(() => btn.classList.remove('pulse'), 900);
}

// 亲密度 → 关系阶段（与后端 _lib.intimacyStage 保持一致）
function intimacyStageLabel(n) {
    const v = Number(n) || 0;
    if (v <= 20) return '刚认识';
    if (v <= 50) return '熟悉';
    if (v <= 80) return '亲近';
    return '亲密';
}

// ===== 长期记忆管理（查看 / 修改 / 删除 / 添加 / 清空） =====
function memAuthHeaders() {
    return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function loadMemories(contactId) {
    if (!contactId || !memoryList) return;
    memoryList.innerHTML = '<div class="memory-empty"><i class="fas fa-spinner fa-spin"></i> 加载记忆中...</div>';
    try {
        const res = await fetch(`/api/memory?contact=${encodeURIComponent(contactId)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('加载失败');
        const data = await res.json();
        renderMemories(data.memories || []);
    } catch (err) {
        memoryList.innerHTML = `<div class="memory-empty">❌ 记忆加载失败: ${escapeHtml(err.message)}</div>`;
    }
}

function renderMemories(memories) {
    if (!memoryList) return;
    if (!memories || memories.length === 0) {
        memoryList.innerHTML = '<div class="memory-empty">暂无记忆（对话攒够记忆窗口条数后会自动提炼）</div>';
        return;
    }
    memoryList.innerHTML = '';
    memories.forEach(mem => {
        const item = document.createElement('div');
        item.className = 'memory-item';
        item.dataset.id = mem.id;
        const time = mem.created_at ? formatMemoryTime(mem.created_at) : '';
        // 情绪标签（第 17 项）
        const emotionHtml = mem.emotion
            ? `<span class="memory-emotion" title="情绪强度 ${mem.emotion_score != null ? mem.emotion_score : '-'}">${escapeHtml(mem.emotion)}</span>`
            : '';
        item.innerHTML = `
            <div class="memory-meta">
                <span>#${mem.id} ${emotionHtml} ${time ? '· ' + time : ''}</span>
                <span class="memory-actions">
                    <button type="button" class="memory-edit">编辑</button>
                    <button type="button" class="memory-del">删除</button>
                </span>
            </div>
            <div class="memory-content">${escapeHtml(mem.content)}</div>
        `;
        item.querySelector('.memory-edit').addEventListener('click', () => startEditMemory(item, mem));
        item.querySelector('.memory-del').addEventListener('click', () => deleteMemory(mem.id));
        memoryList.appendChild(item);
    });
}

function formatMemoryTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function startEditMemory(item, mem) {
    const contentEl = item.querySelector('.memory-content');
    if (!contentEl) return;
    contentEl.innerHTML = `
        <textarea class="memory-edit-input">${escapeHtml(mem.content)}</textarea>
        <div class="memory-actions" style="margin-top:8px;">
            <button type="button" class="memory-save">保存</button>
            <button type="button" class="memory-cancel">取消</button>
        </div>
    `;
    const ta = contentEl.querySelector('textarea');
    contentEl.querySelector('.memory-save').addEventListener('click', async () => {
        const content = ta.value.trim();
        if (!content) { showToast('记忆内容不能为空', 'error'); return; }
        try {
            const res = await fetch(`/api/memory/${mem.id}`, {
                method: 'PUT',
                headers: memAuthHeaders(),
                body: JSON.stringify({ content })
            });
            if (!res.ok) throw new Error('保存失败');
            showToast('记忆已更新 ✅', 'success');
            const cid = editContactId.value.trim();
            if (cid) loadMemories(cid);
        } catch (err) {
            showToast('保存失败: ' + err.message, 'error');
        }
    });
    contentEl.querySelector('.memory-cancel').addEventListener('click', () => {
        contentEl.innerHTML = escapeHtml(mem.content);
    });
    ta.focus();
}

async function deleteMemory(id) {
    const ok = await window.showConfirm
        ? await window.showConfirm('确定删除这条记忆？', '删除记忆', '删除')
        : confirm('确定删除这条记忆？');
    if (!ok) return;
    try {
        const res = await fetch(`/api/memory/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('删除失败');
        showToast('记忆已删除', 'success');
        const cid = editContactId.value.trim();
        if (cid) loadMemories(cid);
    } catch (err) {
        showToast('删除失败: ' + err.message, 'error');
    }
}

async function addMemory() {
    const cid = editContactId.value.trim();
    if (!cid) { showToast('请先保存角色', 'error'); return; }
    const content = window.showPrompt
        ? await window.showPrompt('请输入要添加的记忆内容：', '', '添加记忆')
        : prompt('请输入要添加的记忆内容：');
    if (!content || !content.trim()) return;
    try {
        const res = await fetch('/api/memory', {
            method: 'POST',
            headers: memAuthHeaders(),
            body: JSON.stringify({ contact: cid, content: content.trim() })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || '添加失败');
        }
        showToast('记忆已添加 ✅', 'success');
        loadMemories(cid);
    } catch (err) {
        showToast('添加失败: ' + err.message, 'error');
    }
}

async function clearAllMemories() {
    const cid = editContactId.value.trim();
    if (!cid) return;
    const ok = window.showConfirm
        ? await window.showConfirm('确定清空该角色的全部记忆？此操作不可恢复。', '清空记忆', '清空')
        : confirm('确定清空该角色的全部记忆？');
    if (!ok) return;
    try {
        const res = await fetch(`/api/memory?contact=${encodeURIComponent(cid)}&all=1`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('清空失败');
        showToast('记忆已全部清空', 'success');
        loadMemories(cid);
    } catch (err) {
        showToast('清空失败: ' + err.message, 'error');
    }
}

// 立即提炼（第 16 项）：强制把尚未提取的对话全部提炼成记忆（服务端 5 分钟限一次）
async function forceExtractMemories() {
    const cid = editContactId.value.trim();
    if (!cid) { showToast('请先保存角色', 'error'); return; }
    const btn = extractMemoryBtn;
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 提炼中...'; }
    try {
        const res = await fetch(`/api/memory/extract?contact=${encodeURIComponent(cid)}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '提炼失败');
        if (data.extracted > 0) showToast(`已提炼 ${data.extracted} 条记忆 ✅`, 'success');
        else showToast('没有可提炼的新对话（或已达单次上限）', 'info');
        loadMemories(cid);
    } catch (err) {
        showToast('提炼失败: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
}

function openCreateModal() {
    // 重置表单
    editName.value = '';
    editType.value = '🤖 AI 角色';
    // 自动生成随机数字角色 ID（16 位）
    const randomId = Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString();
    editContactId.value = randomId;
    editContactId.disabled = true; // 新建时 ID 自动生成，不可修改
    editAvatar.value = '';
    // 重置顶部头像预览为机器人默认图标
    setModalAvatar(document.getElementById('edit-avatar-preview'), '', 'fa-robot');
    editTemp.value = 0.7;
    tempDisplay.textContent = '0.70';
    editTopP.value = 0.9;
    topPDisplay.textContent = '0.90';
    editMaxTokens.value = 2048;
    maxTokensDisplay.textContent = '2048';
    editFreqPenalty.value = 0;
    freqPenaltyDisplay.textContent = '0.0';
    editPresencePenalty.value = 0;
    presencePenaltyDisplay.textContent = '0.0';
    editMemoryWindow.value = 30;
    memoryWindowDisplay.textContent = '30';
    editContextWindow.value = 20;
    contextWindowDisplay.textContent = '20';
    editGreeting.value = '';
    editPrompt.value = '';
    editFormat.value = '';
    editScene.value = '';
    editAppearance.value = '';
    if (editMood) editMood.value = '';
    if (editIntimacy) editIntimacy.value = '0 / 100 · 刚认识';
    // 记忆管理：新建时没有记忆
    if (memoryManage) memoryManage.style.display = '';
    if (memoryList) memoryList.innerHTML = '<div class="memory-empty">暂无记忆（对话攒够记忆窗口条数后会自动提炼）</div>';

    // 启用所有字段
    editName.disabled = false;
    editAvatar.disabled = false;
    editTemp.disabled = false;
    editTopP.disabled = false;
    editMaxTokens.disabled = false;
    editFreqPenalty.disabled = false;
    editPresencePenalty.disabled = false;
    editMemoryWindow.disabled = false;
    editContextWindow.disabled = false;
    editGreeting.disabled = false;
    editPrompt.disabled = false;
    editFormat.disabled = false;
    editScene.disabled = false;
    editAppearance.disabled = false;

    // 修改模态框标题和按钮
    document.querySelector('#editModal .modal-header h2').innerHTML = '<i class="fas fa-plus"></i> 新建联系人';
    saveEdit.innerHTML = '<i class="fas fa-plus"></i> 创建';

    // 保存模式标记
    editingId = 'new';

    // 显示模态框
    showModal(editModal);
    editName.focus();
}

// ===== 删除联系人 =====
function openDeleteModal(id, name) {
    pendingDeleteId = id;
    if (deleteNameEl) deleteNameEl.textContent = name;
    if (confirmDelete) {
        confirmDelete.disabled = false;
        confirmDelete.innerHTML = '<i class="fas fa-box-archive"></i> 确认归档';
    }
    showModal(deleteModal);
}

function closeDeleteModalFn() {
    hideModal(deleteModal);
    setTimeout(() => { pendingDeleteId = null; }, 280);
}

async function doDelete() {
    if (pendingDeleteId === null) return;
    if (!confirmDelete) return;
    confirmDelete.disabled = true;
    confirmDelete.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 归档中...';
    try {
        // 第 29 项：删除语义已改为「归档」——从列表隐藏但数据保留，可在归档区恢复
        const res = await fetch(`/api/contacts/${pendingDeleteId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || '归档失败');
        }
        closeDeleteModalFn();
        await loadContacts(true);
        showToast('已移入归档区（数据保留，可恢复）✅', 'success');
    } catch (err) {
        showToast('归档失败: ' + err.message, 'error');
    } finally {
        // 成功时弹窗会关闭，但按钮仍在 DOM 里；必须复位，否则下次打开会卡在「归档中...」
        confirmDelete.disabled = false;
        confirmDelete.innerHTML = '<i class="fas fa-box-archive"></i> 确认归档';
    }
}

// ===== 归档区操作（第 29 项） =====
async function restoreContact(id) {
    try {
        const res = await fetch(`/api/contacts/${id}/archive?restore=1`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || '恢复失败');
        }
        showToast('已恢复 ✅', 'success');
        await loadContacts(true);
    } catch (err) {
        showToast('恢复失败: ' + err.message, 'error');
    }
}

async function purgeContact(id, name) {
    const ok = window.showConfirm
        ? await window.showConfirm(`确定彻底删除「${name}」？其全部聊天记录、记忆、承诺与角色设定将被永久删除，不可恢复。`, '彻底删除', '永久删除')
        : confirm(`确定彻底删除「${name}」？此操作不可恢复。`);
    if (!ok) return;
    try {
        const res = await fetch(`/api/contacts/${id}/archive?purge=1`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || '删除失败');
        }
        showToast('已彻底删除', 'success');
        await loadContacts(true);
    } catch (err) {
        showToast('删除失败: ' + err.message, 'error');
    }
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', init);