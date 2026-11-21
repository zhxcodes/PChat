// static/js/enhance.js
// ============================================================
// PChat 0.10.0「灵动增强包」——纯增量模块
// ------------------------------------------------------------
// 包含：
//   1. 6 套主题配色（覆盖 CSS 变量，不改动 theme.css）
//   2. 4 种氛围粒子（樱花 / 星尘 / 细雨 / 飘雪）+ 双击撒花
//   3. 命令面板（Ctrl+Shift+P / 标题栏 ✨）
//   4. 阅读舒适度（字号 4 档 + 密度 3 档）
//   5. 语音朗读（双击 AI 气泡 / 右键菜单 / 自动朗读 / 语速）
//   6. 会话洞察（/api/insights 数据面板）
//   7. 联系人置顶（悬停图钉）
//   8. /me 动作气泡 + 本地彩蛋指令 /roll /coin /pick /time /help
//
// 设计原则：
//   - 不改动 theme.css、app.js 的既有逻辑，只在其后追加；
//   - 对 app.js 的 4 处侵入点全部用「函数包装」或「单行钩子」实现，
//     任何一处失效都不影响原界面（模块整体失败也只是功能不出现）；
//   - 所有偏好存 localStorage，键名统一 enh_ 前缀。
//
// 加载顺序：index.html 中位于 app.js 之后（需要 app.js 的全局函数）。
// ============================================================
(function () {
    'use strict';

    // ======================== 偏好读写 ========================
    var KEYS = {
        accent: 'enh_accent',
        ambience: 'enh_ambience',
        font: 'enh_fontsize',
        density: 'enh_density',
        ttsAuto: 'enh_tts_auto',
        ttsRate: 'enh_tts_rate',
        pins: 'enh_pins',
        // 0.12.0
        bgKind: 'enh_bg_kind',
        bgUrl: 'enh_bg_url',
        bgBlur: 'enh_bg_blur',
        bgDim: 'enh_bg_dim',
        bubble: 'enh_bubble',
        maxw: 'enh_maxw',
        avatar: 'enh_avatar',
        time: 'enh_time',
        anim: 'enh_anim',
        perf: 'enh_perf'
    };

    function readPref(key, fallback) {
        try {
            var v = localStorage.getItem(key);
            return v === null || v === undefined ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function writePref(key, value) {
        try { localStorage.setItem(key, value); } catch (e) {}
    }

    // ======================== 常量表 ========================
    var ACCENTS = [
        { id: 'graphite', label: '石墨', color: '#4a4a4a' },
        { id: 'sakura', label: '樱粉', color: '#d0648a' },
        { id: 'ocean', label: '海蓝', color: '#3575c8' },
        { id: 'forest', label: '森绿', color: '#388f66' },
        { id: 'sunset', label: '暮橙', color: '#d67f36' },
        { id: 'violet', label: '紫藤', color: '#7f61d0' }
    ];

    var AMBIENCES = [
        { id: 'off', label: '关闭', icon: 'fa-ban' },
        { id: 'sakura', label: '樱花', icon: 'fa-fan' },
        { id: 'stars', label: '星尘', icon: 'fa-star' },
        { id: 'rain', label: '细雨', icon: 'fa-cloud-rain' },
        { id: 'snow', label: '飘雪', icon: 'fa-snowflake' }
    ];

    var FONT_SIZES = [
        { id: 'small', label: '小' },
        { id: 'normal', label: '标准' },
        { id: 'large', label: '大' },
        { id: 'xlarge', label: '特大' }
    ];

    var DENSITIES = [
        { id: 'compact', label: '紧凑' },
        { id: 'normal', label: '舒适' },
        { id: 'cozy', label: '宽松' }
    ];

    // 0.12.0：聊天背景（内置纹理，纯 CSS，不依赖任何图片资源）
    // 注意：css 必须是**纯 background-image 值**（只能有 gradient，不能带
    // "0 0 / 26px" 这种 shorthand 的位置/尺寸语法，否则整条声明会被丢弃）；
    // 平铺尺寸与 repeat 分别用 size / repeat 字段，由 --enh-bg-size / -repeat 控制。
    var BG_PATTERNS = [
        {
            id: 'paper', label: '纸纹', icon: 'fa-scroll', size: 'auto', repeat: 'repeat',
            css: 'repeating-linear-gradient(45deg, rgba(0,0,0,0.035) 0 2px, transparent 2px 7px), repeating-linear-gradient(-45deg, rgba(0,0,0,0.02) 0 2px, transparent 2px 7px)'
        },
        {
            id: 'dots', label: '点阵', icon: 'fa-braille', size: '18px 18px', repeat: 'repeat',
            css: 'radial-gradient(circle at center, rgba(0,0,0,0.16) 1px, transparent 1.6px)'
        },
        {
            id: 'grid', label: '网格', icon: 'fa-table-cells', size: '26px 26px', repeat: 'repeat',
            css: 'linear-gradient(rgba(0,0,0,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.07) 1px, transparent 1px)'
        },
        { id: 'mist', label: '晨雾', icon: 'fa-cloud', size: 'cover', repeat: 'no-repeat', css: 'linear-gradient(160deg, #e8f0fa 0%, #ffffff 45%, #dfe8f3 100%)' },
        { id: 'night', label: '夜雨', icon: 'fa-moon', size: 'cover', repeat: 'no-repeat', css: 'linear-gradient(180deg, #101a2b 0%, #1d2b42 55%, #0b1220 100%)' },
        { id: 'dawn', label: '晚霞', icon: 'fa-sun', size: 'cover', repeat: 'no-repeat', css: 'linear-gradient(140deg, #ffe0c2 0%, #f6a9bc 50%, #b9a3e3 100%)' }
    ];

    var BUBBLE_STYLES = [
        { id: 'wechat', label: '微信式' },
        { id: 'round', label: '全圆角' },
        { id: 'square', label: '直角' }
    ];

    var MAX_WIDTHS = [
        { id: 'full', label: '全宽' },
        { id: 'comfort', label: '舒适（900px）' }
    ];

    var AVATAR_SIZES = [
        { id: '32', label: '小 32' },
        { id: '38', label: '中 38' },
        { id: '44', label: '大 44' }
    ];

    var TIME_STYLES = [
        { id: 'full', label: '完整日期' },
        { id: 'relative', label: '相对时间' }
    ];

    var ANIM_STYLES = [
        { id: 'default', label: '默认（淡入上浮）' },
        { id: 'slide', label: '左右滑入' },
        { id: 'fade', label: '仅淡入' },
        { id: 'none', label: '无动画' }
    ];

    // 当前生效值（内存副本，避免每次读 localStorage）
    var state = {
        accent: 'graphite',
        ambience: 'off',
        font: 'normal',
        density: 'normal',
        ttsAuto: false,
        ttsRate: 1,
        // 0.12.0
        bgKind: 'none',     // none | pattern:<id> | custom | url
        bgUrl: '',
        bgBlur: 0,
        bgDim: 18,
        bubble: 'wechat',
        maxw: 'full',
        avatar: '38',
        time: 'full',
        anim: 'default',
        perf: false
    };

    // ======================== 通用小工具 ========================
    function safeToast(msg, type) {
        if (typeof showToast === 'function') showToast(msg, type || 'info');
    }

    function $(id) {
        return document.getElementById(id);
    }

    function el(tag, className, html) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (html !== undefined && html !== null) node.innerHTML = html;
        return node;
    }

    // 逃生：数据来自服务端时统一走这里
    function esc(str) {
        if (typeof escapeHtml === 'function') return escapeHtml(str);
        return String(str === null || str === undefined ? '' : str).replace(/[&<>"]/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] || m;
        });
    }

    // 安全调用其它模块的全局函数（函数不存在时不报错）
    function callGlobal(name) {
        var args = Array.prototype.slice.call(arguments, 1);
        try {
            var fn = window[name];
            if (typeof fn === 'function') return fn.apply(window, args);
        } catch (e) {
            console.debug('[enhance] 调用 ' + name + ' 失败:', e);
        }
        return undefined;
    }

    function hasGlobal(name) {
        return typeof window[name] === 'function';
    }

    // ======================== 1. 主题配色 ========================
    function applyAccent(id, silent) {
        var found = ACCENTS.some(function (a) { return a.id === id; }) ? id : 'graphite';
        state.accent = found;
        document.documentElement.setAttribute('data-accent', found);
        if (!silent) writePref(KEYS.accent, found);
        emitChange();
    }

    // 偏好变更广播：统一管理页（studio.html）据此刷新界面
    function emitChange() {
        try {
            document.dispatchEvent(new CustomEvent('enhance:change', { detail: getState() }));
        } catch (e) {}
    }

    function getState() {
        return {
            accent: state.accent,
            ambience: state.ambience,
            font: state.font,
            density: state.density,
            ttsAuto: state.ttsAuto,
            ttsRate: state.ttsRate,
            // 0.12.0
            bgKind: state.bgKind,
            bgUrl: state.bgUrl,
            bgBlur: state.bgBlur,
            bgDim: state.bgDim,
            bubble: state.bubble,
            maxw: state.maxw,
            avatar: state.avatar,
            time: state.time,
            anim: state.anim,
            perf: state.perf
        };
    }

    // ======================== 2. 阅读舒适度 ========================
    function applyFontSize(id, silent) {
        var found = FONT_SIZES.some(function (f) { return f.id === id; }) ? id : 'normal';
        state.font = found;
        document.documentElement.setAttribute('data-fontsize', found);
        if (!silent) writePref(KEYS.font, found);
        emitChange();
    }

    function applyDensity(id, silent) {
        var found = DENSITIES.some(function (d) { return d.id === id; }) ? id : 'normal';
        state.density = found;
        document.documentElement.setAttribute('data-density', found);
        if (!silent) writePref(KEYS.density, found);
        emitChange();
    }

    // ======================== 3. 氛围粒子 ========================
    var amb = {
        canvas: null,
        ctx: null,
        mode: 'off',
        particles: [],
        bursts: [],
        raf: 0,
        lastTs: 0,
        w: 0,
        h: 0,
        dpr: 1,
        nextShoot: 0,
        reduced: false
    };

    function ambienceReduced() {
        try {
            return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (e) {
            return false;
        }
    }

    function ensureAmbienceCanvas() {
        if (amb.canvas) return true;
        if (ambienceReduced()) return false;
        var canvas = document.createElement('canvas');
        canvas.id = 'enh-ambience';
        document.body.appendChild(canvas);
        amb.canvas = canvas;
        amb.ctx = canvas.getContext('2d');
        if (!amb.ctx) {
            canvas.remove();
            amb.canvas = null;
            return false;
        }
        resizeAmbience();
        window.addEventListener('resize', resizeAmbience, { passive: true });
        return true;
    }

    function resizeAmbience() {
        if (!amb.canvas) return;
        amb.dpr = Math.min(window.devicePixelRatio || 1, 2);
        amb.w = window.innerWidth;
        amb.h = window.innerHeight;
        amb.canvas.width = Math.floor(amb.w * amb.dpr);
        amb.canvas.height = Math.floor(amb.h * amb.dpr);
        amb.canvas.style.width = amb.w + 'px';
        amb.canvas.style.height = amb.h + 'px';
        amb.ctx.setTransform(amb.dpr, 0, 0, amb.dpr, 0, 0);
    }

    function rand(min, max) {
        return min + Math.random() * (max - min);
    }

    function makeParticle(mode, spreadY) {
        var p = { rot: rand(0, Math.PI * 2), vr: rand(-0.02, 0.02), alpha: 1, phase: rand(0, Math.PI * 2) };
        if (mode === 'sakura') {
            p.type = 'petal';
            p.x = rand(-40, amb.w + 40);
            p.y = spreadY ? rand(-amb.h, amb.h) : rand(-60, -10);
            p.vy = rand(0.5, 1.5);
            p.vx = rand(-0.4, 0.9);
            p.size = rand(6, 12);
            p.alpha = rand(0.35, 0.8);
            p.color = Math.random() > 0.5 ? '#f7b8cd' : '#f2a0bb';
        } else if (mode === 'snow') {
            p.type = 'snow';
            p.x = rand(0, amb.w);
            p.y = spreadY ? rand(-amb.h, amb.h) : rand(-30, -5);
            p.vy = rand(0.35, 1.2);
            p.vx = rand(-0.25, 0.25);
            p.size = rand(1.6, 4.2);
            p.alpha = rand(0.35, 0.9);
        } else if (mode === 'rain') {
            p.type = 'rain';
            p.x = rand(0, amb.w);
            p.y = spreadY ? rand(-amb.h, amb.h) : rand(-80, -10);
            p.vy = rand(9, 16);
            p.vx = rand(0.6, 1.4);
            p.size = rand(8, 20);
            p.alpha = rand(0.12, 0.3);
        } else {
            // stars：闪点
            p.type = 'star';
            p.x = rand(0, amb.w);
            p.y = rand(0, amb.h);
            p.vy = rand(0.02, 0.12);
            p.vx = rand(-0.08, 0.08);
            p.size = rand(0.7, 1.9);
            p.alpha = rand(0.25, 0.85);
        }
        return p;
    }

    function spawnAmbience(mode) {
        amb.particles = [];
        if (mode === 'off') return;
        var count = mode === 'rain' ? 90 : mode === 'stars' ? 64 : mode === 'snow' ? 52 : 38;
        for (var i = 0; i < count; i++) {
            var p = makeParticle(mode, true);
            amb.particles.push(p);
        }
    }

    function drawFrame(ts) {
        amb.raf = 0;
        if (!amb.ctx) return;
        // 后台标签页不耗电（rAF 本身也会暂停，这里直接返回）
        if (document.hidden) return;
        var dt = amb.lastTs ? Math.min(ts - amb.lastTs, 50) : 16.7;
        amb.lastTs = ts;
        var k = dt / 16.7;

        var ctx = amb.ctx;
        ctx.clearRect(0, 0, amb.w, amb.h);
        if (!amb.rainColor) {
            try {
                amb.rainColor = getComputedStyle(document.documentElement)
                    .getPropertyValue('--text-secondary').trim() || '#8b8b8b';
            } catch (e) {
                amb.rainColor = '#8b8b8b';
            }
        }

        // ---- 常驻粒子 ----
        for (var i = 0; i < amb.particles.length; i++) {
            var p = amb.particles[i];
            if (p.type === 'petal') {
                p.phase += 0.02 * k;
                p.x += (p.vx + Math.sin(p.phase) * 0.7) * k;
                p.y += p.vy * k;
                p.rot += p.vr * k;
                if (p.y > amb.h + 30 || p.x < -60 || p.x > amb.w + 60) {
                    amb.particles[i] = makeParticle('sakura', false);
                    continue;
                }
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot);
                ctx.globalAlpha = p.alpha;
                ctx.fillStyle = p.color;
                ctx.beginPath();
                // 花瓣：两段贝塞尔构成的叶子形
                ctx.moveTo(0, -p.size / 2);
                ctx.quadraticCurveTo(p.size / 2, 0, 0, p.size / 2);
                ctx.quadraticCurveTo(-p.size / 2, 0, 0, -p.size / 2);
                ctx.fill();
                ctx.restore();
            } else if (p.type === 'snow') {
                p.phase += 0.015 * k;
                p.x += (p.vx + Math.sin(p.phase) * 0.4) * k;
                p.y += p.vy * k;
                if (p.y > amb.h + 10) {
                    amb.particles[i] = makeParticle('snow', false);
                    continue;
                }
                ctx.globalAlpha = p.alpha;
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'rain') {
                p.x += p.vx * k;
                p.y += p.vy * k;
                if (p.y > amb.h + 20) {
                    amb.particles[i] = makeParticle('rain', false);
                    continue;
                }
                ctx.globalAlpha = p.alpha;
                ctx.strokeStyle = amb.rainColor;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p.x - p.vx * 1.4, p.y - p.size);
                ctx.stroke();
            } else {
                // star：缓慢漂移 + 闪烁
                p.phase += 0.03 * k;
                p.x += p.vx * k;
                p.y += p.vy * k;
                if (p.y > amb.h + 4) { p.y = -4; p.x = rand(0, amb.w); }
                if (p.x < -4) p.x = amb.w + 4;
                if (p.x > amb.w + 4) p.x = -4;
                ctx.globalAlpha = p.alpha * (0.55 + 0.45 * Math.sin(p.phase));
                ctx.fillStyle = '#ffd9a8';
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
                // 偶尔来一颗流星
                if (ts > amb.nextShoot) {
                    amb.nextShoot = ts + rand(4000, 9000);
                    amb.bursts.push({
                        type: 'shoot',
                        x: rand(amb.w * 0.1, amb.w * 0.8),
                        y: rand(0, amb.h * 0.35),
                        vx: rand(5, 8),
                        vy: rand(2.2, 3.6),
                        life: 1,
                        decay: 0.012 * k,
                        size: rand(1, 1.8)
                    });
                }
            }
        }

        // ---- 爆破粒子（爱心 / 撒花 / 流星）----
        for (var j = amb.bursts.length - 1; j >= 0; j--) {
            var b = amb.bursts[j];
            b.x += b.vx * k;
            b.y += b.vy * k;
            if (b.type === 'shoot') {
                ctx.globalAlpha = Math.max(0, b.life) * 0.9;
                ctx.strokeStyle = '#ffe9c7';
                ctx.lineWidth = b.size;
                ctx.beginPath();
                ctx.moveTo(b.x, b.y);
                ctx.lineTo(b.x - b.vx * 6, b.y - b.vy * 6);
                ctx.stroke();
            } else {
                b.vy += (b.gravity || 0) * k;
                b.rot += (b.vr || 0) * k;
                ctx.save();
                ctx.translate(b.x, b.y);
                ctx.rotate(b.rot || 0);
                ctx.globalAlpha = Math.max(0, b.life) * (b.alpha || 0.9);
                if (b.type === 'heart') {
                    ctx.fillStyle = b.color || '#f0759c';
                    var s = b.size;
                    ctx.beginPath();
                    ctx.moveTo(0, s * 0.35);
                    ctx.bezierCurveTo(s, -s * 0.45, s * 0.45, -s, 0, -s * 0.35);
                    ctx.bezierCurveTo(-s * 0.45, -s, -s, -s * 0.45, 0, s * 0.35);
                    ctx.fill();
                } else {
                    ctx.fillStyle = b.color || '#f7b8cd';
                    ctx.beginPath();
                    ctx.arc(0, 0, b.size, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
            b.life -= b.decay;
            if (b.life <= 0) amb.bursts.splice(j, 1);
        }

        ctx.globalAlpha = 1;

        if (amb.particles.length || amb.bursts.length) {
            scheduleFrame();
        } else {
            amb.lastTs = 0;
            if (amb.mode === 'off' && amb.canvas) {
                amb.ctx.clearRect(0, 0, amb.w, amb.h);
            }
        }
    }

    function scheduleFrame() {
        if (amb.raf) return;
        amb.raf = requestAnimationFrame(drawFrame);
    }

    function setAmbience(id, silent) {
        var found = AMBIENCES.some(function (a) { return a.id === id; }) ? id : 'off';
        state.ambience = found;
        amb.mode = found;
        if (!silent) writePref(KEYS.ambience, found);
        amb.rainColor = '';   // 主题可能变了，雨丝颜色重新取一次
        emitChange();

        // 性能模式：只记住偏好，不启动任何粒子
        if (state.perf) {
            amb.particles = [];
            amb.bursts = [];
            if (amb.ctx) amb.ctx.clearRect(0, 0, amb.w, amb.h);
            return;
        }

        if (found === 'off') {
            amb.particles = [];
            amb.bursts = [];
            if (amb.ctx) amb.ctx.clearRect(0, 0, amb.w, amb.h);
            return;
        }
        if (!ensureAmbienceCanvas()) {
            // 系统开启了「减少动态效果」→ 尊重不播放
            state.ambience = 'off';
            emitChange();
            return;
        }
        resizeAmbience();
        spawnAmbience(found);
        amb.lastTs = 0;
        scheduleFrame();
    }

    // 双击聊天区：爱心/花瓣爆破（好玩的小彩蛋）
    function burstAt(x, y) {
        if (ambienceReduced()) return;
        if (!ensureAmbienceCanvas()) return;
        var count = 16;
        for (var i = 0; i < count; i++) {
            var angle = (Math.PI * 2 * i) / count + rand(-0.2, 0.2);
            var speed = rand(1.6, 4.4);
            amb.bursts.push({
                type: i % 3 === 0 ? 'heart' : 'dot',
                x: x,
                y: y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 1.2,
                gravity: 0.06,
                rot: rand(0, Math.PI * 2),
                vr: rand(-0.08, 0.08),
                size: rand(2, 5),
                life: 1,
                decay: rand(0.008, 0.016),
                alpha: rand(0.6, 0.95),
                color: i % 2 ? '#f0759c' : '#f7b8cd'
            });
        }
        scheduleFrame();
    }

    // ======================== 4. 命令面板 ========================
    var palette = {
        overlay: null,
        input: null,
        list: null,
        all: [],
        filtered: [],
        index: 0,
        open: false
    };

    function paletteActions() {
        var acts = [];

        // ---- 会话 / 消息 ----
        acts.push({ icon: 'fa-magnifying-glass', label: '搜索聊天记录', hint: 'Ctrl+K', keywords: 'search 搜索 关键词', run: function () { callGlobal('openSearch'); } });
        acts.push({ icon: 'fa-star', label: '打开我的收藏', keywords: 'favorite 收藏 星标', run: function () { callGlobal('openFavorites'); } });
        acts.push({ icon: 'fa-handshake', label: 'AI 答应你的事', keywords: 'commitment 承诺 待办', run: function () { callGlobal('openCommitments'); } });
        acts.push({ icon: 'fa-file-export', label: '导出当前对话', keywords: 'export 导出 备份', run: function () {
            if (typeof currentContact === 'undefined' || !currentContact) { safeToast('请先选择联系人', 'info'); return; }
            if (hasGlobal('openExportDialog')) {
                callGlobal('openExportDialog', currentContact.contact_id, currentContact.display_name);
            } else {
                safeToast('导出模块未加载', 'error');
            }
        } });
        acts.push({ icon: 'fa-trash-can', label: '删除聊天记录', keywords: 'delete 删除 清空', run: function () { callGlobal('openClearHistory'); } });

        // ---- 本模块功能 ----
        acts.push({ icon: 'fa-chart-simple', label: '查看会话洞察（数据面板）', keywords: 'insight stats 统计 数据 报告', run: openInsights });
        acts.push({ icon: 'fa-volume-high', label: '朗读最后一条 AI 回复', hint: 'Ctrl+Shift+L', keywords: 'tts 朗读 语音 播放', run: speakLastReply });
        acts.push({ icon: 'fa-volume-xmark', label: '停止朗读', keywords: 'stop 停止 静音', run: stopSpeaking });
        acts.push({ icon: 'fa-thumbtack', label: '置顶 / 取消置顶当前联系人', keywords: 'pin 置顶 钉住', run: togglePinCurrent });
        acts.push({ icon: 'fa-circle-question', label: '查看本地指令（/roll /coin /pick）', keywords: 'command 指令 帮助 help 彩蛋', run: function () { showLocalHelp(); } });
        // ---- 0.13.0 好玩扩展（实际实现见 enhance-cinema.js） ----
        acts.push({
            icon: 'fa-clock-rotate-left',
            label: '时光机：回放某一天的对话',
            keywords: 'replay 时光机 回放 历史 重播',
            run: function () { callGlobal('openReplay'); }
        });
        acts.push({
            icon: 'fa-image',
            label: '把最后一条对话做成分享卡片',
            keywords: 'share 分享 卡片 图片 截图 png',
            run: function () { callGlobal('shareLastMessage'); }
        });

        // ---- 外观 ----
        acts.push({ icon: 'fa-sun', label: '切换到明亮主题', keywords: 'light 明亮 主题', run: function () { callGlobal('setTheme', 'light'); } });
        acts.push({ icon: 'fa-moon', label: '切换到黑暗主题', keywords: 'dark 黑暗 主题 夜间', run: function () { callGlobal('setTheme', 'dark'); } });
        ACCENTS.forEach(function (a) {
            acts.push({
                icon: 'fa-palette',
                label: '配色：' + a.label,
                keywords: 'accent 配色 主题 ' + a.label,
                run: function () { applyAccent(a.id); safeToast('已切换为「' + a.label + '」配色', 'success'); }
            });
        });
        AMBIENCES.forEach(function (a) {
            acts.push({
                icon: a.icon,
                label: '氛围：' + a.label,
                keywords: 'ambience 氛围 粒子 特效 ' + a.label,
                run: function () { setAmbience(a.id); safeToast('氛围：' + a.label, 'success'); }
            });
        });
        FONT_SIZES.forEach(function (f) {
            acts.push({ icon: 'fa-font', label: '字号：' + f.label, keywords: 'font 字号 字体 ' + f.label, run: function () { applyFontSize(f.id); } });
        });
        DENSITIES.forEach(function (d) {
            acts.push({ icon: 'fa-bars', label: '气泡密度：' + d.label, keywords: 'density 密度 间距 ' + d.label, run: function () { applyDensity(d.id); } });
        });

        // ---- 设置 / 系统 ----
        acts.push({
            icon: 'fa-wand-magic-sparkles',
            label: '打开外观与玩法中心',
            hint: 'Studio',
            keywords: 'studio 外观 玩法 中心 配色 氛围 字号 朗读 置顶',
            run: function () { window.location.href = '/studio'; }
        });
        acts.push({ icon: 'fa-gear', label: '打开设置', keywords: 'settings 设置', run: function () { var b = $('settings-btn'); if (b) b.click(); } });
        acts.push({ icon: 'fa-robot', label: '打开 AI 设置（当前角色）', keywords: 'ai model 模型 参数 温度', run: function () { callGlobal('openAiSettings'); } });
        acts.push({ icon: 'fa-user', label: '打开个人资料', keywords: 'profile 资料 头像 密码', run: function () { var b = $('profile-btn'); if (b) b.click(); } });
        acts.push({ icon: 'fa-cloud-arrow-down', label: '强制同步云端数据', keywords: 'sync 同步 刷新', run: function () { var b = $('syncBtn'); if (b) b.click(); } });
        acts.push({ icon: 'fa-book', label: '查看更新日志', keywords: 'changelog 更新 版本', run: function () { callGlobal('openChangelog'); } });
        acts.push({ icon: 'fa-book-open', label: '打开使用手册', keywords: 'docs 手册 帮助', run: function () { window.open('https://bypc.us.ci/docs/', '_blank', 'noopener'); } });
        acts.push({ icon: 'fa-cogs', label: '打开管理后台', keywords: 'admin 后台 角色', run: function () { window.location.href = '/admin/roles.html'; } });
        acts.push({ icon: 'fa-right-from-bracket', label: '退出登录', keywords: 'logout 退出', run: function () { callGlobal('logout'); } });

        // ---- 联系人跳转 ----
        if (typeof contacts !== 'undefined' && Array.isArray(contacts)) {
            contacts.forEach(function (c) {
                acts.push({
                    icon: c.contact_type === 'ai' ? 'fa-robot' : 'fa-user',
                    label: '跳转会话：' + c.display_name,
                    hint: c.contact_type === 'ai' ? 'AI' : '用户',
                    keywords: 'contact 联系人 会话 ' + c.display_name,
                    run: function () { callGlobal('selectContact', c); }
                });
            });
        }
        return acts;
    }

    function buildPalette() {
        if (palette.overlay) return;
        var overlay = el('div', 'enh-palette-overlay');
        var box = el('div', 'enh-palette');
        var head = el('div', 'enh-palette-head');
        head.appendChild(el('i', 'fas fa-wand-magic-sparkles'));
        var input = document.createElement('input');
        input.className = 'enh-palette-input';
        input.type = 'text';
        input.placeholder = '输入关键词，回车执行…';
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('aria-label', '命令面板搜索');
        head.appendChild(input);
        head.appendChild(el('span', 'enh-palette-esc', 'Esc'));
        var list = el('div', 'enh-palette-list');
        var foot = el('div', 'enh-palette-foot');
        foot.innerHTML = '<span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span><span>Ctrl+Shift+P 打开</span>';
        box.appendChild(head);
        box.appendChild(list);
        box.appendChild(foot);
        overlay.appendChild(box);
        overlay.style.display = 'none';
        document.body.appendChild(overlay);

        palette.overlay = overlay;
        palette.input = input;
        palette.list = list;

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closePalette();
        });
        input.addEventListener('input', function () {
            palette.index = 0;
            renderPaletteList();
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(); }
            else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
        });
    }

    function filterPalette() {
        var q = (palette.input.value || '').trim().toLowerCase();
        var all = palette.all;
        if (!q) return all.slice(0, 60);
        var tokens = q.split(/\s+/);
        return all.filter(function (a) {
            var hay = (a.label + ' ' + (a.keywords || '') + ' ' + (a.hint || '')).toLowerCase();
            return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
        }).slice(0, 60);
    }

    function renderPaletteList() {
        palette.filtered = filterPalette();
        var list = palette.list;
        list.innerHTML = '';
        if (!palette.filtered.length) {
            list.appendChild(el('div', 'enh-palette-empty', '没有匹配的命令'));
            return;
        }
        if (palette.index >= palette.filtered.length) palette.index = palette.filtered.length - 1;
        if (palette.index < 0) palette.index = 0;
        var lastGroup = null;
        palette.filtered.forEach(function (a, i) {
            // 分组标题：命令变多之后，一屏 40 条容易找不到；按类别分块更直观
            if (a.group && a.group !== lastGroup) {
                lastGroup = a.group;
                list.appendChild(el('div', 'enh-palette-group', esc(a.group)));
            }
            var btn = el('button', 'enh-palette-item' + (i === palette.index ? ' active' : ''));
            btn.type = 'button';
            btn.innerHTML = '<i class="fas ' + (a.icon || 'fa-angle-right') + '"></i>' +
                '<span>' + esc(a.label) + '</span>' +
                (a.hint ? '<span class="enh-palette-hint">' + esc(a.hint) + '</span>' : '');
            btn.addEventListener('mouseenter', function () {
                palette.index = i;
                highlightPalette();
            });
            btn.addEventListener('click', function () {
                palette.index = i;
                runPaletteItem();
            });
            list.appendChild(btn);
        });
        highlightPalette();
    }

    // 命令分组：按类别排序后再渲染，避免 40 条命令平铺
    var PALETTE_GROUPS = ['消息与会话', '工具', '外观', '设置与系统', '联系人'];
    function groupOf(action) {
        var label = action.label || '';
        if (/跳转会话/.test(label)) return '联系人';
        if (/配色|氛围|字号|气泡密度|主题/.test(label)) return '外观';
        if (/洞察|朗读|停止朗读|置顶|本地指令/.test(label)) return '工具';
        if (/搜索|收藏|答应你的事|导出|删除聊天记录/.test(label)) return '消息与会话';
        return '设置与系统';
    }

    function highlightPalette() {
        if (!palette.list) return;
        var nodes = palette.list.querySelectorAll('.enh-palette-item');
        Array.prototype.forEach.call(nodes, function (n, i) {
            n.classList.toggle('active', i === palette.index);
        });
        var active = nodes[palette.index];
        if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    }

    function movePalette(delta) {
        if (!palette.filtered.length) return;
        palette.index = (palette.index + delta + palette.filtered.length) % palette.filtered.length;
        highlightPalette();
    }

    function runPaletteItem() {
        var item = palette.filtered[palette.index];
        if (!item) return;
        closePalette();
        // 延后一帧，避免命令里打开的新弹窗被关闭动效盖住
        setTimeout(function () {
            try { item.run(); } catch (e) { console.error('[enhance] 命令执行失败:', e); }
        }, 60);
    }

    function openPalette() {
        buildPalette();
        palette.all = paletteActions().map(function (a) {
            a.group = groupOf(a);
            return a;
        }).sort(function (a, b) {
            return PALETTE_GROUPS.indexOf(a.group) - PALETTE_GROUPS.indexOf(b.group);
        });
        palette.index = 0;
        palette.input.value = '';
        renderPaletteList();
        palette.overlay.style.display = 'flex';
        palette.open = true;
        requestAnimationFrame(function () { palette.overlay.classList.add('show'); });
        setTimeout(function () { palette.input.focus(); }, 40);
    }

    function closePalette() {
        if (!palette.overlay || !palette.open) return;
        palette.open = false;
        palette.overlay.classList.remove('show');
        setTimeout(function () {
            if (!palette.open && palette.overlay) palette.overlay.style.display = 'none';
        }, 180);
    }

    // ======================== 5. 语音朗读 ========================
    var tts = { speaking: false, voice: null, ready: false };

    function ttsSupported() {
        return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
    }

    function stripForSpeech(text) {
        var s = String(text || '');
        s = s.replace(/^\/me\s+/i, '');
        s = s.replace(/```[\s\S]*?```/g, '。');
        s = s.replace(/`([^`]*)`/g, '$1');
        s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
        s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
        s = s.replace(/[*_~#>|]/g, '');
        s = s.replace(/^\s*[-+]\s+/gm, '');
        s = s.replace(/\s+/g, ' ').trim();
        return s;
    }

    function pickVoice() {
        if (!ttsSupported()) return null;
        var voices = window.speechSynthesis.getVoices() || [];
        if (!voices.length) return null;
        // 优先中文女声（听感更柔和），其次任意中文，兜底默认
        var zh = voices.filter(function (v) { return /^zh|cmn/i.test(v.lang || ''); });
        if (!zh.length) return voices[0];
        var female = zh.filter(function (v) { return /female|女|xiaoxiao|xiaoyi|huihui|tingting|mei/i.test(v.name || ''); });
        return female[0] || zh[0];
    }

    function initTts() {
        if (!ttsSupported()) return;
        window.speechSynthesis.onvoiceschanged = function () {
            tts.voice = pickVoice();
        };
        tts.voice = pickVoice();
        tts.ready = true;
    }

    function speak(text) {
        if (!ttsSupported()) {
            safeToast('当前浏览器不支持语音朗读', 'error');
            return;
        }
        var clean = stripForSpeech(text);
        if (!clean) return;
        try { window.speechSynthesis.cancel(); } catch (e) {}
        var utter = new window.SpeechSynthesisUtterance(clean);
        var v = tts.voice || pickVoice();
        if (v) {
            utter.voice = v;
            utter.lang = v.lang || 'zh-CN';
        } else {
            utter.lang = 'zh-CN';
        }
        utter.rate = Math.max(0.5, Math.min(2, Number(state.ttsRate) || 1));
        utter.pitch = 1;
        utter.onstart = function () { tts.speaking = true; };
        utter.onend = function () { tts.speaking = false; };
        utter.onerror = function () { tts.speaking = false; };
        tts.speaking = true;
        window.speechSynthesis.speak(utter);
    }

    function stopSpeaking() {
        if (!ttsSupported()) return;
        try { window.speechSynthesis.cancel(); } catch (e) {}
        tts.speaking = false;
    }

    function messageRawText(msgEl) {
        if (!msgEl) return '';
        var raw = msgEl.dataset ? msgEl.dataset.rawContent : '';
        if (raw) return raw;
        var t = msgEl.querySelector('.message-text');
        return t ? (t.textContent || '') : '';
    }

    function speakMessage(msgEl) {
        var raw = messageRawText(msgEl);
        if (!raw) { safeToast('这条消息没有可朗读的内容', 'info'); return; }
        speak(raw);
    }

    function speakLastReply() {
        if (typeof chatBox === 'undefined' || !chatBox) return;
        var nodes = chatBox.querySelectorAll('.message.received:not(.ai-version-hidden)');
        var last = nodes[nodes.length - 1];
        if (!last) { safeToast('还没有可朗读的 AI 回复', 'info'); return; }
        speakMessage(last);
    }

    // ======================== 6. 会话洞察 ========================
    var insightsModal = null;

    function buildInsightsModal() {
        if (insightsModal) return insightsModal;
        var overlay = el('div', 'modal enh-insights-modal');
        var content = el('div', 'modal-content enh-insights-content');
        content.innerHTML =
            '<div class="modal-header">' +
            '  <h2><i class="fas fa-chart-simple"></i> 会话洞察</h2>' +
            '  <button class="close-btn" data-close>&times;</button>' +
            '</div>' +
            '<div class="modal-body"><div id="enhInsightsBody" class="enh-insights-body">' +
            '  <div class="enh-loading"><i class="fas fa-spinner fa-spin"></i> 正在统计…</div>' +
            '</div></div>';
        overlay.appendChild(content);
        document.body.appendChild(overlay);
        content.querySelector('[data-close]').addEventListener('click', function () {
            if (hasGlobal('hideModal')) callGlobal('hideModal', overlay);
            else overlay.classList.remove('active');
        });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) {
                if (hasGlobal('hideModal')) callGlobal('hideModal', overlay);
                else overlay.classList.remove('active');
            }
        });
        insightsModal = overlay;
        return overlay;
    }

    function barChart(daily) {
        if (!daily || !daily.length) return '<div class="enh-card-label">暂无数据</div>';
        var max = 1;
        daily.forEach(function (d) { if (d.count > max) max = d.count; });
        var html = '<div class="enh-bars">';
        daily.forEach(function (d) {
            var h = Math.max(2, Math.round((d.count / max) * 54));
            var label = String(d.day || '').slice(5).replace('-', '/');
            html += '<div class="enh-bar-col" title="' + esc(label + ' · ' + d.count + ' 条') + '">' +
                '<div class="enh-bar' + (d.count ? '' : ' zero') + '" style="height:' + h + 'px"></div>' +
                '<div class="enh-bar-label">' + esc(label) + '</div>' +
                '</div>';
        });
        html += '</div>';
        return html;
    }

    function renderInsights(data) {
        var body = $('enhInsightsBody');
        if (!body) return;
        var g = data.global || {};
        var c = data.contact || null;
        var heroDays = (c && c.known_days) || g.known_days || 0;
        var heroLabel = c ? '与「' + (data.contact_name || '这个角色') + '」相识' : '开始聊天';

        var cards = [];
        cards.push({ v: (c ? c.messages : g.messages) || 0, unit: '条', label: c ? '本角色累计消息' : '累计消息' });
        cards.push({ v: (c ? c.today : g.today) || 0, unit: '条', label: '今天聊了' });
        cards.push({ v: (c ? c.streak_longest : g.streak_longest) || 0, unit: '天', label: '最长连续聊天' });
        cards.push({ v: (c ? c.streak_current : g.streak_current) || 0, unit: '天', label: '当前连续聊天' });

        var html = '';
        html += '<div class="enh-hero">' +
            '<div class="enh-hero-days">' + esc(String(heroDays)) + '</div>' +
            '<div class="enh-hero-label">' + esc(heroLabel) + ' 第 ' + esc(String(heroDays)) + ' 天</div>' +
            '<div class="enh-hero-sub">总计 ' + esc(String(g.messages || 0)) + ' 条消息 · 一起聊过 ' +
            esc(String(g.days || 0)) + ' 天 · ' + esc(String(g.chars || 0)) + ' 字</div>' +
            '</div>';

        html += '<div class="enh-grid">';
        cards.forEach(function (card) {
            html += '<div class="enh-card"><div class="enh-card-value">' + esc(String(card.v)) +
                '<small>' + esc(card.unit) + '</small></div>' +
                '<div class="enh-card-label">' + esc(card.label) + '</div></div>';
        });
        html += '</div>';

        html += '<div class="enh-card"><div class="enh-block-title"><i class="fas fa-chart-column"></i> 最近 14 天消息分布</div>' +
            barChart(data.daily) + '</div>';

        if (data.hours && data.hours.length) {
            html += '<div class="enh-card"><div class="enh-block-title"><i class="fas fa-clock"></i> 你最常出没的时段</div><div class="enh-chips">';
            data.hours.slice(0, 4).forEach(function (h) {
                html += '<span class="enh-chip">' + esc(String(h.hour)) + ' 点 · <b>' + esc(String(h.count)) + '</b> 条</span>';
            });
            html += '</div></div>';
        }

        if (data.emotions && data.emotions.length) {
            html += '<div class="enh-card"><div class="enh-block-title"><i class="fas fa-heart-pulse"></i> 记忆里的情绪标签</div><div class="enh-chips">';
            data.emotions.slice(0, 8).forEach(function (e) {
                html += '<span class="enh-chip">' + esc(e.emotion) + ' <b>' + esc(String(e.count)) + '</b></span>';
            });
            html += '</div></div>';
        }

        if (c && c.first_day) {
            html += '<div class="enh-insights-foot">你们的第一句话在 ' + esc(c.first_day) + '</div>';
        }
        body.innerHTML = html;
    }

    async function openInsights() {
        var modal = buildInsightsModal();
        if (hasGlobal('showModal')) callGlobal('showModal', modal);
        else modal.classList.add('active');

        var body = $('enhInsightsBody');
        if (body) body.innerHTML = '<div class="enh-loading"><i class="fas fa-spinner fa-spin"></i> 正在统计…</div>';

        var contactId = '';
        var contactName = '';
        try {
            if (typeof currentContact !== 'undefined' && currentContact) {
                contactId = currentContact.contact_id || '';
                contactName = currentContact.display_name || '';
            }
        } catch (e) {}

        if (!hasGlobal('fetchWithAuth')) {
            if (body) body.innerHTML = '<div class="enh-loading">登录后才能查看洞察</div>';
            return;
        }
        try {
            var res = await callGlobal('fetchWithAuth', '/api/insights?contact=' + encodeURIComponent(contactId));
            if (!res || !res.ok) {
                var err = res ? await res.json().catch(function () { return {}; }) : {};
                throw new Error((err && err.error) || '统计接口不可用');
            }
            var data = await res.json();
            data.contact_name = contactName;
            renderInsights(data);
        } catch (e) {
            if (body) {
                body.innerHTML = '<div class="enh-loading">😢 统计失败：' + esc(e.message || '未知错误') + '</div>';
            }
        }
    }

    // ======================== 7. 联系人置顶 ========================
    function getPins() {
        try {
            var raw = localStorage.getItem(KEYS.pins);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    function savePins(list) {
        try { localStorage.setItem(KEYS.pins, JSON.stringify(list)); } catch (e) {}
    }

    function isPinned(contactId) {
        return getPins().indexOf(String(contactId)) !== -1;
    }

    function togglePin(contactId) {
        if (!contactId) return false;
        var pins = getPins();
        var id = String(contactId);
        var idx = pins.indexOf(id);
        if (idx === -1) pins.push(id);
        else pins.splice(idx, 1);
        savePins(pins);
        return idx === -1;
    }

    function togglePinCurrent() {
        if (typeof currentContact === 'undefined' || !currentContact) {
            safeToast('请先选择一个联系人', 'info');
            return;
        }
        var pinned = togglePin(currentContact.contact_id);
        safeToast(pinned ? '已置顶「' + currentContact.display_name + '」📌' : '已取消置顶', 'success');
        callGlobal('renderContacts');
    }

    // 置顶联系人排前面（在 renderContacts 之前重排 contacts 数组）
    function sortContactsByPins() {
        if (typeof contacts === 'undefined' || !Array.isArray(contacts)) return;
        var pins = getPins();
        if (!pins.length) return;
        contacts.sort(function (a, b) {
            var pa = pins.indexOf(String(a.contact_id)) !== -1 ? 0 : 1;
            var pb = pins.indexOf(String(b.contact_id)) !== -1 ? 0 : 1;
            return pa - pb;
        });
    }

    // 渲染后给每个联系人挂图钉按钮
    function decoratePins() {
        if (typeof contactsList === 'undefined' || !contactsList) return;
        var pins = getPins();
        Array.prototype.forEach.call(contactsList.querySelectorAll('.contact-item'), function (item) {
            var cid = item.dataset.contactId || '';
            var pinned = pins.indexOf(cid) !== -1;
            item.classList.toggle('enh-pinned', pinned);
            var btn = item.querySelector('.enh-pin-btn');
            if (!btn) {
                btn = document.createElement('button');
                btn.className = 'enh-pin-btn';
                btn.type = 'button';
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    e.preventDefault();
                    var nowPinned = togglePin(cid);
                    safeToast(nowPinned ? '已置顶 📌' : '已取消置顶', 'success');
                    callGlobal('renderContacts');
                });
                item.appendChild(btn);
            }
            btn.title = pinned ? '取消置顶' : '置顶该联系人';
            btn.innerHTML = '<i class="fas fa-thumbtack"></i>';
        });
    }

    // ======================== 8. 本地指令 / /me 动作气泡 ========================
    function showLocalCard(html, extraClass) {
        if (typeof chatBox === 'undefined' || !chatBox) return;
        var div = document.createElement('div');
        div.className = 'message system enh-local-card' + (extraClass ? ' ' + extraClass : '');
        var text = document.createElement('div');
        text.className = 'message-text';
        text.innerHTML = html;
        div.appendChild(text);
        chatBox.appendChild(div);
        callGlobal('scrollToBottom');
    }

    function showLocalHelp() {
        var rows = [
            ['/me 伸了个懒腰', '动作气泡：斜体显示，并照常发给角色'],
            ['/roll 2d6+1', '掷骰子（默认 1d20），只在本地显示结果'],
            ['/coin', '抛硬币：正面 / 反面'],
            ['/pick 火锅 烧烤 拉面', '从多个选项里随机挑一个（也可用 | 分隔）'],
            ['/time', '看看现在几点（本地时间 + 北京时间）'],
            ['/cmd 用更温柔的语气', '导演词：给 AI 一条临时提示，不产生消息'],
            ['/help', '显示这份帮助']
        ];
        var html = '<div class="enh-cmd-title"><i class="fas fa-terminal"></i> 本地指令</div>' +
            '<div class="enh-cmd-list">' +
            rows.map(function (r) {
                return '<div class="enh-cmd-row"><code>' + esc(r[0]) + '</code><span>' + esc(r[1]) + '</span></div>';
            }).join('') +
            '</div><div class="enh-cmd-foot">这些指令只在你的浏览器里执行，不会发给 AI（除 /me 与 /cmd 外）</div>';
        showLocalCard(html, 'enh-cmd-card');
    }

    // 骰子解析：NdM+K
    function parseDice(arg) {
        var m = String(arg || '').trim().match(/^(\d{0,2})\s*d\s*(\d{1,4})\s*([+-]\s*\d{1,4})?$/i);
        if (!m) return null;
        var n = m[1] ? parseInt(m[1], 10) : 1;
        var sides = parseInt(m[2], 10);
        var mod = m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0;
        if (!(n >= 1 && n <= 20)) return null;
        if (!(sides >= 2 && sides <= 1000)) return null;
        if (Math.abs(mod) > 1000) return null;
        return { n: n, sides: sides, mod: mod };
    }

    function rollDice(arg) {
        // 不写参数时默认 1d20（与 /help 里的说明一致）
        var cfg = parseDice(String(arg || '').trim() || '1d20');
        if (!cfg) {
            showLocalCard('<i class="fas fa-triangle-exclamation"></i> 骰子格式：<code>/roll 2d6+1</code>（1~20 颗、2~1000 面）', 'enh-cmd-card');
            return;
        }
        var rolls = [];
        var total = cfg.mod;
        for (var i = 0; i < cfg.n; i++) {
            var v = 1 + Math.floor(Math.random() * cfg.sides);
            rolls.push(v);
            total += v;
        }
        var detail = cfg.n > 1
            ? '（' + rolls.join(' + ') + (cfg.mod ? (cfg.mod > 0 ? ' + ' : ' − ') + Math.abs(cfg.mod) : '') + '）'
            : '';
        showLocalCard('<div class="enh-dice"><i class="fas fa-dice-d20"></i> <b>' + total + '</b> ' + detail + '</div>' +
            '<div class="enh-cmd-sub">' + cfg.n + 'd' + cfg.sides + (cfg.mod ? (cfg.mod > 0 ? '+' : '') + cfg.mod : '') + '</div>', 'enh-cmd-card');
    }

    function pickOne(arg) {
        var options = String(arg || '').indexOf('|') !== -1
            ? String(arg).split('|')
            : String(arg || '').split(/\s+/);
        options = options.map(function (s) { return s.trim(); }).filter(Boolean);
        if (options.length < 2) {
            showLocalCard('<i class="fas fa-triangle-exclamation"></i> 用法：<code>/pick 火锅 烧烤 拉面</code>（至少两个选项）', 'enh-cmd-card');
            return;
        }
        var chosen = options[Math.floor(Math.random() * options.length)];
        showLocalCard('<div class="enh-dice"><i class="fas fa-hand-point-right"></i> 就决定是 <b>' + esc(chosen) + '</b> 了！</div>' +
            '<div class="enh-cmd-sub">候选：' + options.map(esc).join(' / ') + '</div>', 'enh-cmd-card');
    }

    // 钩子：app.js sendMessage 里调用；返回 true 表示已消费，不再发送
    function handleLocalCommand(raw) {
        var text = String(raw || '').trim();
        if (!text || text.charAt(0) !== '/') return false;
        var m = text.match(/^\/([a-zA-Z]+)(?:[\s\u3000]+([\s\S]*))?$/);
        if (!m) return false;
        var cmd = m[1].toLowerCase();
        var arg = (m[2] || '').trim();
        switch (cmd) {
            case 'help': showLocalHelp(); return true;
            case 'roll': rollDice(arg); return true;
            case 'pick': pickOne(arg); return true;
            case 'time': {
                var now = new Date();
                var bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
                var pad = function (n) { return String(n).padStart(2, '0'); };
                showLocalCard(
                    '<div class="enh-dice"><i class="fas fa-clock"></i> <b>' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + '</b>（本地）</div>' +
                    '<div class="enh-cmd-sub">北京时间 ' + pad(bj.getHours()) + ':' + pad(bj.getMinutes()) +
                    ' · ' + bj.getFullYear() + '-' + pad(bj.getMonth() + 1) + '-' + pad(bj.getDate()) + '</div>',
                    'enh-cmd-card');
                return true;
            }
            case 'coin': {
                var heads = Math.random() < 0.5;
                showLocalCard('<div class="enh-dice"><i class="fas fa-coins"></i> <b>' + (heads ? '正面' : '反面') + '</b></div>' +
                    '<div class="enh-cmd-sub">硬币已抛出，命运已注定</div>', 'enh-cmd-card');
                return true;
            }
            default:
                return false;
        }
    }

    // 钩子：renderMarkdown 里调用；/me xxx → 动作气泡的斜体文本
    function renderActionText(content) {
        if (typeof content !== 'string') return null;
        if (content.slice(0, 4).toLowerCase() !== '/me ') return null;
        var body = content.slice(4).trim();
        if (!body) return null;
        return '<span class="msg-action-text">' + esc(body).replace(/\n/g, '<br>') + '</span>';
    }

    // ======================== 8.5 背景 / 排版 / 动画（0.12.0） ========================
    // ---- IndexedDB：背景原图（避免 localStorage 5MB 配额与字符串膨胀） ----
    var IDB_NAME = 'pchat_enh';
    var IDB_STORE = 'media';
    var IDB_KEY = 'chat_bg';

    function idbOpen() {
        return new Promise(function (resolve, reject) {
            if (!window.indexedDB) return reject(new Error('浏览器不支持 IndexedDB'));
            var req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
        });
    }

    function idbRun(mode, fn) {
        return idbOpen().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_STORE, mode);
                var store = tx.objectStore(IDB_STORE);
                var result;
                try {
                    result = fn(store);
                } catch (e) {
                    reject(e);
                    return;
                }
                tx.oncomplete = function () { resolve(result); };
                tx.onerror = function () { reject(tx.error || new Error('IndexedDB 操作失败')); };
                tx.onabort = function () { reject(tx.error || new Error('IndexedDB 操作中止')); };
            });
        });
    }

    function idbPut(key, value) {
        return idbRun('readwrite', function (store) { store.put(value, key); });
    }

    function idbGet(key) {
        return idbOpen().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_STORE, 'readonly');
                var req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { reject(req.error || new Error('IndexedDB 读取失败')); };
            });
        });
    }

    function idbDelete(key) {
        return idbRun('readwrite', function (store) { store.delete(key); });
    }

    // ---- 图片处理：压缩 + 预模糊（都在 canvas 里做，不引入第三方库） ----
    function loadImageFromBlob(blob) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(blob);
            var img = new Image();
            img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败（格式可能不受支持）')); };
            img.src = url;
        });
    }

    async function compressImage(file, maxSide, quality) {
        var img = await loadImageFromBlob(file);
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error('图片尺寸异常');
        var scale = Math.min(1, maxSide / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        var blob = await new Promise(function (resolve) {
            canvas.toBlob(resolve, 'image/jpeg', quality);
        });
        if (!blob) throw new Error('图片压缩失败');
        return blob;
    }

    // 预模糊：画布放大 1.1 倍再模糊，避免边缘发虚出现一圈亮边
    async function makeBlurredBlob(blob, blurPx) {
        var img = await loadImageFromBlob(blob);
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        var supported = true;
        try {
            ctx.filter = 'blur(' + blurPx + 'px)';
            supported = ctx.filter !== 'none' && /blur/.test(ctx.filter);
        } catch (e) {
            supported = false;
        }
        if (!supported) return null;    // 浏览器不支持 canvas filter → 由调用方降级
        var over = Math.max(w, h) * 0.08;
        ctx.drawImage(img, -over, -over, w + over * 2, h + over * 2);
        return await new Promise(function (resolve) {
            canvas.toBlob(resolve, 'image/jpeg', 0.8);
        });
    }

    // ---- 背景应用 ----
    var bgRuntime = { url: null, bytes: 0, originalBytes: 0, blurSupported: true };

    function patternCss(kind) {
        var id = String(kind || '').replace(/^pattern:/, '');
        for (var i = 0; i < BG_PATTERNS.length; i++) {
            if (BG_PATTERNS[i].id === id) return BG_PATTERNS[i].css;
        }
        return '';
    }

    function patternMeta(kind) {
        var id = String(kind || '').replace(/^pattern:/, '');
        for (var i = 0; i < BG_PATTERNS.length; i++) {
            if (BG_PATTERNS[i].id === id) return BG_PATTERNS[i];
        }
        return null;
    }

    function dimLayer() {
        var d = Math.max(0, Math.min(60, Number(state.bgDim) || 0)) / 100;
        return 'linear-gradient(rgba(0,0,0,' + d + '), rgba(0,0,0,' + d + '))';
    }

    function applyBackground() {
        var root = document.documentElement;
        var area = document.querySelector('.message-area');
        var image = '';
        var size = 'cover';
        var repeat = 'no-repeat';

        if (String(state.bgKind).indexOf('pattern:') === 0) {
            var meta = patternMeta(state.bgKind);
            image = meta ? meta.css : '';
            if (meta) {
                size = meta.size || 'auto';
                repeat = meta.repeat || 'repeat';
            }
        } else if (state.bgKind === 'custom' && bgRuntime.url) {
            image = 'url("' + bgRuntime.url + '")';
        } else if (state.bgKind === 'url' && state.bgUrl) {
            image = 'url("' + String(state.bgUrl).replace(/"/g, '%22') + '")';
        }

        if (!image) {
            root.style.removeProperty('--enh-bg-image');
            root.style.removeProperty('--enh-bg-size');
            root.style.removeProperty('--enh-bg-repeat');
            if (area) area.classList.remove('enh-has-bg');
            return;
        }
        root.style.setProperty('--enh-bg-image', dimLayer() + ', ' + image);
        root.style.setProperty('--enh-bg-size', size);
        root.style.setProperty('--enh-bg-repeat', repeat);
        if (area) area.classList.add('enh-has-bg');
    }

    async function refreshCustomBackground() {
        if (bgRuntime.url) {
            try { URL.revokeObjectURL(bgRuntime.url); } catch (e) {}
            bgRuntime.url = null;
        }
        if (state.bgKind !== 'custom') {
            applyBackground();
            return;
        }
        var blob = await idbGet(IDB_KEY);
        if (!blob) {
            state.bgKind = 'none';
            writePref(KEYS.bgKind, 'none');
            applyBackground();
            emitChange();
            return;
        }
        bgRuntime.originalBytes = blob.size;
        var blurred = null;
        if (Number(state.bgBlur) > 0) blurred = await makeBlurredBlob(blob, Number(state.bgBlur));
        bgRuntime.blurSupported = Number(state.bgBlur) === 0 || !!blurred;
        var use = blurred || blob;
        bgRuntime.bytes = use.size;
        bgRuntime.url = URL.createObjectURL(use);
        applyBackground();
        emitChange();
    }

    // ---- 背景操作 API ----
    async function setBackgroundPattern(id) {
        if (!patternCss('pattern:' + id)) throw new Error('未知的纹理');
        state.bgKind = 'pattern:' + id;
        writePref(KEYS.bgKind, state.bgKind);
        await refreshCustomBackground();
        applyBackground();
        emitChange();
    }

    async function setBackgroundUrl(url) {
        var u = String(url || '').trim();
        if (!u) throw new Error('请填写图片地址');
        if (!/^https?:\/\//i.test(u) && !/^\//.test(u)) throw new Error('请填写 http(s) 链接或以 / 开头的路径');
        state.bgUrl = u;
        state.bgKind = 'url';
        writePref(KEYS.bgUrl, u);
        writePref(KEYS.bgKind, 'url');
        await refreshCustomBackground();
        applyBackground();
        emitChange();
    }

    async function setBackgroundFile(file) {
        if (!file) throw new Error('没有选择图片');
        if (!/^image\//.test(file.type || '')) throw new Error('请选择图片文件');
        if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20MB');
        var blob = await compressImage(file, 1600, 0.82);
        await idbPut(IDB_KEY, blob);
        state.bgKind = 'custom';
        writePref(KEYS.bgKind, 'custom');
        await refreshCustomBackground();
        emitChange();
        return { bytes: blob.size, originalBytes: file.size };
    }

    async function clearBackground() {
        if (bgRuntime.url) {
            try { URL.revokeObjectURL(bgRuntime.url); } catch (e) {}
            bgRuntime.url = null;
        }
        try { await idbDelete(IDB_KEY); } catch (e) {}
        state.bgKind = 'none';
        state.bgUrl = '';
        writePref(KEYS.bgKind, 'none');
        writePref(KEYS.bgUrl, '');
        applyBackground();
        emitChange();
    }

    function setBackgroundTuning(blur, dim) {
        if (blur !== undefined) {
            state.bgBlur = Math.max(0, Math.min(12, Math.round(Number(blur) || 0)));
            writePref(KEYS.bgBlur, String(state.bgBlur));
        }
        if (dim !== undefined) {
            state.bgDim = Math.max(0, Math.min(60, Math.round(Number(dim) || 0)));
            writePref(KEYS.bgDim, String(state.bgDim));
        }
        return refreshCustomBackground().then(function () {
            applyBackground();
            emitChange();
            return getBackgroundInfo();
        });
    }

    function getBackgroundInfo() {
        var id = String(state.bgKind || '').replace(/^pattern:/, '');
        var label = '无';
        if (String(state.bgKind).indexOf('pattern:') === 0) {
            var p = BG_PATTERNS.filter(function (x) { return x.id === id; })[0];
            label = p ? p.label : '纹理';
        } else if (state.bgKind === 'custom') {
            label = '自定义图片';
        } else if (state.bgKind === 'url') {
            label = '图片链接';
        }
        return {
            kind: state.bgKind,
            label: label,
            blur: state.bgBlur,
            dim: state.bgDim,
            bytes: bgRuntime.bytes,
            originalBytes: bgRuntime.originalBytes,
            blurSupported: bgRuntime.blurSupported,
            url: state.bgUrl
        };
    }

    // ---- 排版 ----
    function applyBubbleStyle(id, silent) {
        var found = BUBBLE_STYLES.some(function (b) { return b.id === id; }) ? id : 'wechat';
        state.bubble = found;
        document.documentElement.setAttribute('data-bubble', found);
        if (!silent) writePref(KEYS.bubble, found);
        emitChange();
    }

    function applyMaxWidth(id, silent) {
        var found = MAX_WIDTHS.some(function (m) { return m.id === id; }) ? id : 'full';
        state.maxw = found;
        document.documentElement.setAttribute('data-maxw', found);
        if (!silent) writePref(KEYS.maxw, found);
        emitChange();
    }

    function applyAvatarSize(id, silent) {
        var found = AVATAR_SIZES.some(function (a) { return a.id === String(id); }) ? String(id) : '38';
        state.avatar = found;
        document.documentElement.style.setProperty('--enh-avatar-size', found + 'px');
        if (!silent) writePref(KEYS.avatar, found);
        emitChange();
    }

    function relativeTime(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var pad = function (n) { return String(n).padStart(2, '0'); };
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        var now = new Date();
        var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        var t = d.getTime();
        var day = 86400000;
        if (t >= startOfToday) return '今天 ' + hm;
        if (t >= startOfToday - day) return '昨天 ' + hm;
        if (t >= startOfToday - 6 * day) {
            var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
            return wd + ' ' + hm;
        }
        if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
        return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    }

    function applyTimeStyle(id, silent) {
        var found = TIME_STYLES.some(function (t) { return t.id === id; }) ? id : 'full';
        state.time = found;
        if (!silent) writePref(KEYS.time, found);
        emitChange();
        // 已渲染的消息需要重算时间标签：让聊天页重新加载当前会话
        if (!silent && document.getElementById('chatBox') &&
            typeof currentContact !== 'undefined' && currentContact) {
            callGlobal('selectContact', currentContact);
        }
    }

    // 时间标签挂钩：app.js 的 computeTimeLabel 调 formatFullTime，这里换成可切换的实现
    function wrapTimeFormatter() {
        if (!hasGlobal('formatFullTime') || window.__enhTimeWrapped) return;
        var orig = window.formatFullTime;
        window.formatFullTime = function (iso) {
            if (state.time === 'relative') {
                var r = relativeTime(iso);
                if (r) return r;
            }
            return orig.apply(this, arguments);
        };
        window.__enhTimeWrapped = true;
    }

    // ---- 动画 / 性能模式 ----
    function applyAnimation(id, silent) {
        var found = ANIM_STYLES.some(function (a) { return a.id === id; }) ? id : 'default';
        state.anim = found;
        document.documentElement.setAttribute('data-anim', found);
        if (!silent) writePref(KEYS.anim, found);
        emitChange();
    }

    function applyPerformanceMode(on, silent) {
        state.perf = !!on;
        document.documentElement.setAttribute('data-perf', state.perf ? '1' : '0');
        if (!silent) writePref(KEYS.perf, state.perf ? '1' : '0');
        // 性能模式：停掉粒子；退出时恢复用户原先选中的氛围
        if (state.perf) {
            amb.particles = [];
            amb.bursts = [];
            if (amb.ctx) amb.ctx.clearRect(0, 0, amb.w, amb.h);
        } else {
            setAmbience(state.ambience, true);
        }
        emitChange();
    }

    // ======================== 8.6 场景预设（0.13.0） ========================
    // 一个场景 = 明暗 + 配色 + 氛围 + 背景 + 气泡形状 + 字号 + 疏密 + 入场动画
    // 内置 4 套，用户可保存最多 12 套（存 localStorage，不写数据库）。
    var SCENE_KEY = 'enh_scenes';
    var SCENE_PRESETS = [
        {
            id: 'rain-study', name: '雨夜书房', icon: 'fa-cloud-rain',
            theme: 'dark', accent: 'ocean', ambience: 'rain', bg: 'pattern:night',
            bubble: 'round', font: 'normal', density: 'normal', anim: 'default'
        },
        {
            id: 'sakura-noon', name: '樱花午后', icon: 'fa-fan',
            theme: 'light', accent: 'sakura', ambience: 'sakura', bg: 'pattern:dawn',
            bubble: 'round', font: 'normal', density: 'cozy', anim: 'slide'
        },
        {
            id: 'midnight-radio', name: '深夜电台', icon: 'fa-moon',
            theme: 'dark', accent: 'violet', ambience: 'stars', bg: 'pattern:night',
            bubble: 'round', font: 'large', density: 'cozy', anim: 'fade'
        },
        {
            id: 'paper-ink', name: '极简纸墨', icon: 'fa-feather',
            theme: 'light', accent: 'graphite', ambience: 'off', bg: 'pattern:paper',
            bubble: 'square', font: 'normal', density: 'compact', anim: 'none'
        }
    ];

    function readUserScenes() {
        try {
            var raw = JSON.parse(localStorage.getItem(SCENE_KEY) || '[]');
            if (!Array.isArray(raw)) return [];
            return raw.filter(function (s) { return s && s.id && s.name; }).slice(0, 12);
        } catch (e) {
            return [];
        }
    }

    function writeUserScenes(list) {
        try { localStorage.setItem(SCENE_KEY, JSON.stringify((list || []).slice(0, 12))); } catch (e) {}
    }

    function getScenes() {
        return SCENE_PRESETS.concat(readUserScenes().map(function (s) {
            return Object.assign({ user: true, icon: s.icon || 'fa-star' }, s);
        }));
    }

    // 明暗切换的统一入口（聊天页 / 管理中心 / 场景预设共用）
    function applyThemeMode(mode) {
        var html = document.documentElement;
        var found = (mode === 'dark' || mode === 'light' || mode === 'system') ? mode : 'light';
        if (found === 'system') html.removeAttribute('data-theme');
        else html.setAttribute('data-theme', found);
        try { localStorage.setItem('theme', found); } catch (e) {}
        callGlobal('updateFavicon');
        emitChange();
        return found;
    }

    // 只关闭背景，不删除 IndexedDB 里的原图（用户可能只是临时关掉）
    function disableBackground() {
        state.bgKind = 'none';
        writePref(KEYS.bgKind, 'none');
        if (bgRuntime.url) {
            try { URL.revokeObjectURL(bgRuntime.url); } catch (e) {}
            bgRuntime.url = null;
        }
        applyBackground();
        emitChange();
    }

    async function applyScene(id) {
        var scene = getScenes().filter(function (s) { return s.id === id; })[0];
        if (!scene) throw new Error('场景不存在');

        applyThemeMode(scene.theme || 'light');
        applyAccent(scene.accent || 'graphite', true);
        applyBubbleStyle(scene.bubble || 'wechat', true);
        applyFontSize(scene.font || 'normal', true);
        applyDensity(scene.density || 'normal', true);
        applyAnimation(scene.anim || 'default', true);
        setAmbience(scene.ambience || 'off', true);

        if (String(scene.bg || '').indexOf('pattern:') === 0) {
            await setBackgroundPattern(String(scene.bg).replace(/^pattern:/, ''));
        } else if (scene.bg === 'custom' && state.bgKind !== 'custom') {
            state.bgKind = 'custom';
            writePref(KEYS.bgKind, 'custom');
            await refreshCustomBackground();
        } else {
            disableBackground();
        }
        emitChange();
        return scene;
    }

    // 把当前外观存成一个场景
    function saveScene(name) {
        var n = String(name || '').trim().slice(0, 24);
        if (!n) throw new Error('请填写场景名称');
        var list = readUserScenes();
        var scene = {
            id: 'u' + Date.now().toString(36),
            name: n,
            icon: 'fa-star',
            theme: localStorage.getItem('theme') || 'light',
            accent: state.accent,
            ambience: state.ambience,
            bg: state.bgKind,
            bubble: state.bubble,
            font: state.font,
            density: state.density,
            anim: state.anim,
            user: true
        };
        list.unshift(scene);
        writeUserScenes(list);
        emitChange();
        return scene;
    }

    function deleteScene(id) {
        if (!id || String(id).indexOf('u') !== 0) throw new Error('内置场景不能删除');
        writeUserScenes(readUserScenes().filter(function (s) { return s.id !== id; }));
        emitChange();
    }

    // ======================== 9. 偏好设置 API（供统一管理页调用） ========================
    // 0.11.0：设置面板里的四个功能区已迁到独立页面 /studio.html，
    // 本模块只保留「能力」，页面负责「界面」，两者通过下面这组函数通信。

    function setTtsAuto(on) {
        state.ttsAuto = !!on;
        writePref(KEYS.ttsAuto, state.ttsAuto ? '1' : '0');
        if (state.ttsAuto && !ttsSupported()) {
            state.ttsAuto = false;
            writePref(KEYS.ttsAuto, '0');
            return false;
        }
        emitChange();
        return state.ttsAuto;
    }

    function setTtsRate(rate) {
        var n = parseFloat(rate);
        if (!isFinite(n)) n = 1;
        state.ttsRate = Math.max(0.5, Math.min(2, n));
        writePref(KEYS.ttsRate, String(state.ttsRate));
        emitChange();
        return state.ttsRate;
    }

    // 当前浏览器的语音情况（给管理页显示「检测到 6 个中文语音」这类状态）
    function getVoiceInfo() {
        if (!ttsSupported()) return { supported: false, total: 0, chinese: 0, current: '' };
        var voices = window.speechSynthesis.getVoices() || [];
        var zh = voices.filter(function (v) { return /^zh|cmn/i.test(v.lang || ''); });
        var v = tts.voice || pickVoice();
        return {
            supported: true,
            total: voices.length,
            chinese: zh.length,
            current: v ? (v.name || '') + ' (' + (v.lang || '') + ')' : ''
        };
    }

    // 恢复默认：清掉所有 enh_ 偏好，界面回到石墨 / 无氛围 / 标准字号 / 舒适密度
    function resetPreferences() {
        Object.keys(KEYS).forEach(function (k) {
            try { localStorage.removeItem(KEYS[k]); } catch (e) {}
        });
        state.accent = 'graphite';
        state.ambience = 'off';
        state.font = 'normal';
        state.density = 'normal';
        state.ttsAuto = false;
        state.ttsRate = 1;
        state.bgKind = 'none';
        state.bgUrl = '';
        state.bgBlur = 0;
        state.bgDim = 18;
        state.bubble = 'wechat';
        state.maxw = 'full';
        state.avatar = '38';
        state.time = 'full';
        state.anim = 'default';
        state.perf = false;

        applyAccent('graphite', true);
        applyFontSize('normal', true);
        applyDensity('normal', true);
        setAmbience('off', true);
        applyBubbleStyle('wechat', true);
        applyMaxWidth('full', true);
        applyAvatarSize('38', true);
        applyAnimation('default', true);
        applyPerformanceMode(false, true);
        applyTimeStyle('full', true);
        clearBackground();
        stopSpeaking();
        emitChange();
    }

    // ======================== 10. 与既有模块的挂接 ========================
    function wrapExisting() {
        // 10.1 联系人渲染：置顶排序 + 图钉按钮
        if (hasGlobal('renderContacts') && !window.__enhRenderContactsWrapped) {
            var origRenderContacts = window.renderContacts;
            window.renderContacts = function () {
                try { sortContactsByPins(); } catch (e) { console.debug('[enhance] 置顶排序失败:', e); }
                var r = origRenderContacts.apply(this, arguments);
                try { decoratePins(); } catch (e) { console.debug('[enhance] 图钉渲染失败:', e); }
                return r;
            };
            window.__enhRenderContactsWrapped = true;
        }

        // 10.2 AI 回复完成 → 自动朗读
        if (hasGlobal('updateAIMessage') && !window.__enhUpdateAIMessageWrapped) {
            var origUpdateAIMessage = window.updateAIMessage;
            window.updateAIMessage = function (element, content, isComplete) {
                var r = origUpdateAIMessage.apply(this, arguments);
                try {
                    if (isComplete && state.ttsAuto && content && String(content).charAt(0) !== '⚠') {
                        speak(content);
                    }
                } catch (e) { console.debug('[enhance] 自动朗读失败:', e); }
                return r;
            };
            window.__enhUpdateAIMessageWrapped = true;
        }

        // 10.3 消息右键菜单：加「朗读这条」
        if (hasGlobal('buildMessageContextItems') && !window.__enhCtxWrapped) {
            var origBuild = window.buildMessageContextItems;
            window.buildMessageContextItems = function (msgEl) {
                var items = origBuild.apply(this, arguments) || [];
                try {
                    if (msgEl && !msgEl.classList.contains('director') && !msgEl.classList.contains('sent')) {
                        items.splice(1, 0, {
                            icon: 'fa-volume-high',
                            label: '朗读这条',
                            fn: function () { speakMessage(msgEl); }
                        });
                    }
                } catch (e) { console.debug('[enhance] 右键菜单扩展失败:', e); }
                return items;
            };
            window.__enhCtxWrapped = true;
        }
    }

    function bindEvents() {
        // 标题栏 ✨ 按钮
        var pbtn = $('enhPaletteBtn');
        if (pbtn) pbtn.addEventListener('click', function (e) { e.preventDefault(); openPalette(); });

        // 双击 AI 气泡 → 朗读；双击聊天区空白 → 撒花
        if (typeof chatBox !== 'undefined' && chatBox) {
            chatBox.addEventListener('dblclick', function (e) {
                var bubble = e.target.closest('.msg-bubble');
                if (bubble) {
                    var msg = bubble.closest('.message');
                    if (msg && !msg.classList.contains('sent') && !msg.classList.contains('system')) {
                        speakMessage(msg);
                        return;
                    }
                }
                burstAt(e.clientX, e.clientY);
            });
        }

        // 快捷键
        var chatPage = !!document.getElementById('chatBox');
        document.addEventListener('keydown', function (e) {
            var mod = e.ctrlKey || e.metaKey;
            // Ctrl/Cmd + Shift + P：命令面板（只在聊天页启用）
            if (chatPage && mod && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
                e.preventDefault();
                if (palette.open) closePalette();
                else openPalette();
                return;
            }
            // Ctrl/Cmd + Shift + L：朗读最后一条回复（只在聊天页启用）
            if (chatPage && mod && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
                e.preventDefault();
                speakLastReply();
                return;
            }
            if (e.key === 'Escape') {
                if (palette.open) {
                    e.preventDefault();
                    closePalette();
                    return;
                }
                if (tts.speaking) stopSpeaking();
            }
        });

        // 窗口重新可见时恢复粒子漂移计时
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && amb.particles.length) {
                amb.lastTs = 0;
                scheduleFrame();
            }
        });
    }

    // ======================== 11. 启动 ========================
    function initEnhance() {
        // 先应用偏好（配色/字号/密度），再挂 UI，避免闪一下默认样式
        state.accent = readPref(KEYS.accent, 'graphite');
        state.font = readPref(KEYS.font, 'normal');
        state.density = readPref(KEYS.density, 'normal');
        state.ambience = readPref(KEYS.ambience, 'off');
        state.ttsAuto = readPref(KEYS.ttsAuto, '0') === '1';
        state.ttsRate = parseFloat(readPref(KEYS.ttsRate, '1')) || 1;
        // 0.12.0
        state.bgKind = readPref(KEYS.bgKind, 'none');
        state.bgUrl = readPref(KEYS.bgUrl, '');
        state.bgBlur = Math.max(0, Math.min(12, Number(readPref(KEYS.bgBlur, '0')) || 0));
        state.bgDim = Math.max(0, Math.min(60, Number(readPref(KEYS.bgDim, '18')) || 0));
        state.bubble = readPref(KEYS.bubble, 'wechat');
        state.maxw = readPref(KEYS.maxw, 'full');
        state.avatar = readPref(KEYS.avatar, '38');
        state.time = readPref(KEYS.time, 'full');
        state.anim = readPref(KEYS.anim, 'default');
        state.perf = readPref(KEYS.perf, '0') === '1';

        applyAccent(state.accent, true);
        applyFontSize(state.font, true);
        applyDensity(state.density, true);
        applyBubbleStyle(state.bubble, true);
        applyMaxWidth(state.maxw, true);
        applyAvatarSize(state.avatar, true);
        applyAnimation(state.anim, true);
        wrapTimeFormatter();

        wrapExisting();
        bindEvents();
        initTts();
        // 性能模式优先：开启了就不启动粒子；否则按偏好恢复
        applyPerformanceMode(state.perf, true);
        // 自定义背景是异步读 IndexedDB 的（不阻塞首屏）
        refreshCustomBackground().catch(function (e) {
            console.debug('[enhance] 背景加载失败:', e);
        });

        // 首屏若已同步渲染过联系人（缓存命中），补一次置顶排序 + 图钉
        // 注：必须在包装 renderContacts 之后调用，才会走「排序 → 渲染 → 装饰」的完整链路
        try {
            if (getPins().length && typeof contacts !== 'undefined' && Array.isArray(contacts) && contacts.length) {
                callGlobal('renderContacts');
            } else {
                decoratePins();
            }
        } catch (e) {
            console.debug('[enhance] 首屏置顶初始化失败:', e);
        }

        console.log('[PChat] enhance.js 已加载：配色 / 氛围 / 背景 / 排版 / 朗读 / 洞察');
    }

    // 暴露给 app.js 的两个钩子
    window.handleLocalCommand = handleLocalCommand;
    window.renderActionText = renderActionText;
    // 对外 API：聊天页命令面板与统一管理页（studio.html）都通过它操作偏好
    window.enhance = {
        // 常量表（管理页用来生成按钮）
        ACCENTS: ACCENTS,
        AMBIENCES: AMBIENCES,
        FONT_SIZES: FONT_SIZES,
        DENSITIES: DENSITIES,
        // 状态读写
        getState: getState,
        getVoiceInfo: getVoiceInfo,
        setAccent: applyAccent,
        setAmbience: setAmbience,
        setFontSize: applyFontSize,
        setDensity: applyDensity,
        setTtsAuto: setTtsAuto,
        setTtsRate: setTtsRate,
        resetPreferences: resetPreferences,
        // 背景（0.12.0）
        BG_PATTERNS: BG_PATTERNS,
        setBackgroundPattern: setBackgroundPattern,
        setBackgroundUrl: setBackgroundUrl,
        setBackgroundFile: setBackgroundFile,
        setBackgroundTuning: setBackgroundTuning,
        getBackgroundInfo: getBackgroundInfo,
        clearBackground: clearBackground,
        // 排版 / 动画（0.12.0）
        BUBBLE_STYLES: BUBBLE_STYLES,
        MAX_WIDTHS: MAX_WIDTHS,
        AVATAR_SIZES: AVATAR_SIZES,
        TIME_STYLES: TIME_STYLES,
        ANIM_STYLES: ANIM_STYLES,
        setBubbleStyle: applyBubbleStyle,
        setMaxWidth: applyMaxWidth,
        setAvatarSize: applyAvatarSize,
        setTimeStyle: applyTimeStyle,
        setAnimation: applyAnimation,
        setPerformanceMode: applyPerformanceMode,
        // 场景预设（0.13.0）
        getScenes: getScenes,
        applyScene: applyScene,
        saveScene: saveScene,
        deleteScene: deleteScene,
        setThemeMode: applyThemeMode,
        disableBackground: disableBackground,
        // 置顶
        getPins: getPins,
        isPinned: isPinned,
        togglePin: togglePin,
        // 其它
        openPalette: openPalette,
        closePalette: closePalette,
        openInsights: openInsights,
        speak: speak,
        stopSpeaking: stopSpeaking,
        showLocalHelp: showLocalHelp
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEnhance);
    } else {
        initEnhance();
    }
})();
