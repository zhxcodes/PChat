// static/admin/admin.js
// ============================================================
// 系统管理页（多用户安全架构 Phase 4）
// ------------------------------------------------------------
// 功能：系统初始化（生成主密钥）、操作日志、登录日志（含保留天数）、
//       用户用量统计、用户管理（封禁 / 解封）。
// 权限：所有数据都走 /api/admin/*，后端强制管理员；
//       adminFetch 遇到 401/403 立即清空 session 并跳转登录页。
// ============================================================

'use strict';

const REASON_TEXT = {
    bad_password: '密码错误',
    user_not_found: '账号不存在',
    env_admin_protected: '环境管理员占位账号',
    bad_admin_password: '管理员密码错误',
    account_disabled: '账号已停用',
    account_banned: '账号已封禁',
    user_rate_limited: '账号失败次数过多',
};

const STATUS_TEXT = { active: '正常', disabled: '停用', banned: '封禁' };
const STATUS_CLASS = { active: 'ok', disabled: 'warn', banned: 'bad' };

const ACTION_TEXT = {
    'user.ban': '封禁用户',
    'user.unban': '解封用户',
    'user.status': '修改用户状态',
    'settings.update': '更新功能开关',
    'invites.create': '生成邀请码',
    'login_logs.retention': '设置登录日志保留天数',
};

// 功能开关（运行级配置）：key → 中文名 / 描述
// 顺序即管理页展示顺序；新增开关时同步 functions/api/admin/settings.js 的白名单。
const SETTING_LABELS = {
    allow_register: { name: '允许注册', desc: '开放新用户注册入口（关闭时注册接口返回 403）' },
    invite_required: { name: '注册需邀请码', desc: '注册时必须填写有效邀请码' },
    turnstile_enabled: { name: '登录 / 注册人机验证', desc: '需要同时配置 TURNSTILE_SITE_KEY 与 TURNSTILE_SECRET 才真正生效' },
    user_api_key_enabled: { name: '允许用户自备 Key', desc: '用户可在设置中加密保存自己的 API Key' },
    system_api_key_enabled: { name: '允许使用系统 Key', desc: '未配置自备 Key 时回退到系统 Key（含每分钟限流）' },
    memory_enabled: { name: '记忆功能总开关', desc: '长期记忆的查看、编辑与删除' },
    memory_extract_enabled: { name: '自动提取记忆', desc: '每攒够记忆窗口条数自动提炼长期记忆' },
    favorites_enabled: { name: '消息收藏', desc: '收藏消息并在收藏列表查看' },
    reactions_enabled: { name: '表情回应', desc: '给消息添加表情回应' },
    commitments_enabled: { name: '承诺追踪', desc: '记录 AI 在对话中答应过的事' },
    insights_enabled: { name: '会话洞察', desc: '会话统计、连续天数与情绪洞察' },
    stats_enabled: { name: '统计面板', desc: '管理端数据统计页' },
    replay_enabled: { name: '时光机', desc: '按天回放聊天记录' },
    search_enabled: { name: '聊天搜索', desc: '搜索历史消息' },
    export_enabled: { name: '导出对话', desc: '导出单个对话或完整备份' },
    import_enabled: { name: '导入对话', desc: '导入对话或整包备份' },
};

let usersState = { page: 1, pageSize: 20, q: '' };
let invitesState = { page: 1, pageSize: 20, total: 0 };
let usageDays = 30;
let loginDays = 7;
let keyTimer = null;
let keyDeadline = 0;
let redirecting = false;
let lastUsageData = null;
const chartInstances = [];
let usageChartInstance = null;

// ---------- 基础工具 ----------
function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
}

function formatTime(value) {
    if (!value) return '—';
    let s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatNumber(n) {
    return Number(n || 0).toLocaleString('zh-CN');
}

function hideSplash() {
    const splash = document.getElementById('splash-screen');
    if (!splash) return;
    splash.classList.add('hide');
    setTimeout(() => { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 500);
}

function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 420);
    }, 2600);
}

// ---------- 主题与 ECharts ----------
function isDarkTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function getEchartsTheme() {
    return isDarkTheme() ? 'dark' : 'default';
}

function updateThemeIcon() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'fas ' + (isDarkTheme() ? 'fa-sun' : 'fa-moon');
}

function ensureUsageChartTheme(chart) {
    const theme = getEchartsTheme();
    if (chart.__pchatTheme === theme) return;
    try {
        chart.setTheme(theme);
        chart.__pchatTheme = theme;
    } catch (e) {
        console.warn('设置图表主题失败:', e && e.message);
    }
}

function updateAllChartThemes(isDark) {
    const theme = isDark ? 'dark' : 'default';
    chartInstances.forEach((chart) => {
        if (!chart) return;
        try {
            chart.setTheme(theme);
            chart.__pchatTheme = theme;
        } catch (e) {
            console.warn('更新图表主题失败:', e && e.message);
        }
    });
    // ECharts 6：setTheme 后必须用 notMerge 重新 setOption，避免旧状态残留
    if (lastUsageData) drawUsageChart(lastUsageData);
}

function applyThemeValue(value) {
    if (value === 'dark' || value === 'light') {
        document.documentElement.setAttribute('data-theme', value);
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    if (typeof window.updateFavicon === 'function') window.updateFavicon();
    updateThemeIcon();
    updateAllChartThemes(isDarkTheme());
}

function toggleTheme() {
    const next = isDarkTheme() ? 'light' : 'dark';
    try { localStorage.setItem('theme', next); } catch (e) { /* 忽略 */ }
    applyThemeValue(next);
}

function initThemeUI() {
    updateThemeIcon();
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.addEventListener('click', toggleTheme);

    window.addEventListener('storage', (e) => {
        if (e.key === 'theme') applyThemeValue(e.newValue);
    });

    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
            if (!document.documentElement.getAttribute('data-theme')) {
                updateThemeIcon();
                updateAllChartThemes(isDarkTheme());
            }
        };
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    }

    window.addEventListener('resize', () => {
        chartInstances.forEach((chart) => {
            try { chart.resize(); } catch (e) { /* 忽略 */ }
        });
    });
}

function redirectToLogin() {
    if (redirecting) return;
    redirecting = true;
    sessionStorage.clear();
    window.location.replace('/index.html');
}

// 管理员请求封装：401/403 立即清空 session 并跳登录页（Phase 4 要求）
async function adminFetch(url, options = {}) {
    const token = sessionStorage.getItem('token');
    if (!token) {
        redirectToLogin();
        throw new Error('登录已过期，请重新登录');
    }
    const headers = Object.assign({}, options.headers || {}, {
        Authorization: `Bearer ${token}`,
    });
    const res = await fetch(url, Object.assign({}, options, { headers }));
    if (res.status === 401 || res.status === 403) {
        redirectToLogin();
        throw new Error('登录已过期或无管理员权限');
    }
    return res;
}

// ---------- 系统初始化 ----------
function statusPill(ok, okText, offText, offClass = 'warn') {
    return ok
        ? `<span class="status-pill ok">${esc(okText)}</span>`
        : `<span class="status-pill ${offClass}">${esc(offText)}</span>`;
}

function renderSystem(d) {
    const box = document.getElementById('systemStatus');
    if (!box) return;
    // 人机验证：密钥是否配置 + 运行级开关 + 最终是否真的生效
    let turnstileText = '已关闭';
    let turnstileClass = 'warn';
    if (d.turnstile_active) {
        turnstileText = '已启用';
        turnstileClass = 'ok';
    } else if (!d.turnstile_keys_configured) {
        turnstileText = d.turnstile_enabled ? '已开启但缺少密钥' : '未配置密钥';
        turnstileClass = 'bad';
    }
    const items = [
        ['主密钥 SECRET_MASTER_KEY', statusPill(d.secret_master_key_configured, '已配置', '未配置', 'bad')],
        ['管理员环境变量（ADMIN_USERNAME / ADMIN_PASSWORD）', statusPill(d.admin_env_configured, '已配置', '未配置', 'bad')],
        ['系统 AI Key（DEEPSEEK_API_KEY）', statusPill(d.system_api_key_configured, '已配置', '未配置')],
        ['允许用户自建 API Key', statusPill(d.user_api_key_enabled, '已开启', '已关闭')],
        ['允许使用系统 Key', statusPill(d.system_api_key_enabled, '已开启', '已关闭')],
        ['开放注册', statusPill(d.allow_register, '已开启', '已关闭')],
        ['注册需要邀请码', statusPill(d.invite_required, '是', '否')],
        ['跨域白名单 ALLOWED_ORIGINS', statusPill(d.allowed_origins_configured, '已配置', '仅同源')],
        // 第 9 项：Turnstile（站点密钥公开 / 服务端密钥保密，这里只显示布尔状态）
        ['Turnstile 站点密钥 TURNSTILE_SITE_KEY', statusPill(d.turnstile_site_key_configured, '已配置', '未配置', 'bad')],
        ['Turnstile 服务端密钥 TURNSTILE_SECRET', statusPill(d.turnstile_secret_configured, '已配置', '未配置', 'bad')],
        ['人机验证实际生效', `<span class="status-pill ${turnstileClass}">${esc(turnstileText)}</span>`],
    ];
    box.innerHTML = items.map(([label, pill]) => `
        <div class="status-item"><span>${esc(label)}</span>${pill}</div>
    `).join('');
}

async function loadSystem() {
    const res = await adminFetch('/api/admin/system');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '读取系统状态失败');
    renderSystem(data);
}

// ---------- 功能开关（运行级配置） ----------
async function loadSettings() {
    const grid = document.getElementById('settingsGrid');
    if (!grid) return;

    grid.innerHTML = '<div class="empty">加载中…</div>';
    try {
        const res = await adminFetch('/api/admin/settings');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '读取功能开关失败');
        const settings = data.settings || {};
        // 人机验证开关旁给出提示：缺哪把密钥（接口只回布尔值，不含密钥本身）
        const ts = data.turnstile || {};
        const missingKeys = [];
        if (ts.site_key_configured === false) missingKeys.push('TURNSTILE_SITE_KEY');
        if (ts.secret_configured === false) missingKeys.push('TURNSTILE_SECRET');
        grid.innerHTML = Object.entries(SETTING_LABELS).map(([key, item]) => {
            const checked = settings[key] === '1';
            const warn = (key === 'turnstile_enabled' && missingKeys.length > 0)
                ? `（缺少 ${missingKeys.join(' / ')}，开启也不会生效）`
                : '';
            return `<div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">${esc(item.name)}</div>
                    <div class="setting-desc">${esc(item.desc)}${warn ? `<span class="setting-warn">${esc(warn)}</span>` : ''}</div>
                </div>
                <input type="checkbox" class="setting-switch" data-setting-key="${esc(key)}"
                       aria-label="${esc(item.name)}"${checked ? ' checked' : ''}>
            </div>`;
        }).join('');
    } catch (err) {
        grid.innerHTML = `<div class="empty">读取失败：${esc(err.message)}</div>`;
        throw err;
    }
}

async function saveSettings() {
    const btn = document.getElementById('saveSettingsBtn');
    const switches = [...document.querySelectorAll('#settingsGrid .setting-switch')];
    if (switches.length === 0) {
        await showAlert('没有可保存的功能开关');
        return;
    }

    const settings = {};
    for (const el of switches) {
        const key = el.dataset.settingKey;
        if (!key) continue;
        settings[key] = el.checked ? '1' : '0';
    }

    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中…';
    }
    try {
        const res = await adminFetch('/api/admin/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '保存失败');
        toast(`已保存 ${data.updated || 0} 项配置`, 'success');
        // 请求已完成：先恢复按钮，再刷新相关面板（避免"保存中…"覆盖刷新过程）
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
        await Promise.all([loadSettings(), loadSystem(), loadAdminLogs()]);
    } catch (err) {
        await showAlert(err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
}

// ---------- 邀请码管理 ----------
async function loadInvites() {
    const body = document.getElementById('invitesBody');
    if (!body) return;

    body.innerHTML = '<tr><td colspan="5" class="empty">加载中…</td></tr>';
    try {
        const params = new URLSearchParams({
            page: String(invitesState.page),
            page_size: String(invitesState.pageSize),
        });
        const res = await adminFetch(`/api/admin/invites?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '读取邀请码失败');
        renderInvites(data);
    } catch (err) {
        body.innerHTML = `<tr><td colspan="5" class="empty">读取失败：${esc(err.message)}</td></tr>`;
        throw err;
    }
}

function renderInvites(d) {
    const body = document.getElementById('invitesBody');
    if (!body) return;
    const rows = Array.isArray(d.invites) ? d.invites : [];

    if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="5" class="empty">还没有邀请码，输入有效天数后点「生成邀请码」</td></tr>';
    } else {
        body.innerHTML = rows.map((invite) => {
            const used = !!invite.used_by;
            const expired = Number(invite.expired) === 1;
            let statusText = '未使用';
            let statusClass = 'ok';
            let rowClass = 'invite-row-unused';
            if (used) {
                statusText = '已使用';
                statusClass = 'warn';
                rowClass = 'invite-row-used';
            } else if (expired) {
                statusText = '已过期';
                statusClass = 'bad';
                rowClass = 'invite-row-expired';
            }
            const usedBy = invite.used_by_username
                ? ` <span class="muted">(${esc(invite.used_by_username)})</span>`
                : '';
            const expires = invite.expires_at ? esc(formatTime(invite.expires_at)) : '永久有效';
            return `<tr class="${rowClass}">
                <td class="mono">${esc(invite.id)}</td>
                <td class="invite-code">${esc(invite.code)}</td>
                <td><span class="status-pill ${statusClass}">${statusText}</span>${usedBy}</td>
                <td class="nowrap">${expires}</td>
                <td><button class="btn-secondary btn-xs" data-copy-code="${esc(invite.code)}"><i class="fas fa-copy"></i> 复制</button></td>
            </tr>`;
        }).join('');
    }

    const total = Number(d.total) || 0;
    const pageSize = Number(d.page_size) || 20;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const info = document.getElementById('invitesPageInfo');
    if (info) info.textContent = `第 ${d.page || 1} / ${totalPages} 页 · 共 ${total} 个`;
    const prev = document.getElementById('invitesPrev');
    const next = document.getElementById('invitesNext');
    if (prev) prev.disabled = (d.page || 1) <= 1;
    if (next) next.disabled = (d.page || 1) >= totalPages;
}

async function generateInvites() {
    const input = document.getElementById('inviteExpireDays');
    const btn = document.getElementById('generateInvitesBtn');
    const days = parseInt(input ? input.value : '', 10);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
        await showAlert('有效天数需为 1~3650 的整数');
        return;
    }

    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 生成中…';
    }
    try {
        const res = await adminFetch('/api/admin/invites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count: 1, expire_days: days }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '生成失败');
        toast(`已生成 ${data.count || 1} 个邀请码`, 'success');
        invitesState.page = 1;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
        await Promise.all([loadInvites(), loadAdminLogs()]);
    } catch (err) {
        await showAlert(err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
}

async function copyInviteCode(code) {
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code);
        toast('已复制', 'success');
    } catch (e) {
        // 非 HTTPS / 剪贴板权限被拒时的兜底
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            toast('已复制', 'success');
        } catch (err) {
            await showAlert('复制失败，请手动选择邀请码复制');
        }
        ta.remove();
    }
}

function generateMasterKey() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
        showAlert('当前浏览器不支持安全随机数生成，请改用 openssl rand -base64 32');
        return;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    const key = btoa(binary);

    const modal = document.getElementById('masterKeyModal');
    const codeEl = document.getElementById('generatedMasterKey');
    const copyBtn = document.getElementById('copyMasterKey');
    if (codeEl) codeEl.textContent = key;
    if (copyBtn) copyBtn.disabled = false;

    keyDeadline = Date.now() + 10 * 60 * 1000;
    startKeyCountdown();
    if (modal) showModal(modal);
}

function startKeyCountdown() {
    clearInterval(keyTimer);
    const tick = () => {
        const remain = Math.max(0, keyDeadline - Date.now());
        const el = document.getElementById('keyCountdown');
        if (el) {
            const mm = String(Math.floor(remain / 60000)).padStart(2, '0');
            const ss = String(Math.floor((remain % 60000) / 1000)).padStart(2, '0');
            el.textContent = remain > 0 ? `${mm}:${ss}` : '已过期';
        }
        if (remain <= 0) {
            clearInterval(keyTimer);
            keyTimer = null;
            const codeEl = document.getElementById('generatedMasterKey');
            const copyBtn = document.getElementById('copyMasterKey');
            if (codeEl) codeEl.textContent = '已过期，请重新生成';
            if (copyBtn) copyBtn.disabled = true;
        }
    };
    tick();
    keyTimer = setInterval(tick, 1000);
}

function closeMasterKeyModal() {
    clearInterval(keyTimer);
    keyTimer = null;
    const modal = document.getElementById('masterKeyModal');
    const codeEl = document.getElementById('generatedMasterKey');
    if (codeEl) codeEl.textContent = '';
    if (modal) hideModal(modal);
}

async function copyMasterKey() {
    const codeEl = document.getElementById('generatedMasterKey');
    const code = codeEl ? codeEl.textContent.trim() : '';
    if (!code || code.indexOf('已过期') === 0) return;
    try {
        await navigator.clipboard.writeText(code);
        toast('已复制到剪贴板', 'success');
    } catch (e) {
        // 非 HTTPS / 权限被拒时的兜底
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            toast('已复制到剪贴板', 'success');
        } catch (err) {
            await showAlert('复制失败，请手动选择密钥复制');
        }
        ta.remove();
    }
}

// ---------- 用户管理 ----------
async function loadUsers() {
    const params = new URLSearchParams({
        page: String(usersState.page),
        page_size: String(usersState.pageSize),
    });
    if (usersState.q) params.set('q', usersState.q);

    const res = await adminFetch(`/api/admin/users?${params.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '读取用户列表失败');
    renderUsers(data);
}

function renderUsers(d) {
    const body = document.getElementById('usersBody');
    if (!body) return;
    const users = Array.isArray(d.users) ? d.users : [];

    if (users.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="empty">没有匹配的用户</td></tr>';
    } else {
        body.innerHTML = users.map((u) => {
            const roleBadge = u.role === 'admin'
                ? '<span class="badge badge-admin">管理员</span>'
                : '<span class="badge">普通用户</span>';
            const statusText = STATUS_TEXT[u.status] || u.status || '未知';
            const statusClass = STATUS_CLASS[u.status] || 'warn';
            let action = '<span class="muted">—</span>';
            if (u.role === 'user') {
                const next = u.status === 'active' ? 'banned' : 'active';
                const label = next === 'banned' ? '封禁' : '解封';
                const cls = next === 'banned' ? 'btn-danger btn-xs' : 'btn-secondary btn-xs';
                action = `<button class="${cls}" data-user-id="${u.id}" data-status="${esc(u.status)}" data-username="${esc(u.username)}">${label}</button>`;
            }
            return `<tr>
                <td class="mono">${u.id}</td>
                <td>${esc(u.username)}</td>
                <td>${roleBadge}</td>
                <td><span class="status-pill ${statusClass}">${esc(statusText)}</span></td>
                <td>${formatNumber(u.today_tokens)}</td>
                <td>${action}</td>
            </tr>`;
        }).join('');
    }

    const total = Number(d.total) || 0;
    const pageSize = Number(d.page_size) || 20;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const info = document.getElementById('usersPageInfo');
    if (info) info.textContent = `第 ${d.page || 1} / ${totalPages} 页 · 共 ${total} 人`;
    const prev = document.getElementById('usersPrev');
    const next = document.getElementById('usersNext');
    if (prev) prev.disabled = (d.page || 1) <= 1;
    if (next) next.disabled = (d.page || 1) >= totalPages;
}

async function changeUserStatus(btn) {
    const userId = btn.dataset.userId;
    const current = btn.dataset.status;
    const username = btn.dataset.username;
    const next = current === 'active' ? 'banned' : 'active';
    const actionLabel = next === 'banned' ? '封禁' : '解封';
    const hint = next === 'banned'
        ? '封禁后该用户的所有会话会立即失效。'
        : '解封后用户可以重新登录。';
    const ok = await showConfirm(
        `确定要${actionLabel}用户「${username}」吗？${hint}`,
        `${actionLabel}用户`,
        actionLabel,
        '取消'
    );
    if (!ok) return;

    btn.disabled = true;
    try {
        const res = await adminFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: next }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '操作失败');
        toast(`${actionLabel}成功`, 'success');
        await Promise.all([loadUsers(), loadAdminLogs()]);
    } catch (err) {
        await showAlert(err.message);
        btn.disabled = false;
    }
}

// ---------- 用量统计 ----------
async function loadUsage() {
    const res = await adminFetch(`/api/admin/usage?days=${usageDays}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '读取用量统计失败');
    renderUsage(data);
}

function drawUsageChart(d) {
    const dom = document.getElementById('usageChart');
    if (!dom) return;
    if (!window.echarts || typeof window.echarts.init !== 'function') {
        dom.innerHTML = '<div class="usage-empty">图表库加载失败，请检查网络后刷新</div>';
        return;
    }

    if (!usageChartInstance) {
        usageChartInstance = window.echarts.init(dom, getEchartsTheme(), { renderer: 'canvas' });
        usageChartInstance.__pchatTheme = getEchartsTheme();
        chartInstances.push(usageChartInstance);
    }
    ensureUsageChartTheme(usageChartInstance);

    const map = new Map((d.daily || []).map((x) => [String(x.date), Number(x.tokens) || 0]));
    const days = [];
    if (d.since && d.today) {
        const start = Date.parse(`${d.since}T00:00:00Z`);
        const end = Date.parse(`${d.today}T00:00:00Z`);
        for (let t = start; t <= end; t += 86400000) {
            const day = new Date(t).toISOString().slice(0, 10);
            days.push({ day, tokens: map.get(day) || 0 });
        }
    }

    usageChartInstance.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        grid: { left: 56, right: 18, top: 20, bottom: 28 },
        xAxis: {
            type: 'category',
            boundaryGap: false,
            data: days.map((x) => x.day.slice(5)),
            axisTick: { show: false },
        },
        yAxis: { type: 'value', minInterval: 1 },
        series: [{
            name: 'tokens',
            type: 'line',
            smooth: true,
            symbol: 'circle',
            symbolSize: 5,
            data: days.map((x) => x.tokens),
            lineStyle: { width: 2, color: '#10b981' },
            itemStyle: { color: '#10b981' },
            areaStyle: { color: 'rgba(16, 185, 129, 0.12)' },
        }],
        graphic: days.length ? [] : [{
            type: 'text',
            left: 'center',
            top: 'middle',
            style: { text: '暂无用量数据', fill: '#8a8a8a', fontSize: 12 },
        }],
    }, { notMerge: true });
}

function renderUsage(d) {
    const totals = d.totals || {};
    const today = d.today_totals || {};
    const stats = document.getElementById('usageStats');
    if (stats) {
        stats.innerHTML = `
            <div class="stat-card"><span class="num">${formatNumber(today.tokens)}</span><span class="label">今日 tokens</span></div>
            <div class="stat-card"><span class="num">${formatNumber(today.users)}</span><span class="label">今日有用量用户</span></div>
            <div class="stat-card"><span class="num">${formatNumber(totals.tokens)}</span><span class="label">近 ${d.days} 天 tokens</span></div>
            <div class="stat-card"><span class="num">${formatNumber(totals.users)}</span><span class="label">近 ${d.days} 天用户</span></div>
        `;
    }

    // 每日 token 用量趋势（ECharts 折线图）
    lastUsageData = d;
    drawUsageChart(d);

    const body = document.getElementById('usageBody');
    if (!body) return;
    const rows = Array.isArray(d.per_user) ? d.per_user : [];
    body.innerHTML = rows.length
        ? rows.map((u) => `<tr>
                <td>${esc(u.username)}${u.role === 'admin' ? ' <span class="badge badge-admin">管理员</span>' : ''}</td>
                <td>${formatNumber(u.tokens_used)}</td>
                <td class="mono">${esc(u.last_date || '—')}</td>
            </tr>`).join('')
        : '<tr><td colspan="3" class="empty">区间内暂无 token 用量（只有使用系统 Key 的请求会计入）</td></tr>';
}

// ---------- 操作日志 ----------
// target 可能是一整段 JSON（例如 {"user_id":12,"fields":[...]}），直接铺开会把表格撑变形：
// 超过 20 字符截断加省略号，并用 title 保留全貌（鼠标悬停可看全文）。
const LOG_TARGET_MAX = 20;

function truncateLogText(value, max = LOG_TARGET_MAX) {
    const s = String(value === null || value === undefined ? '' : value);
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
}

async function loadAdminLogs() {
    const res = await adminFetch('/api/admin/logs/admin?limit=100');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '读取操作日志失败');

    const body = document.getElementById('adminLogsBody');
    if (!body) return;
    const rows = Array.isArray(data.logs) ? data.logs : [];
    body.innerHTML = rows.length
        ? rows.map((l) => {
            const targetRaw = l.target === null || l.target === undefined ? '' : String(l.target);
            const targetShort = truncateLogText(targetRaw);
            const targetTitle = targetRaw.length > LOG_TARGET_MAX ? ` title="${esc(targetRaw)}"` : '';
            return `<tr>
                <td class="nowrap">${esc(formatTime(l.created_at))}</td>
                <td>${esc(l.admin_username || `#${l.admin_id}`)}</td>
                <td>${esc(ACTION_TEXT[l.action] || l.action)} <span class="muted mono">${esc(l.action)}</span></td>
                <td class="cell-clamp"${targetTitle}>${esc(targetShort || '—')}</td>
                <td class="mono">${esc(l.ip || '—')}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="5" class="empty">暂无操作记录</td></tr>';
}

// ---------- 登录日志 ----------
async function loadLoginLogs() {
    const res = await adminFetch(`/api/admin/logs/login?days=${loginDays}&limit=200`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '读取登录日志失败');

    const retentionInput = document.getElementById('retentionDays');
    if (retentionInput && data.retention_days) retentionInput.value = data.retention_days;

    const body = document.getElementById('loginLogsBody');
    if (!body) return;
    const rows = Array.isArray(data.logs) ? data.logs : [];
    const meta = {
        success: ['成功', 'ok'],
        failed: ['失败', 'bad'],
        blocked: ['拦截', 'warn'],
    };
    body.innerHTML = rows.length
        ? rows.map((l) => {
            const m = meta[l.status] || [l.status || '未知', 'warn'];
            const reason = REASON_TEXT[l.reason] || l.reason || '';
            const user = l.username || (l.user_id ? `#${l.user_id}` : '—');
            return `<tr>
                <td class="nowrap">${esc(formatTime(l.created_at))}</td>
                <td>${esc(user)}</td>
                <td><span class="status-pill ${m[1]}">${esc(m[0])}</span></td>
                <td>${esc(reason || '—')}</td>
                <td class="mono">${esc(l.ip || '—')}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="5" class="empty">该时间段内没有登录记录</td></tr>';
}

async function saveRetention() {
    const input = document.getElementById('retentionDays');
    const days = parseInt(input ? input.value : '', 10);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
        await showAlert('保留天数需为 1~3650 的整数');
        return;
    }
    const ok = await showConfirm(
        `将登录日志保留天数设为 ${days} 天？超期记录会被立即删除。`,
        '保存保留天数',
        '保存',
        '取消'
    );
    if (!ok) return;

    const btn = document.getElementById('saveRetentionBtn');
    if (btn) btn.disabled = true;
    try {
        const res = await adminFetch('/api/admin/logs/login', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ retention_days: days }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '保存失败');
        toast(`已保存，清理 ${data.deleted || 0} 条超期日志`, 'success');
        await Promise.all([loadLoginLogs(), loadAdminLogs()]);
    } catch (err) {
        await showAlert(err.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ---------- 刷新全部 / 事件绑定 ----------
async function refreshAll() {
    const btn = document.getElementById('refreshAllBtn');
    const icon = btn ? btn.querySelector('i') : null;
    if (icon) icon.classList.add('fa-spin');
    try {
        await Promise.all([loadSystem(), loadSettings(), loadInvites(), loadUsers(), loadUsage(), loadAdminLogs(), loadLoginLogs()]);
        toast('已刷新', 'success');
    } catch (err) {
        if (!/登录已过期|无管理员权限/.test(err.message)) {
            await showAlert('刷新失败：' + err.message);
        }
    } finally {
        if (icon) icon.classList.remove('fa-spin');
    }
}

function bindEvents() {
    const refreshBtn = document.getElementById('refreshAllBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshAll);

    // 功能开关
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', saveSettings);

    // 邀请码
    const generateInvitesBtn = document.getElementById('generateInvitesBtn');
    if (generateInvitesBtn) generateInvitesBtn.addEventListener('click', generateInvites);
    const inviteExpireDays = document.getElementById('inviteExpireDays');
    if (inviteExpireDays) {
        inviteExpireDays.addEventListener('keypress', (e) => { if (e.key === 'Enter') generateInvites(); });
    }
    const invitesBody = document.getElementById('invitesBody');
    if (invitesBody) {
        invitesBody.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-copy-code]');
            if (btn) copyInviteCode(btn.dataset.copyCode);
        });
    }
    const invitesPrev = document.getElementById('invitesPrev');
    if (invitesPrev) invitesPrev.addEventListener('click', () => {
        if (invitesState.page > 1) {
            invitesState.page -= 1;
            loadInvites().catch((err) => showAlert(err.message));
        }
    });
    const invitesNext = document.getElementById('invitesNext');
    if (invitesNext) invitesNext.addEventListener('click', () => {
        invitesState.page += 1;
        loadInvites().catch((err) => showAlert(err.message));
    });

    // 主密钥
    const genBtn = document.getElementById('genMasterKeyBtn');
    if (genBtn) genBtn.addEventListener('click', generateMasterKey);
    const closeKey = document.getElementById('closeMasterKey');
    if (closeKey) closeKey.addEventListener('click', closeMasterKeyModal);
    const copyBtn = document.getElementById('copyMasterKey');
    if (copyBtn) copyBtn.addEventListener('click', copyMasterKey);
    const keyModal = document.getElementById('masterKeyModal');
    if (keyModal) {
        keyModal.addEventListener('click', (e) => {
            if (e.target === keyModal) closeMasterKeyModal();
        });
    }

    // 用户搜索 / 分页 / 封禁
    const searchBtn = document.getElementById('userSearchBtn');
    const searchInput = document.getElementById('userSearch');
    const doSearch = () => {
        usersState.q = searchInput ? searchInput.value.trim() : '';
        usersState.page = 1;
        loadUsers().catch((err) => showAlert(err.message));
    };
    if (searchBtn) searchBtn.addEventListener('click', doSearch);
    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') doSearch(); });
    }
    const prevBtn = document.getElementById('usersPrev');
    if (prevBtn) prevBtn.addEventListener('click', () => {
        if (usersState.page > 1) {
            usersState.page -= 1;
            loadUsers().catch((err) => showAlert(err.message));
        }
    });
    const nextBtn = document.getElementById('usersNext');
    if (nextBtn) nextBtn.addEventListener('click', () => {
        usersState.page += 1;
        loadUsers().catch((err) => showAlert(err.message));
    });
    const usersBody = document.getElementById('usersBody');
    if (usersBody) {
        usersBody.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-user-id]');
            if (btn) changeUserStatus(btn);
        });
    }

    // 用量区间
    document.querySelectorAll('#usageDays .chip').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#usageDays .chip').forEach((b) => b.classList.toggle('active', b === btn));
            usageDays = Number(btn.dataset.days) || 30;
            loadUsage().catch((err) => showAlert(err.message));
        });
    });

    // 登录日志区间 / 保留天数
    document.querySelectorAll('#loginDays .chip').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#loginDays .chip').forEach((b) => b.classList.toggle('active', b === btn));
            loginDays = Number(btn.dataset.days) || 7;
            loadLoginLogs().catch((err) => showAlert(err.message));
        });
    });
    const saveRetentionBtn = document.getElementById('saveRetentionBtn');
    if (saveRetentionBtn) saveRetentionBtn.addEventListener('click', saveRetention);
}

function init() {
    if (!sessionStorage.getItem('token')) {
        redirectToLogin();
        return;
    }
    let user = null;
    try { user = JSON.parse(sessionStorage.getItem('user') || 'null'); } catch (e) { user = null; }
    const label = document.getElementById('adminUser');
    if (label && user) {
        label.textContent = `${user.username}${user.role === 'admin' ? ' · 管理员' : ''}`;
    }

    initThemeUI();
    bindEvents();
    Promise.all([loadSystem(), loadSettings(), loadInvites(), loadUsers(), loadUsage(), loadAdminLogs(), loadLoginLogs()])
        .catch(async (err) => {
            if (!/登录已过期|无管理员权限/.test(err.message)) {
                await showAlert('加载失败：' + err.message);
            }
        })
        .finally(hideSplash);
}

document.addEventListener('DOMContentLoaded', init);
