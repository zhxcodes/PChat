// static/js/export.js
// 对话导出弹窗（第 26 项）——自包含实现，聊天页与管理后台共用
// 用法：window.openExportDialog(contactId, displayName)
// 后端：GET /api/ai/export?contact=xxx&format=json|md|txt[&start&end]

(function () {
    function buildDialog() {
        let overlay = document.getElementById('export-modal');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'export-modal';
        overlay.className = 'modal';
        overlay.innerHTML =
            '<div class="modal-content export-modal-content">' +
            '  <div class="modal-header">' +
            '    <h2><i class="fas fa-file-export"></i> 导出对话</h2>' +
            '    <button class="close-btn" data-ex-close>&times;</button>' +
            '  </div>' +
            '  <div class="modal-body">' +
            '    <p class="settings-hint" data-ex-title>选择导出格式与时间范围（可留空导出全部）</p>' +
            '    <div class="form-group">' +
            '      <label>导出格式</label>' +
            '      <div class="settings-options" data-ex-formats>' +
            '        <button type="button" class="settings-option-btn" data-fmt="txt">纯文本 .txt</button>' +
            '        <button type="button" class="settings-option-btn" data-fmt="md">Markdown .md</button>' +
            '        <button type="button" class="settings-option-btn" data-fmt="json">JSON .json</button>' +
            '      </div>' +
            '    </div>' +
            '    <div class="form-row" style="display:flex;gap:12px;">' +
            '      <div class="form-group" style="flex:1;">' +
            '        <label>开始日期（可选）</label>' +
            '        <input type="date" data-ex-start>' +
            '      </div>' +
            '      <div class="form-group" style="flex:1;">' +
            '        <label>结束日期（可选）</label>' +
            '        <input type="date" data-ex-end>' +
            '      </div>' +
            '    </div>' +
            '    <div class="form-actions">' +
            '      <button class="btn-secondary" data-ex-close>取消</button>' +
            '      <button class="btn-accent" data-ex-ok><i class="fas fa-download"></i> 导出下载</button>' +
            '    </div>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(overlay);
        return overlay;
    }

    function show(overlay) {
        if (typeof window.showModal === 'function') window.showModal(overlay);
        else overlay.classList.add('active');
    }

    function hide(overlay) {
        if (typeof window.hideModal === 'function') window.hideModal(overlay);
        else overlay.classList.remove('active');
    }

    window.openExportDialog = function (contactId, displayName) {
        if (!contactId) return;
        const overlay = buildDialog();
        let format = 'txt';

        const title = overlay.querySelector('[data-ex-title]');
        if (title) title.textContent = `导出「${displayName || contactId}」的对话（按时间范围过滤，可留空导出全部）`;

        overlay.querySelectorAll('[data-fmt]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.fmt === format);
            btn.onclick = () => {
                format = btn.dataset.fmt;
                overlay.querySelectorAll('[data-fmt]').forEach(b => b.classList.toggle('active', b === btn));
            };
        });

        const startEl = overlay.querySelector('[data-ex-start]');
        const endEl = overlay.querySelector('[data-ex-end]');
        if (startEl) startEl.value = '';
        if (endEl) endEl.value = '';

        overlay.querySelectorAll('[data-ex-close]').forEach(b => {
            b.onclick = () => hide(overlay);
        });
        overlay.onclick = (e) => { if (e.target === overlay) hide(overlay); };

        const okBtn = overlay.querySelector('[data-ex-ok]');
        okBtn.onclick = () => {
            const params = new URLSearchParams({ contact: contactId, format });
            const s = startEl && startEl.value ? startEl.value : '';
            const e = endEl && endEl.value ? endEl.value : '';
            // 结束日期含当天：补到 23:59:59
            if (s) params.set('start', `${s}T00:00:00`);
            if (e) params.set('end', `${e}T23:59:59`);
            const token = (typeof getAuthToken === 'function') ? getAuthToken() : sessionStorage.getItem('token');
            // 下载需要带 Authorization，用 fetch + blob 触发下载
            fetch(`/api/ai/export?${params.toString()}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            }).then(async (res) => {
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || '导出失败');
                }
                const blob = await res.blob();
                const cd = res.headers.get('Content-Disposition') || '';
                // 优先 RFC 5987 的 filename*（UTF-8 百分号编码，中文名不乱码），回退 ASCII 安全名 filename
                const mStar = cd.match(/filename\*=UTF-8''([^;]+)/i);
                const mPlain = cd.match(/filename="?([^";]+)"?/i);
                let name = mPlain ? mPlain[1] : `export.${format}`;
                if (mStar) {
                    try { name = decodeURIComponent(mStar[1].trim()); } catch (e) { /* 非法编码则沿用 filename */ }
                }
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 3000);
                hide(overlay);
                if (typeof window.showToast === 'function') window.showToast('导出已开始下载 ✅', 'success');
            }).catch((err) => {
                if (typeof window.showToast === 'function') window.showToast('导出失败: ' + err.message, 'error');
                else alert('导出失败: ' + err.message);
            });
        };

        show(overlay);
    };
})();
