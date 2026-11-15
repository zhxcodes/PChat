// static/js/studio.js
// ============================================================
// 「外观与玩法中心」（/studio）页面逻辑
// ------------------------------------------------------------
// 分工：
//   enhance.js      → 能力（配色 / 氛围 / 背景 / 排版 / 动画 / 朗读 / 置顶 / 指令）
//   studio.js       → 本页外观类界面：色卡、背景、排版、动画、语音、置顶
//   studio-data.js  → 本页数据区：备份 / 导入 / 用量 / 洞察 / 热力图
// 所有偏好读写都在 enhance.js 里，页面只调用 API + 渲染，避免两处实现不一致。
// ============================================================
(function () {
    'use strict';

    var E = window.enhance;

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

    function fmtBytes(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
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
        }, 2400);
    }

    // ======================== 主题 ========================
    function effectiveTheme() {
        var mode = localStorage.getItem('theme') || 'light';
        if (mode === 'system') {
            try {
                return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            } catch (e) {
                return 'light';
            }
        }
        return mode === 'dark' ? 'dark' : 'light';
    }

    function applyTheme(mode) {
        var html = document.documentElement;
        if (mode === 'system') html.removeAttribute('data-theme');
        else html.setAttribute('data-theme', mode);
        try { localStorage.setItem('theme', mode); } catch (e) {}
        syncThemeSeg(mode);
        syncAccentThemeAttr();
        html.classList.add('theme-transition');
        setTimeout(function () { html.classList.remove('theme-transition'); }, 450);
    }

    function syncThemeSeg(mode) {
        var seg = $('themeSeg');
        if (!seg) return;
        Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
            b.classList.toggle('active', b.dataset.mode === mode);
        });
    }

    // 色卡需要同时带 data-theme，才能显示暗色版色值
    function syncAccentThemeAttr() {
        var theme = effectiveTheme();
        ['accentGrid', 'sceneGrid'].forEach(function (id) {
            var grid = $(id);
            if (!grid) return;
            Array.prototype.forEach.call(grid.querySelectorAll('.accent-tile'), function (tile) {
                tile.setAttribute('data-theme', theme);
            });
        });
        requestAnimationFrame(updateContrastBadges);
    }

    // ======================== 对比度计算（WCAG 2.1） ========================
    function srgb(c) {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    function luminance(rgb) {
        return 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]);
    }
    function ratio(a, b) {
        var la = luminance(a), lb = luminance(b);
        var hi = Math.max(la, lb), lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    var colorProbe = null;
    function toRGB(color) {
        if (!color) return null;
        if (!colorProbe) {
            colorProbe = document.createElement('span');
            colorProbe.style.display = 'none';
            document.body.appendChild(colorProbe);
        }
        colorProbe.style.color = '';
        colorProbe.style.color = color;
        var computed = getComputedStyle(colorProbe).color;
        var m = computed.match(/-?\d+(\.\d+)?/g);
        if (!m || m.length < 3) return null;
        return [Number(m[0]), Number(m[1]), Number(m[2])];
    }

    function firstColor(value) {
        if (!value) return '';
        var s = String(value).trim();
        var m = s.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/);
        return m ? m[0] : s;
    }

    function cssVar(node, name) {
        return getComputedStyle(node).getPropertyValue(name).trim();
    }

    function updateContrastBadges() {
        var grid = $('accentGrid');
        if (!grid) return;
        Array.prototype.forEach.call(grid.querySelectorAll('.accent-tile'), function (tile) {
            var badge = tile.querySelector('.tile-ratio');
            if (!badge) return;
            try {
                var bubbleBg = toRGB(firstColor(cssVar(tile, '--bubble-sent')));
                var bubbleText = toRGB(cssVar(tile, '--bubble-sent-text'));
                var btnBg = toRGB(firstColor(cssVar(tile, '--primary-gradient')));
                var btnText = toRGB(cssVar(tile, '--accent-text'));
                var r1 = bubbleBg && bubbleText ? ratio(bubbleBg, bubbleText) : 0;
                var r2 = btnBg && btnText ? ratio(btnBg, btnText) : 0;
                var bad = r1 < 4.5 || r2 < 4.5;
                badge.classList.toggle('bad', bad);
                badge.textContent = '气泡 ' + r1.toFixed(1) + ' / 按钮 ' + r2.toFixed(1);
                badge.title = 'WCAG 对比度：气泡 ' + r1.toFixed(2) + ':1，按钮 ' + r2.toFixed(2) + ':1'
                    + (bad ? '（低于 4.5:1）' : '（已达 AA）');
            } catch (e) {
                badge.textContent = '';
            }
        });
    }

    // ======================== 配色卡片 ========================
    function buildAccentGrid() {
        var grid = $('accentGrid');
        if (!grid || !E) return;
        grid.innerHTML = '';
        E.ACCENTS.forEach(function (a) {
            var tile = el('button', 'accent-tile');
            tile.type = 'button';
            tile.dataset.accent = a.id;
            tile.dataset.theme = effectiveTheme();
            tile.setAttribute('aria-label', a.label + '配色');
            tile.innerHTML =
                '<span class="tile-head"><span class="tile-name">' + esc(a.label) + '</span>' +
                '<span class="tile-check">✓ 使用中</span></span>' +
                '<span class="tile-bubble">今晚的雨，像有人在窗外敲</span>' +
                '<span class="tile-bottom"><span class="tile-btn">发送</span>' +
                '<span class="tile-ratio">—</span></span>';
            tile.addEventListener('click', function () {
                E.setAccent(a.id);
                toast('已切换为「' + a.label + '」配色', 'success');
            });
            grid.appendChild(tile);
        });
        requestAnimationFrame(function () {
            updateContrastBadges();
            refreshUI();
        });
    }

    // ======================== 聊天背景 ========================
    function buildBackgroundGrid() {
        var grid = $('bgGrid');
        if (!grid || !E) return;
        grid.innerHTML = '';
        // 「无」+ 内置纹理
        var none = el('button', 'choice-tile');
        none.type = 'button';
        none.dataset.bg = 'none';
        none.innerHTML =
            '<span class="choice-icon"><i class="fas fa-ban"></i></span>' +
            '<span class="choice-name">无背景</span>' +
            '<span class="choice-desc">回到纯色聊天区</span>';
        none.addEventListener('click', async function () {
            try {
                await E.clearBackground();
                toast('已关闭背景', 'success');
                refreshBackground();
            } catch (e) { toast('取消失败：' + e.message, 'error'); }
        });
        grid.appendChild(none);

        E.BG_PATTERNS.forEach(function (p) {
            var tile = el('button', 'choice-tile bg-tile');
            tile.type = 'button';
            tile.dataset.bg = 'pattern:' + p.id;
            tile.innerHTML =
                '<span class="bg-thumb" style="background-image:' + p.css + '"></span>' +
                '<span class="choice-name">' + esc(p.label) + '</span>';
            tile.addEventListener('click', async function () {
                try {
                    await E.setBackgroundPattern(p.id);
                    toast('背景：' + p.label, 'success');
                    refreshBackground();
                } catch (e) { toast('设置失败：' + e.message, 'error'); }
            });
            grid.appendChild(tile);
        });
    }

    function refreshBackground() {
        if (!E) return;
        var info = E.getBackgroundInfo ? E.getBackgroundInfo() : { label: '无', blur: 0, dim: 18, bytes: 0 };
        var st = E.getState();

        var grid = $('bgGrid');
        if (grid) {
            Array.prototype.forEach.call(grid.querySelectorAll('[data-bg]'), function (t) {
                t.classList.toggle('active', st.bgKind === t.dataset.bg ||
                    (t.dataset.bg === 'none' && st.bgKind === 'none'));
            });
        }
        var cur = $('bgCurrent');
        if (cur) cur.textContent = info.label;
        var blur = $('bgBlur');
        if (blur) blur.value = String(info.blur);
        var blurV = $('bgBlurValue');
        if (blurV) blurV.textContent = info.blur + 'px';
        var dim = $('bgDim');
        if (dim) dim.value = String(info.dim);
        var dimV = $('bgDimValue');
        if (dimV) dimV.textContent = info.dim + '%';
        var url = $('bgUrl');
        if (url && document.activeElement !== url) url.value = info.url || '';
        var status = $('bgStatus');
        if (status) {
            var parts = ['当前：' + info.label];
            if (info.kind === 'custom') parts.push('图片 ' + fmtBytes(info.originalBytes) + ' → 存储 ' + fmtBytes(info.bytes));
            if (info.kind === 'url') parts.push(info.url);
            if (!info.blurSupported) parts.push('当前浏览器不支持画布模糊，已忽略模糊设置');
            status.textContent = parts.join(' · ');
        }
    }

    // ======================== 选项行 ========================
    function buildSeg(containerId, items, dataKey, onPick) {
        var seg = $(containerId);
        if (!seg) return;
        seg.innerHTML = '';
        items.forEach(function (it) {
            var b = el('button', null, esc(it.label));
            b.type = 'button';
            b.dataset[dataKey] = it.id;
            b.addEventListener('click', function () { onPick(it.id); });
            seg.appendChild(b);
        });
    }

    // ======================== 氛围 ========================
    function buildAmbienceGrid() {
        var grid = $('ambienceGrid');
        if (!grid || !E) return;
        var desc = {
            off: '关闭所有装饰',
            sakura: '38 片花瓣，正弦漂移 + 自转',
            stars: '64 颗呼吸星点，偶尔划过流星',
            rain: '90 条雨丝斜落，颜色取自主题',
            snow: '52 片雪花缓慢下落'
        };
        grid.innerHTML = '';
        E.AMBIENCES.forEach(function (a) {
            var tile = el('button', 'choice-tile');
            tile.type = 'button';
            tile.dataset.ambience = a.id;
            tile.innerHTML =
                '<span class="choice-icon"><i class="fas ' + a.icon + '"></i></span>' +
                '<span class="choice-name">' + esc(a.label) + '</span>' +
                '<span class="choice-desc">' + esc(desc[a.id] || '') + '</span>';
            tile.addEventListener('click', function () {
                E.setAmbience(a.id);
                var st = E.getState();
                if (st.perf && a.id !== 'off') {
                    toast('性能模式已开启，动画装饰暂不播放', 'info');
                } else if (a.id !== 'off' && st.ambience !== a.id) {
                    toast('系统已开启「减少动态效果」，氛围未启用', 'info');
                } else {
                    toast('氛围：' + a.label, 'success');
                }
            });
            grid.appendChild(tile);
        });
    }

    // ======================== 场景预设（0.13.0） ========================
    function sceneMatches(scene, st) {
        return scene.accent === st.accent &&
            scene.ambience === st.ambience &&
            scene.bubble === st.bubble &&
            scene.font === st.font &&
            scene.density === st.density &&
            scene.anim === st.anim &&
            String(scene.bg || 'none') === String(st.bgKind || 'none');
    }

    function buildSceneGrid() {
        var grid = $('sceneGrid');
        if (!grid || !E) return;
        grid.innerHTML = '';
        var st = E.getState();
        var scenes = E.getScenes();

        scenes.forEach(function (scene) {
            var wrap = el('div', 'scene-wrap');
            var tile = el('button', 'accent-tile scene-tile');
            tile.type = 'button';
            tile.dataset.accent = scene.accent || 'graphite';
            tile.dataset.theme = scene.theme || 'light';
            tile.dataset.scene = scene.id;
            var ambLabel = (E.AMBIENCES.filter(function (a) { return a.id === scene.ambience; })[0] || {}).label || '';
            var bgLabel = String(scene.bg || 'none').indexOf('pattern:') === 0 ? '背景' : '';
            tile.innerHTML =
                '<span class="tile-head"><span class="tile-name"><i class="fas ' + (scene.icon || 'fa-star') + '"></i> ' +
                esc(scene.name) + '</span>' +
                '<span class="tile-check">✓ 使用中</span></span>' +
                '<span class="tile-bubble">今晚的雨，像有人在窗外敲</span>' +
                '<span class="tile-bottom"><span class="tile-btn">发送</span>' +
                '<span class="tile-ratio">' + esc([ambLabel, bgLabel].filter(Boolean).join(' · ') || '无氛围') + '</span></span>';
            if (sceneMatches(scene, st)) tile.classList.add('active');
            tile.addEventListener('click', async function () {
                try {
                    await E.applyScene(scene.id);
                    toast('已应用场景「' + scene.name + '」', 'success');
                    refreshBackground();
                } catch (e) {
                    toast('应用失败：' + e.message, 'error');
                }
                buildSceneGrid();
                refreshUI();
                syncThemeSeg(localStorage.getItem('theme') || 'light');
            });
            wrap.appendChild(tile);

            if (scene.user) {
                var del = el('button', 'scene-del', '&times;');
                del.type = 'button';
                del.title = '删除这个预设';
                del.addEventListener('click', function (e) {
                    e.stopPropagation();
                    e.preventDefault();
                    try {
                        E.deleteScene(scene.id);
                        toast('已删除预设「' + scene.name + '」', 'success');
                        buildSceneGrid();
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
                wrap.appendChild(del);
            }
            grid.appendChild(wrap);
        });
    }

    function initScenes() {
        buildSceneGrid();

        var saveBtn = $('sceneSave');
        if (saveBtn) {
            saveBtn.addEventListener('click', async function () {
                var name = '我的场景';
                if (typeof showPrompt === 'function') {
                    name = await showPrompt('给这套外观起个名字（最多 24 字）', '我的场景', '保存场景');
                }
                if (!name) return;
                try {
                    var scene = E.saveScene(name);
                    toast('已保存「' + scene.name + '」', 'success');
                    buildSceneGrid();
                } catch (e) {
                    toast(e.message, 'error');
                }
            });
        }

        var clearBtn = $('sceneClear');
        if (clearBtn) {
            clearBtn.addEventListener('click', async function () {
                var list = E.getScenes().filter(function (s) { return s.user; });
                if (!list.length) { toast('还没有自定义预设', 'info'); return; }
                var ok = true;
                if (typeof showConfirm === 'function') {
                    ok = await showConfirm('删除全部 ' + list.length + ' 个自定义预设？（内置 4 套不受影响）', '清空自定义预设', '清空', '取消');
                }
                if (!ok) return;
                list.forEach(function (s) {
                    try { E.deleteScene(s.id); } catch (e) {}
                });
                buildSceneGrid();
                toast('已清空自定义预设', 'success');
            });
        }
    }

    // ======================== 语音 ========================
    function syncVoice() {
        if (!E) return;
        var st = E.getState();
        var auto = $('ttsAuto');
        if (auto) auto.checked = !!st.ttsAuto;
        var rate = $('ttsRate');
        if (rate) rate.value = String(st.ttsRate);
        var rv = $('ttsRateValue');
        if (rv) rv.textContent = Number(st.ttsRate).toFixed(1) + 'x';
        var info = E.getVoiceInfo ? E.getVoiceInfo() : { supported: false };
        var status = $('ttsStatus');
        if (!status) return;
        if (!info.supported) {
            status.innerHTML = '<b>当前浏览器不支持语音朗读</b>，建议使用 Chrome / Edge / Safari。';
        } else if (!info.total) {
            status.innerHTML = '浏览器支持朗读，但<b>还没有加载到语音</b>（系统可能未安装语音包）。';
        } else {
            status.innerHTML = '检测到 <b>' + info.total + '</b> 个语音，其中中文 <b>' + info.chinese + '</b> 个'
                + (info.current ? ' · 当前使用：' + esc(info.current) : '');
        }
    }

    // ======================== 置顶 ========================
    async function loadPins() {
        var box = $('pinList');
        if (!box) return;
        var token = sessionStorage.getItem('token');
        if (!token) {
            box.innerHTML = '<div class="studio-hint">未登录，无法读取联系人列表。先 <a href="/">回到聊天页登录</a>。</div>';
            return;
        }
        box.innerHTML = '<div class="studio-hint">加载中…</div>';
        try {
            var res = await fetch('/api/contacts', { headers: { Authorization: 'Bearer ' + token } });
            if (!res.ok) throw new Error(res.status === 401 ? '登录已过期' : 'HTTP ' + res.status);
            var list = await res.json();
            renderPins(Array.isArray(list) ? list : []);
        } catch (e) {
            box.innerHTML = '<div class="studio-hint">读取联系人失败：' + esc(e.message)
                + '。<a href="/">回到聊天页</a> 重新登录后再来。</div>';
        }
    }

    function renderPins(list) {
        var box = $('pinList');
        if (!box) return;
        if (!list.length) {
            box.innerHTML = '<div class="studio-hint">还没有联系人。</div>';
            return;
        }
        box.innerHTML = '';
        list.forEach(function (c) {
            var pinned = E && E.isPinned(c.contact_id);
            var row = el('div', 'pin-row' + (pinned ? ' pinned' : ''));
            var icon = c.contact_type === 'ai' ? 'fa-robot' : 'fa-user';
            var avatar = c.avatar
                ? '<img src="' + esc(c.avatar) + '" alt="">'
                : '<i class="fas ' + icon + '"></i>';
            row.innerHTML =
                '<span class="pin-avatar">' + avatar + '</span>' +
                '<span class="pin-name">' + esc(c.display_name) + '</span>' +
                '<span class="pin-type">' + (c.contact_type === 'ai' ? 'AI' : '用户') + '</span>';
            var btn = el('button', 'pin-toggle', pinned ? '已置顶' : '置顶');
            btn.type = 'button';
            btn.addEventListener('click', function () {
                var nowPinned = E.togglePin(c.contact_id);
                toast(nowPinned ? '已置顶「' + c.display_name + '」' : '已取消置顶', 'success');
                renderPins(list);
            });
            row.appendChild(btn);
            box.appendChild(row);
        });
    }

    // ======================== 更新日志 ========================
    async function openChangelog() {
        if (typeof createModal !== 'function') { window.open('/CHANGELOG.md', '_blank'); return; }
        var m = createModal();
        m.container.style.maxWidth = '660px';
        m.container.style.width = '92%';
        m.container.innerHTML =
            '<div class="modal-header"><h2><i class="fas fa-book"></i> 更新日志</h2>' +
            '<button type="button" class="close-btn" data-close>&times;</button></div>' +
            '<div class="modal-body"><div class="studio-changelog"><i class="fas fa-spinner fa-spin"></i> 加载中…</div></div>';
        m.container.querySelector('[data-close]').addEventListener('click', function () {
            closeModalElement(m.overlay);
        });
        var content = m.container.querySelector('.studio-changelog');
        try {
            var res = await fetch('/CHANGELOG.md', { cache: 'no-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var md = await res.text();
            var html = (window.marked && marked.parse) ? marked.parse(md) : '<pre>' + esc(md) + '</pre>';
            if (window.DOMPurify) html = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
            content.innerHTML = html;
        } catch (e) {
            content.innerHTML = '<div class="studio-hint">暂无更新日志</div>';
        }
    }

    // ======================== 界面状态同步 ========================
    function labelOf(list, id, fallback) {
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
        return fallback;
    }

    function syncSeg(containerId, dataKey, activeId) {
        var seg = $(containerId);
        if (!seg) return;
        Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
            b.classList.toggle('active', b.dataset[dataKey] === String(activeId));
        });
    }

    function refreshUI() {
        if (!E) return;
        var st = E.getState();

        // 配色
        var grid = $('accentGrid');
        if (grid) {
            Array.prototype.forEach.call(grid.querySelectorAll('.accent-tile'), function (t) {
                t.classList.toggle('active', t.dataset.accent === st.accent);
            });
        }
        var cur = $('accentCurrent');
        if (cur) cur.textContent = labelOf(E.ACCENTS, st.accent, '石墨');

        // 氛围
        var amb = $('ambienceGrid');
        if (amb) {
            Array.prototype.forEach.call(amb.querySelectorAll('.choice-tile'), function (t) {
                t.classList.toggle('active', t.dataset.ambience === st.ambience);
            });
        }

        // 字号 / 密度
        syncSeg('fontSeg', 'fontsize', st.font);
        syncSeg('densitySeg', 'density', st.density);
        var fl = $('fontCurrent');
        if (fl) fl.textContent = labelOf(E.FONT_SIZES, st.font, '标准');
        var dl = $('densityCurrent');
        if (dl) dl.textContent = labelOf(E.DENSITIES, st.density, '舒适');

        // 排版
        syncSeg('bubbleSeg', 'bubble', st.bubble);
        syncSeg('maxwSeg', 'maxw', st.maxw);
        syncSeg('avatarSeg', 'avatar', st.avatar);
        syncSeg('timeSeg', 'time', st.time);
        var bl = $('bubbleCurrent');
        if (bl) bl.textContent = labelOf(E.BUBBLE_STYLES, st.bubble, '微信式');
        var ml = $('maxwCurrent');
        if (ml) ml.textContent = labelOf(E.MAX_WIDTHS, st.maxw, '全宽');
        var al = $('avatarCurrent');
        if (al) al.textContent = labelOf(E.AVATAR_SIZES, st.avatar, '中 38');
        var tl = $('timeCurrent');
        if (tl) tl.textContent = labelOf(E.TIME_STYLES, st.time, '完整日期');

        // 动画 / 性能
        syncSeg('animSeg', 'anim', st.anim);
        var anl = $('animCurrent');
        if (anl) anl.textContent = labelOf(E.ANIM_STYLES, st.anim, '默认');
        var perf = $('perfMode');
        if (perf) perf.checked = !!st.perf;

        // 背景
        refreshBackground();

        // 状态行
        var line = $('studioStateLine');
        if (line) {
            var parts = [
                labelOf(E.ACCENTS, st.accent, '石墨'),
                st.ambience === 'off' ? '无氛围' : labelOf(E.AMBIENCES, st.ambience, '氛围'),
                labelOf(E.FONT_SIZES, st.font, '标准') + '字号',
                labelOf(E.DENSITIES, st.density, '舒适'),
            ];
            var bg = E.getBackgroundInfo ? E.getBackgroundInfo() : null;
            if (bg && bg.kind !== 'none') parts.push(bg.label);
            if (st.perf) parts.push('性能模式');
            line.textContent = parts.join(' · ');
        }
    }

    // ======================== 初始化 ========================
    function init() {
        Array.prototype.forEach.call(document.querySelectorAll('[data-app-version]'), function (n) {
            n.textContent = 'v' + (window.APP_VERSION || '0.14.4');
        });

        if (!E) {
            toast('外观模块未加载，请刷新页面', 'error');
            return;
        }

        var st = E.getState();

        // 主题
        syncThemeSeg(localStorage.getItem('theme') || 'light');
        var seg = $('themeSeg');
        if (seg) {
            seg.addEventListener('click', function (e) {
                var b = e.target.closest('button[data-mode]');
                if (!b) return;
                applyTheme(b.dataset.mode);
                toast('主题：' + b.textContent, 'success');
            });
        }

        buildAccentGrid();
        buildBackgroundGrid();
        buildAmbienceGrid();
        initScenes();

        // 阅读舒适度
        buildSeg('fontSeg', E.FONT_SIZES, 'fontsize', function (id) { E.setFontSize(id); });
        buildSeg('densitySeg', E.DENSITIES, 'density', function (id) { E.setDensity(id); });

        // 排版
        buildSeg('bubbleSeg', E.BUBBLE_STYLES, 'bubble', function (id) { E.setBubbleStyle(id); });
        buildSeg('maxwSeg', E.MAX_WIDTHS, 'maxw', function (id) { E.setMaxWidth(id); });
        buildSeg('avatarSeg', E.AVATAR_SIZES, 'avatar', function (id) { E.setAvatarSize(id); });
        buildSeg('timeSeg', E.TIME_STYLES, 'time', function (id) {
            E.setTimeStyle(id);
            toast('时间标签已切换（聊天页会重新渲染一次）', 'success');
        });

        // 动画 / 性能
        buildSeg('animSeg', E.ANIM_STYLES, 'anim', function (id) { E.setAnimation(id); });
        var perf = $('perfMode');
        if (perf) {
            perf.checked = !!st.perf;
            perf.addEventListener('change', function () {
                E.setPerformanceMode(perf.checked);
                toast(perf.checked ? '已开启性能模式（动画与粒子关闭）' : '已关闭性能模式', 'success');
            });
        }

        // 背景：上传 / URL / 模糊 / 遮罩
        var file = $('bgFile');
        if (file) {
            file.addEventListener('change', async function () {
                if (!file.files || !file.files[0]) return;
                var status = $('bgStatus');
                if (status) status.textContent = '正在处理图片…';
                try {
                    var info = await E.setBackgroundFile(file.files[0]);
                    toast('背景已设置（' + fmtBytes(info.originalBytes) + ' → ' + fmtBytes(info.bytes) + '）', 'success');
                } catch (e) {
                    toast('设置背景失败：' + e.message, 'error');
                }
                file.value = '';
                refreshBackground();
            });
        }
        var clear = $('bgClear');
        if (clear) {
            clear.addEventListener('click', async function () {
                try {
                    await E.clearBackground();
                    toast('已清除背景', 'success');
                } catch (e) { toast('清除失败：' + e.message, 'error'); }
                refreshBackground();
            });
        }
        var urlApply = $('bgUrlApply');
        if (urlApply) {
            urlApply.addEventListener('click', async function () {
                var input = $('bgUrl');
                try {
                    await E.setBackgroundUrl(input ? input.value : '');
                    toast('背景已使用该链接', 'success');
                } catch (e) {
                    toast(e.message, 'error');
                }
                refreshBackground();
            });
        }
        var blur = $('bgBlur');
        if (blur) {
            blur.addEventListener('input', function () {
                var v = $('bgBlurValue');
                if (v) v.textContent = blur.value + 'px';
            });
            blur.addEventListener('change', async function () {
                await E.setBackgroundTuning(blur.value, undefined);
                refreshBackground();
            });
        }
        var dim = $('bgDim');
        if (dim) {
            dim.addEventListener('input', function () {
                var v = $('bgDimValue');
                if (v) v.textContent = dim.value + '%';
            });
            dim.addEventListener('change', async function () {
                await E.setBackgroundTuning(undefined, dim.value);
                refreshBackground();
            });
        }

        // 语音
        var auto = $('ttsAuto');
        if (auto) {
            auto.checked = !!st.ttsAuto;
            auto.addEventListener('change', function () {
                var want = !!auto.checked;
                var on = !!E.setTtsAuto(want);
                auto.checked = on;
                if (on !== want) toast('当前浏览器不支持语音朗读', 'error');
                else toast(on ? '已开启自动朗读' : '已关闭自动朗读', 'success');
                syncVoice();
            });
        }
        var rate = $('ttsRate');
        if (rate) {
            rate.value = String(st.ttsRate);
            rate.addEventListener('input', function () {
                var v = E.setTtsRate(rate.value);
                var rv = $('ttsRateValue');
                if (rv) rv.textContent = Number(v).toFixed(1) + 'x';
            });
        }
        var ttsTest = $('ttsTest');
        if (ttsTest) {
            ttsTest.addEventListener('click', function () {
                E.speak('你好，我是你的 AI 伙伴。这是一段语音朗读的试听。');
                setTimeout(syncVoice, 300);
            });
        }
        var ttsStop = $('ttsStop');
        if (ttsStop) ttsStop.addEventListener('click', function () { E.stopSpeaking(); });
        var trySpeech = $('studioTrySpeech');
        if (trySpeech) {
            trySpeech.addEventListener('click', function () {
                E.speak('今晚的雨，听起来像有人在窗外轻轻敲。你听。');
                setTimeout(syncVoice, 300);
            });
        }
        if (window.speechSynthesis) {
            window.speechSynthesis.onvoiceschanged = function () { syncVoice(); };
        }
        syncVoice();

        // 置顶
        loadPins();

        // 关于
        var cl = $('openChangelogBtn');
        if (cl) cl.addEventListener('click', openChangelog);
        var reset = $('resetPrefs');
        if (reset) {
            reset.addEventListener('click', async function () {
                var ok = true;
                if (typeof showConfirm === 'function') {
                    ok = await showConfirm('把所有外观设置恢复为默认（配色 / 背景 / 排版 / 动画 / 朗读）？本地缓存与云端数据不受影响。', '恢复默认', '恢复', '取消');
                }
                if (!ok) return;
                E.resetPreferences();
                applyTheme('light');
                refreshUI();
                toast('已恢复默认外观', 'success');
            });
        }

        // 指令表格：点代码即复制
        Array.prototype.forEach.call(document.querySelectorAll('.studio-table code'), function (code) {
            code.style.cursor = 'pointer';
            code.title = '点击复制';
            code.addEventListener('click', function () {
                var text = code.textContent;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(function () { toast('已复制：' + text, 'success'); },
                        function () { toast('复制失败，请手动选择', 'error'); });
                }
            });
        });

        // 分区导航高亮
        var links = Array.prototype.slice.call(document.querySelectorAll('#studioNav a'));
        var cards = links.map(function (a) { return document.querySelector(a.getAttribute('href')); });
        var ticking = false;
        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(function () {
                ticking = false;
                var y = window.scrollY + 120;
                var idx = 0;
                for (var i = 0; i < cards.length; i++) {
                    if (!cards[i]) continue;
                    var top = cards[i].getBoundingClientRect().top + window.scrollY;
                    if (top <= y) idx = i;
                }
                links.forEach(function (a, i) { a.classList.toggle('active', i === idx); });
            });
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();

        // 系统主题变化时刷新色卡（system 模式）
        try {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
                if ((localStorage.getItem('theme') || 'light') === 'system') syncAccentThemeAttr();
            });
        } catch (e) {}

        // 任何偏好变化都同步界面（含恢复默认、其它标签页）
        document.addEventListener('enhance:change', function () {
            refreshUI();
            syncVoice();
            buildSceneGrid();
        });

        refreshUI();
        syncAccentThemeAttr();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
