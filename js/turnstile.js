(function () {
    const widgets = {}; // containerId -> widgetId

    function siteKey() {
        const m = document.querySelector('meta[name="turnstile-site-key"]');
        return ((m && m.getAttribute('content')) || '').trim();
    }

    window.turnstileEnabled = function () {
        return !!siteKey();
    };

    function ensureScript(cb) {
        if (window.turnstile && typeof window.turnstile.render === 'function') { cb(); return; }
        const existing = document.getElementById('cf-turnstile-script');
        if (existing) {
            existing.addEventListener('load', cb, { once: true });
            return;
        }
        const s = document.createElement('script');
        s.id = 'cf-turnstile-script';
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.defer = true;
        s.onload = cb;
        document.head.appendChild(s);
    }

    window.renderTurnstile = function (containerId) {
        const key = siteKey();
        if (!key) return;
        ensureScript(() => {
            const el = document.getElementById(containerId);
            if (!el || !window.turnstile || typeof window.turnstile.render !== 'function') return;
            if (widgets[containerId] !== undefined) return;
            try {
                widgets[containerId] = window.turnstile.render(el, {
                    sitekey: key,
                    theme: 'auto',
                    size: 'flexible',
                });
            } catch (e) {
                console.warn('Turnstile 渲染失败（忽略）:', e);
            }
        });
    };

    window.getTurnstileToken = function (containerId) {
        if (!siteKey() || !window.turnstile || widgets[containerId] === undefined) return '';
        try {
            return window.turnstile.getResponse(widgets[containerId]) || '';
        } catch (e) {
            return '';
        }
    };

    window.resetTurnstile = function (containerId) {
        if (!window.turnstile || widgets[containerId] === undefined) return;
        try {
            window.turnstile.reset(widgets[containerId]);
        } catch (e) { /* 忽略 */ }
    };
})();
