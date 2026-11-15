// static/js/modal.js
// ========================================
// 统一拟态框（替代 alert/confirm/prompt）
// 打开/关闭由 .modal.active 类驱动 CSS 过渡动画（见 theme.css 第十轮）
// ========================================

// ===== 全局模态框开关助手（供全站复用） =====
window.showModal = function (modal) {
    if (!modal) return;
    modal.classList.add('active');
};

window.hideModal = function (modal) {
    if (!modal) return;
    modal.classList.remove('active');
};

// ===== 模态框顶部头像预览（src 为空时显示默认图标；加载失败回退图标） =====
window.setModalAvatar = function (previewEl, src, fallbackIcon = 'fa-user') {
    if (!previewEl) return;
    const path = normalizeAvatarPath(src);
    if (!path) {
        previewEl.innerHTML = `<i class="fas ${fallbackIcon}"></i>`;
        return;
    }
    previewEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = path;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => {
        previewEl.innerHTML = `<i class="fas ${fallbackIcon}"></i>`;
    };
    previewEl.appendChild(img);
};

// 头像路径归一化：相对路径统一转为根路径（管理页在 /admin/ 下也能正确加载）
function normalizeAvatarPath(src) {
    if (!src) return '';
    const s = String(src).trim();
    if (!s) return '';
    if (/^(https?:)?\/\//i.test(s) || s.startsWith('/') || s.startsWith('data:')) return s;
    return '/' + s;
}

// 创建模态框 DOM
function createModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal';

    const container = document.createElement('div');
    container.className = 'modal-content';
    container.style.maxWidth = '420px';
    container.style.width = '90%';
    container.style.padding = '0';

    overlay.appendChild(container);
    document.body.appendChild(overlay);

    // 下一帧加 active，触发淡入 + 弹出动画
    requestAnimationFrame(() => overlay.classList.add('active'));
    return { overlay, container };
}

function closeModalElement(overlay) {
    if (!overlay) return;
    overlay.classList.remove('active');
    setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 280);
}

// ===== Alert =====
window.showAlert = function(message, title = '提示') {
    return new Promise((resolve) => {
        const { overlay, container } = createModal();

        container.innerHTML = `
            <div class="modal-header">
                <h2>${escapeHtml(title)}</h2>
                <button class="close-btn" id="alert-close">&times;</button>
            </div>
            <div class="modal-body">
                <p style="margin: 0; line-height: 1.6;">${escapeHtml(message)}</p>
                <div class="form-actions" style="margin-top: 20px;">
                    <button class="btn-accent block" id="alert-confirm">确定</button>
                </div>
            </div>
        `;

        const close = () => {
            closeModalElement(overlay);
            resolve(true);
        };

        container.querySelector('#alert-close').addEventListener('click', close);
        container.querySelector('#alert-confirm').addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
    });
};

// ===== Confirm =====
window.showConfirm = function(message, title = '确认', confirmText = '确定', cancelText = '取消') {
    return new Promise((resolve) => {
        const { overlay, container } = createModal();

        container.innerHTML = `
            <div class="modal-header">
                <h2>${escapeHtml(title)}</h2>
                <button class="close-btn" id="confirm-close">&times;</button>
            </div>
            <div class="modal-body">
                <p style="margin: 0; line-height: 1.6;">${escapeHtml(message)}</p>
                <div class="form-actions" style="margin-top: 20px;">
                    <button class="btn-secondary" id="confirm-cancel">${escapeHtml(cancelText)}</button>
                    <button class="btn-accent" id="confirm-ok">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        `;

        const close = (result) => {
            closeModalElement(overlay);
            resolve(result);
        };

        container.querySelector('#confirm-close').addEventListener('click', () => close(false));
        container.querySelector('#confirm-cancel').addEventListener('click', () => close(false));
        container.querySelector('#confirm-ok').addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
    });
};

// ===== Prompt =====
window.showPrompt = function(message, defaultValue = '', title = '输入') {
    return new Promise((resolve) => {
        const { overlay, container } = createModal();

        container.innerHTML = `
            <div class="modal-header">
                <h2>${escapeHtml(title)}</h2>
                <button class="close-btn" id="prompt-close">&times;</button>
            </div>
            <div class="modal-body">
                <p style="margin: 0 0 12px 0; line-height: 1.6;">${escapeHtml(message)}</p>
                <input type="text" id="prompt-input" value="${escapeHtml(defaultValue)}" style="width:100%; padding:10px 14px; background:var(--card-bg); border:1px solid var(--border-color); border-radius:20px; color:var(--text-primary); font-size:0.95rem; outline:none; box-sizing:border-box;">
                <div class="form-actions" style="margin-top: 16px;">
                    <button class="btn-secondary" id="prompt-cancel">取消</button>
                    <button class="btn-accent" id="prompt-ok">确定</button>
                </div>
            </div>
        `;

        const input = container.querySelector('#prompt-input');
        const close = (result) => {
            closeModalElement(overlay);
            resolve(result);
        };

        container.querySelector('#prompt-close').addEventListener('click', () => close(null));
        container.querySelector('#prompt-cancel').addEventListener('click', () => close(null));
        container.querySelector('#prompt-ok').addEventListener('click', () => close(input.value.trim()));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(null);
        });
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') close(input.value.trim());
        });

        setTimeout(() => input.focus(), 180);
    });
};

// ===== 工具函数 =====
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"]/g, function(m) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
        return map[m] || m;
    });
}

// ===== 全局替换（可选） =====
// 取消注释以下代码可全局替换原生 alert/confirm/prompt
// window.alert = window.showAlert;
// window.confirm = window.showConfirm;
// window.prompt = window.showPrompt;
