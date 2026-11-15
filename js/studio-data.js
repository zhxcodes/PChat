// ============================================================
// 「外观与玩法中心」的数据区
// ------------------------------------------------------------
// 职责：
//   1. 备份：导出全部角色（GET /api/ai/export-all）
//   2. 导入：解析本项目导出的 JSON（单角色 / 整包），预览 → 确认 → 执行
//   3. 本机用量：localStorage 占用、缓存条目、背景图大小
//   4. 会话洞察 + 年度热力图（GET /api/insights?heatmap=1）
//
// 依赖：window.enhance（背景信息）、modal.js（showConfirm / toast 用 .toast 样式）
// 不依赖 studio.js，两个文件各自初始化。
// ============================================================
(function () {
    'use strict';

    var MAX_IMPORT = 5000;

    function $(id) { return document.getElementById(id); }

    function el(tag, cls, html) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html !== undefined && html !== null) n.innerHTML = html;
        return n;
    }

    function esc(s) {
        if (typeof escapeHtml === 'function') return escapeHtml(s);
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] || m;
        });
    }

    function token() {
        try { return sessionStorage.getItem('token') || ''; } catch (e) { return ''; }
    }

    var toastTimer = null;
    function toast(msg, type) {
        var old = document.querySelector('.toast');
        if (old) old.remove();
        var t = el('div', 'toast ' + (type || 'info'));
        t.textContent = msg;
        document.body.appendChild(t);
        requestAnimationFrame(function () { t.classList.add('show'); });
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            t.classList.remove('show');
            setTimeout(function () { t.remove(); }, 420);
        }, 2600);
    }

    function fmtBytes(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }

    function fmtDay(d) {
        var pad = function (x) { return String(x).padStart(2, '0'); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    // ======================== 备份 ========================
    async function downloadBackup() {
        var t = token();
        if (!t) { toast('请先回到聊天页登录', 'error'); return; }
        var btn = $('backupBtn');
        var html = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 打包中…'; }
        try {
            var res = await fetch('/api/ai/export-all', { headers: { Authorization: 'Bearer ' + t } });
            if (!res.ok) {
                var err = await res.json().catch(function () { return {}; });
                throw new Error(err.error || ('HTTP ' + res.status));
            }
            var blob = await res.blob();
            var stamp = new Date().toISOString().slice(0, 10);
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'pchat-backup_' + stamp + '.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
            toast('备份已开始下载（' + fmtBytes(blob.size) + '）', 'success');
        } catch (e) {
            toast('备份失败：' + e.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = html; }
        }
    }

    // ======================== 导入：解析与预览 ========================
    var importState = {
        kind: '',            // 'single' | 'bundle'
        file: '',
        single: null,        // { messages, contact_id }
        bundle: null,        // { contacts: [...] }
        selected: [],        // bundle 选中的 contact_id
        mode: 'merge'
    };

    function resetImportPanel() {
        importState = { kind: '', file: '', single: null, bundle: null, selected: [], mode: 'merge' };
        var panel = $('importPanel');
        if (panel) panel.hidden = true;
        var resEl = $('importResult');
        if (resEl) resEl.textContent = '';
        var fileEl = $('importFile');
        if (fileEl) fileEl.value = '';
    }

    function normalizeBundle(raw) {
        if (!raw || !Array.isArray(raw.contacts)) return null;
        var list = raw.contacts
            .filter(function (c) { return c && Array.isArray(c.messages) && c.messages.length; })
            .map(function (c) {
                return {
                    contact_id: String(c.contact_id || ''),
                    display_name: String(c.display_name || c.contact_id || '未命名'),
                    contact_type: c.contact_type === 'user' ? 'user' : 'ai',
                    messages: c.messages.slice(0, MAX_IMPORT)
                };
            });
        return list.length ? { contacts: list } : null;
    }

    async function loadContactsForSelect() {
        var t = token();
        if (!t) return [];
        try {
            var res = await fetch('/api/contacts', { headers: { Authorization: 'Bearer ' + t } });
            if (!res.ok) return [];
            var list = await res.json();
            return Array.isArray(list) ? list : [];
        } catch (e) {
            return [];
        }
    }

    async function openImportPanel(parsed) {
        var panel = $('importPanel');
        var summary = $('importSummary');
        var targetSel = $('importTarget');
        var contactsBox = $('importContacts');
        var newName = $('importNewName');
        var modeSeg = $('importModeSeg');
        if (!panel || !targetSel || !contactsBox) return;

        importState.mode = 'merge';
        if (modeSeg) {
            Array.prototype.forEach.call(modeSeg.querySelectorAll('button'), function (b) {
                b.classList.toggle('active', b.dataset.mode === 'merge');
            });
            // 整包还原时禁止「覆盖」，避免误删多个角色
            var replaceBtn = modeSeg.querySelector('[data-mode="replace"]');
            if (replaceBtn) replaceBtn.disabled = parsed.kind === 'bundle';
        }

        contactsBox.hidden = true;
        contactsBox.innerHTML = '';

        if (parsed.kind === 'bundle') {
            importState.bundle = normalizeBundle(parsed.raw);
            if (!importState.bundle) { toast('备份文件里没有可导入的对话', 'error'); return; }
            importState.kind = 'bundle';
            importState.selected = importState.bundle.contacts.map(function (c) { return c.contact_id; });
            targetSel.innerHTML = '<option>按备份还原（同 contact_id，不存在则新建）</option>';
            targetSel.disabled = true;
            if (newName) newName.hidden = true;
            contactsBox.hidden = false;
            renderBundleContacts();
            var total = importState.bundle.contacts.reduce(function (n, c) { return n + c.messages.length; }, 0);
            if (summary) summary.textContent = '整包备份：' + importState.bundle.contacts.length + ' 个角色、' + total + ' 条消息';
        } else {
            var msgs = Array.isArray(parsed.raw.messages) ? parsed.raw.messages : parsed.raw;
            if (!Array.isArray(msgs)) { toast('文件格式不对：缺少 messages 数组', 'error'); return; }
            importState.kind = 'single';
            importState.single = { messages: msgs, contact_id: parsed.raw.contact_id || '' };
            var list = await loadContactsForSelect();
            targetSel.disabled = false;
            targetSel.innerHTML = '<option value="__new__">＋ 新建角色…</option>' + list.map(function (c) {
                return '<option value="' + esc(c.contact_id) + '">' + esc(c.display_name) +
                    '（' + esc(c.contact_id) + '）</option>';
            }).join('');
            if (newName) {
                newName.hidden = true;
                newName.value = parsed.raw.contact_id || parsed.fileBase || '导入的对话';
            }
            if (summary) summary.textContent = '单角色文件：' + msgs.length + ' 条消息' +
                (parsed.raw.contact_id ? '（原角色 ' + parsed.raw.contact_id + '）' : '');
        }

        panel.hidden = false;
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function renderBundleContacts() {
        var box = $('importContacts');
        if (!box || !importState.bundle) return;
        box.innerHTML = '';
        importState.bundle.contacts.forEach(function (c) {
            var row = el('label', 'import-contact-row');
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = importState.selected.indexOf(c.contact_id) !== -1;
            cb.addEventListener('change', function () {
                var i = importState.selected.indexOf(c.contact_id);
                if (cb.checked && i === -1) importState.selected.push(c.contact_id);
                if (!cb.checked && i !== -1) importState.selected.splice(i, 1);
            });
            row.appendChild(cb);
            row.appendChild(el('span', null, esc(c.display_name)));
            row.appendChild(el('span', null, c.messages.length + ' 条 · ' + esc(c.contact_id)));
            box.appendChild(row);
        });
    }

    function handleFile(file) {
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) { toast('文件不能超过 20MB', 'error'); return; }
        var reader = new FileReader();
        reader.onload = function () {
            var raw;
            try {
                raw = JSON.parse(String(reader.result));
            } catch (e) {
                toast('不是合法的 JSON 文件', 'error');
                return;
            }
            var kind = (raw && Array.isArray(raw.contacts)) ? 'bundle' : 'single';
            openImportPanel({ kind: kind, raw: raw, fileBase: String(file.name || '').replace(/\.json$/i, '') });
        };
        reader.onerror = function () { toast('读取文件失败', 'error'); };
        reader.readAsText(file);
    }

    // ======================== 导入：执行 ========================
    function buildRequests(dryRun) {
        var t = token();
        var reqs = [];
        if (importState.kind === 'single') {
            var targetSel = $('importTarget');
            var newName = $('importNewName');
            var v = targetSel ? targetSel.value : '__new__';
            var target;
            if (v === '__new__') {
                var name = (newName && newName.value.trim()) || '导入的对话';
                target = { type: 'new', display_name: name };
            } else {
                target = { type: 'existing', contact_id: v };
            }
            reqs.push({
                url: '/api/ai/import',
                body: { target: target, mode: importState.mode, dry_run: !!dryRun, messages: importState.single.messages },
                label: target.type === 'new' ? ('新建：' + target.display_name) : ('合并到 ' + v),
            });
        } else if (importState.kind === 'bundle') {
            importState.bundle.contacts.forEach(function (c) {
                if (importState.selected.indexOf(c.contact_id) === -1) return;
                reqs.push({
                    url: '/api/ai/import',
                    body: {
                        target: {
                            type: 'new',
                            display_name: c.display_name,
                            contact_id: c.contact_id,
                            contact_type: c.contact_type,
                        },
                        mode: 'merge',
                        dry_run: !!dryRun,
                        messages: c.messages,
                    },
                    label: c.display_name + '（' + c.contact_id + '）',
                });
            });
        }
        return { token: t, reqs: reqs };
    }

    async function postImport(body) {
        var res = await fetch('/api/ai/import', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + token(),
            },
            body: JSON.stringify(body),
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
    }

    async function runImport(dryRun) {
        var built = buildRequests(dryRun);
        if (!built.token) { toast('请先回到聊天页登录', 'error'); return; }
        if (!built.reqs.length) { toast('没有选中要导入的角色', 'info'); return; }

        var out = $('importResult');
        var runBtn = $('importRun');
        var dryBtn = $('importDryRun');
        if (runBtn) runBtn.disabled = true;
        if (dryBtn) dryBtn.disabled = true;
        if (out) out.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ' + (dryRun ? '正在预览…' : '正在写入…');

        var lines = [];
        var sum = { total: 0, valid: 0, duplicates: 0, invalid: 0, imported: 0, skipped: 0 };
        var failed = 0;

        try {
            for (var i = 0; i < built.reqs.length; i++) {
                var r = built.reqs[i];
                try {
                    var d = await postImport(r.body);
                    sum.total += d.total || 0;
                    sum.valid += d.valid || 0;
                    sum.duplicates += d.duplicates || 0;
                    sum.invalid += d.invalid || 0;
                    sum.imported += d.imported || 0;
                    sum.skipped += d.skipped || 0;
                    lines.push('· ' + r.label + '：' + (dryRun
                        ? ('将写入 ' + d.will_import + ' 条，跳过重复 ' + d.duplicates + ' 条')
                        : ('写入 ' + d.imported + ' 条，跳过 ' + d.skipped + ' 条')));
                } catch (e) {
                    failed += 1;
                    lines.push('· ' + r.label + '：<b>失败</b> — ' + esc(e.message));
                }
            }

            if (!dryRun) {
                toast('导入完成：写入 ' + sum.imported + ' 条', sum.imported ? 'success' : 'info');
                loadData();
                loadUsage();
            } else {
                toast('预览完成：将写入 ' + (sum.valid - sum.duplicates) + ' 条', 'info');
            }
        } finally {
            if (runBtn) runBtn.disabled = false;
            if (dryBtn) dryBtn.disabled = false;
            if (out) {
                out.innerHTML = (dryRun ? '<b>预览结果（未写入）</b>' : '<b>导入结果</b>') +
                    '<br>' + lines.join('<br>') +
                    (failed ? '<br>失败 ' + failed + ' 个' : '') +
                    (!dryRun ? '<br><span style="color:var(--text-tertiary)">已自动清理该角色的上下文热缓存，下一条消息会立刻用上新历史。</span>' : '');
            }
        }
    }

    // ======================== 本机用量 ========================
    function storageBytes() {
        var total = 0;
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                var v = localStorage.getItem(k) || '';
                total += (k.length + v.length) * 2; // UTF-16
            }
        } catch (e) {}
        return total;
    }

    function cacheBytes() {
        var total = 0, count = 0;
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (!k) continue;
                if (k.indexOf('pchat_history_') === 0 || k.indexOf('pchat_contacts') === 0) {
                    total += (k.length + (localStorage.getItem(k) || '').length) * 2;
                    count += 1;
                }
            }
        } catch (e) {}
        return { total: total, count: count };
    }

    async function loadUsage() {
        var box = $('usageBox');
        if (!box) return;
        var c = cacheBytes();
        var bg = (window.enhance && window.enhance.getBackgroundInfo) ? window.enhance.getBackgroundInfo() : { bytes: 0 };
        var msgCount = 0;
        try {
            var t = token();
            if (t) {
                var res = await fetch('/api/insights?contact=', { headers: { Authorization: 'Bearer ' + t } });
                if (res.ok) {
                    var d = await res.json();
                    msgCount = (d.global && d.global.messages) || 0;
                }
            }
        } catch (e) {}
        box.innerHTML =
            '<div class="data-cell"><b>' + esc(String(msgCount)) + '</b><span>云端消息</span></div>' +
            '<div class="data-cell"><b>' + esc(fmtBytes(storageBytes())) + '</b><span>localStorage 占用</span></div>' +
            '<div class="data-cell"><b>' + esc(String(c.count)) + '</b><span>本地缓存条目</span></div>' +
            '<div class="data-cell"><b>' + esc(fmtBytes(bg.bytes || 0)) + '</b><span>背景图</span></div>';
        var hint = $('usageHint');
        if (hint) hint.textContent = '缓存 ' + fmtBytes(c.total);
    }

    function clearLocalCaches() {
        var removed = 0;
        try {
            for (var i = localStorage.length - 1; i >= 0; i--) {
                var k = localStorage.key(i);
                if (!k) continue;
                if (k.indexOf('pchat_history_') === 0 || k.indexOf('pchat_contacts') === 0) {
                    localStorage.removeItem(k);
                    removed += 1;
                }
            }
        } catch (e) {}
        toast(removed ? ('已清理 ' + removed + ' 项本地缓存（外观设置保留）') : '没有需要清理的缓存', 'success');
        loadUsage();
    }

    // ======================== 洞察 + 热力图 ========================
    async function loadData() {
        var box = $('dataBox');
        if (!box) return;
        var t = token();
        if (!t) {
            box.innerHTML = '<div class="studio-hint">未登录，暂无数据。先 <a href="/">回到聊天页登录</a>。</div>';
            renderHeatmap(null);
            return;
        }
        box.innerHTML = '<div class="studio-hint">统计中…</div>';
        try {
            var res = await fetch('/api/insights?contact=&heatmap=1', { headers: { Authorization: 'Bearer ' + t } });
            if (!res.ok) throw new Error(res.status === 401 ? '登录已过期' : 'HTTP ' + res.status);
            var d = await res.json();
            var g = d.global || {};
            var max = 1;
            (d.daily || []).forEach(function (x) { if (x.count > max) max = x.count; });
            var bars = (d.daily || []).map(function (x) {
                var h = Math.max(2, Math.round((x.count / max) * 40));
                return '<div style="height:' + h + 'px" title="' + esc(x.day + ' · ' + x.count + ' 条') + '"></div>';
            }).join('');
            var topHour = (d.hours && d.hours[0]) ? (d.hours[0].hour + ' 点') : '—';
            box.innerHTML =
                '<div class="data-grid">' +
                '<div class="data-cell"><b>' + esc(String(g.messages || 0)) + '</b><span>累计消息</span></div>' +
                '<div class="data-cell"><b>' + esc(String(g.days || 0)) + '</b><span>聊过天数</span></div>' +
                '<div class="data-cell"><b>' + esc(String(g.streak_current || 0)) + '</b><span>当前连续（天）</span></div>' +
                '<div class="data-cell"><b>' + esc(String(g.streak_longest || 0)) + '</b><span>最长连续（天）</span></div>' +
                '<div class="data-cell"><b>' + esc(topHour) + '</b><span>最常出没时段</span></div>' +
                '</div>' +
                '<div class="studio-spark" title="最近 14 天">' + bars + '</div>' +
                '<div class="studio-hint">最近 14 天消息分布；按角色看详情请到聊天页打开「会话洞察」。</div>';
            renderHeatmap(d.heatmap || []);
        } catch (e) {
            box.innerHTML = '<div class="studio-hint">统计失败：' + esc(e.message) + '</div>';
            renderHeatmap(null);
        }
    }

    // 年度热力图：从今天往前 53 周（371 天），对齐到周一
    function renderHeatmap(rows) {
        var box = $('heatmapBox');
        if (!box) return;
        if (rows === null) {
            box.innerHTML = '<div class="studio-hint">登录后显示。</div>';
            return;
        }
        var map = {};
        (rows || []).forEach(function (x) { map[x.day] = x.count; });

        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var start = new Date(today.getTime() - 370 * 86400000);
        // 对齐到周一（getDay: 0=周日）
        var shift = (start.getDay() + 6) % 7;
        start = new Date(start.getTime() - shift * 86400000);

        var grid = el('div', 'heat-grid');
        var totalDays = 0, totalMsgs = 0, activeDays = 0;
        var legendText = '';
        for (var i = 0; ; i++) {
            var d = new Date(start.getTime() + i * 86400000);
            if (d > today) break;
            var key = fmtDay(d);
            var count = map[key] || 0;
            if (count > 0) { activeDays += 1; totalMsgs += count; }
            totalDays += 1;
            var cell = el('div', 'heat-cell');
            cell.title = key + ' · ' + count + ' 条';
            if (count >= 1) cell.classList.add('l1');
            if (count >= 3) { cell.classList.remove('l1'); cell.classList.add('l2'); }
            if (count >= 6) { cell.classList.remove('l2'); cell.classList.add('l3'); }
            if (count >= 12) { cell.classList.remove('l3'); cell.classList.add('l4'); }
            grid.appendChild(cell);
        }
        box.innerHTML = '';
        box.appendChild(grid);
        legendText = '<div class="heat-legend">' +
            '<span>' + fmtDay(start) + ' → ' + fmtDay(today) + '</span>' +
            '<span style="margin-left:auto">活跃 ' + activeDays + ' 天 / 共 ' + totalMsgs + ' 条</span>' +
            '<span>少</span><div class="heat-cell"></div><div class="heat-cell l1"></div>' +
            '<div class="heat-cell l2"></div><div class="heat-cell l3"></div><div class="heat-cell l4"></div><span>多</span>' +
            '</div>';
        box.insertAdjacentHTML('beforeend', legendText);
    }

    // ======================== 初始化 ========================
    function init() {
        var backup = $('backupBtn');
        if (backup) backup.addEventListener('click', downloadBackup);

        var file = $('importFile');
        if (file) file.addEventListener('change', function () {
            if (file.files && file.files[0]) handleFile(file.files[0]);
        });

        var cancel = $('importCancel');
        if (cancel) cancel.addEventListener('click', function () {
            resetImportPanel();
            var box = $('importResult');
            if (box) box.textContent = '';
        });

        var target = $('importTarget');
        if (target) target.addEventListener('change', function () {
            var newName = $('importNewName');
            if (newName) newName.hidden = target.value !== '__new__';
        });

        var modeSeg = $('importModeSeg');
        if (modeSeg) {
            modeSeg.addEventListener('click', function (e) {
                var b = e.target.closest('button[data-mode]');
                if (!b || b.disabled) return;
                importState.mode = b.dataset.mode;
                Array.prototype.forEach.call(modeSeg.querySelectorAll('button'), function (x) {
                    x.classList.toggle('active', x === b);
                });
            });
        }

        var dryBtn = $('importDryRun');
        if (dryBtn) dryBtn.addEventListener('click', function () { runImport(true); });
        var runBtn = $('importRun');
        if (runBtn) runBtn.addEventListener('click', function () { runImport(false); });

        var clearBtn = $('clearCacheBtn');
        if (clearBtn) clearBtn.addEventListener('click', async function () {
            var ok = true;
            if (typeof window.showConfirm === 'function') {
                ok = await window.showConfirm(
                    '清理本地聊天缓存与联系人缓存？（不会删除云端数据，也不会改动外观设置）',
                    '清理本地缓存', '清理', '取消'
                );
            }
            if (ok) clearLocalCaches();
        });

        var refresh = $('dataRefresh');
        if (refresh) refresh.addEventListener('click', function () {
            loadData();
            loadUsage();
        });

        loadData();
        loadUsage();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
