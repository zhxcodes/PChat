// static/js/enhance-cinema.js
// ============================================================
// 「好玩」扩展（0.13.0）
// ------------------------------------------------------------
//   1. 时光机：挑一天，按顺序重播当天的对话（可暂停 / 倍速 / 重播）
//   2. 分享卡片：把对话渲染成一张 PNG（Canvas 手绘，不依赖任何第三方库）
//
// 依赖：
//   - 聊天页的全局：currentContact / chatBox / renderMarkdown / escapeHtml / showToast
//   - enhance.js：window.enhance（配色变量、缩放偏好等）
//   - 后端：GET /api/ai/replay（见 functions/api/ai/replay.js）
//
// 本文件只挂在聊天页（index.html），管理中心不加载。
// ============================================================
(function () {
    'use strict';

    if (!document.getElementById('chatBox')) return; // 只在聊天页启用

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

    function toast(msg, type) {
        if (typeof showToast === 'function') showToast(msg, type || 'info');
    }

    function token() {
        try { return sessionStorage.getItem('token') || ''; } catch (e) { return ''; }
    }

    function contactInfo() {
        if (typeof currentContact === 'undefined' || !currentContact) return null;
        return currentContact;
    }

    function timeHM(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function mdToHtml(md) {
        if (typeof renderMarkdown === 'function') return renderMarkdown(md);
        return esc(md).replace(/\n/g, '<br>');
    }

    // ============================================================
    // 1. 时光机
    // ============================================================
    var replay = {
        modal: null,
        days: [],
        day: '',
        messages: [],
        idx: 0,
        timer: null,
        paused: false,
        speed: 1,
        playing: false,
        loading: false
    };

    function buildReplayModal() {
        if (replay.modal) return replay.modal;
        var overlay = el('div', 'modal enh-replay-modal');
        var content = el('div', 'modal-content enh-replay-content');
        content.innerHTML =
            '<div class="modal-header">' +
            '  <h2><i class="fas fa-clock-rotate-left"></i> 时光机</h2>' +
            '  <button class="close-btn" data-close>&times;</button>' +
            '</div>' +
            '<div class="modal-body">' +
            '  <p class="settings-hint" style="text-align:left;margin:0 0 10px;">挑一天，把当天的对话按顺序重播一遍。</p>' +
            '  <div class="replay-days" id="replayDays"><span class="replay-hint">加载中…</span></div>' +
            '  <div class="replay-controls">' +
            '    <input type="date" id="replayDate" class="replay-date-input">' +
            '    <button class="btn-accent" type="button" id="replayPlay"><i class="fas fa-play"></i> 播放这一天</button>' +
            '    <span class="replay-hint" id="replayHint"></span>' +
            '  </div>' +
            '  <div class="replay-stage" id="replayStage" hidden>' +
            '    <div class="replay-head">' +
            '      <b id="replayTitle"></b>' +
            '      <span id="replayProgress"></span>' +
            '    </div>' +
            '    <div class="replay-list" id="replayList"></div>' +
            '    <div class="replay-actions">' +
            '      <button class="btn-secondary" type="button" id="replayPause"><i class="fas fa-pause"></i> 暂停</button>' +
            '      <button class="btn-secondary" type="button" id="replaySpeed">1x</button>' +
            '      <button class="btn-secondary" type="button" id="replayRestart"><i class="fas fa-rotate-right"></i> 重播</button>' +
            '      <button class="btn-secondary" type="button" id="replayExit">收起</button>' +
            '    </div>' +
            '  </div>' +
            '</div>';
        overlay.appendChild(content);
        document.body.appendChild(overlay);

        content.querySelector('[data-close]').addEventListener('click', closeReplay);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeReplay();
        });
        $('replayPlay').addEventListener('click', function () {
            var d = $('replayDate');
            playDay(d && d.value ? d.value : replay.day);
        });
        $('replayPause').addEventListener('click', togglePause);
        $('replaySpeed').addEventListener('click', cycleSpeed);
        $('replayRestart').addEventListener('click', function () {
            if (replay.messages.length) startPlayback();
        });
        $('replayExit').addEventListener('click', function () {
            stopPlayback();
            var stage = $('replayStage');
            if (stage) stage.hidden = true;
        });

        replay.modal = overlay;
        return overlay;
    }

    async function openReplay() {
        var contact = contactInfo();
        if (!contact) { toast('先选一个角色', 'info'); return; }
        var modal = buildReplayModal();
        if (typeof showModal === 'function') showModal(modal);
        else modal.classList.add('active');

        var box = $('replayDays');
        if (box) box.innerHTML = '<span class="studio-hint">加载中…</span>';

        var t = token();
        if (!t) {
            if (box) box.innerHTML = '<span class="studio-hint">未登录，无法读取历史。</span>';
            return;
        }
        try {
            var res = await fetch('/api/ai/replay?contact=' + encodeURIComponent(contact.contact_id), {
                headers: { Authorization: 'Bearer ' + t }
            });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            replay.days = data.days || [];
            renderDayChips();
        } catch (e) {
            if (box) box.innerHTML = '<span class="studio-hint">读取失败：' + esc(e.message) + '</span>';
        }
    }

    function renderDayChips() {
        var box = $('replayDays');
        if (!box) return;
        if (!replay.days.length) {
            box.innerHTML = '<span class="studio-hint">这个角色还没有可回放的历史。</span>';
            return;
        }
        box.innerHTML = '';
        replay.days.slice(0, 14).forEach(function (d, i) {
            var chip = el('button', 'replay-chip' + (i === 0 ? ' active' : ''));
            chip.type = 'button';
            chip.dataset.day = d.day;
            chip.innerHTML = '<b>' + esc(d.day) + '</b><span>' + d.count + ' 条</span>';
            chip.addEventListener('click', function () {
                Array.prototype.forEach.call(box.querySelectorAll('.replay-chip'), function (c) {
                    c.classList.toggle('active', c === chip);
                });
                var input = $('replayDate');
                if (input) input.value = d.day;
                replay.day = d.day;
                playDay(d.day);
            });
            box.appendChild(chip);
        });
        replay.day = replay.days[0].day;
        var input = $('replayDate');
        if (input && !input.value) input.value = replay.day;
    }

    function closeReplay() {
        stopPlayback();
        if (replay.modal && typeof hideModal === 'function') hideModal(replay.modal);
        else if (replay.modal) replay.modal.classList.remove('active');
    }

    async function playDay(day) {
        if (!day) { toast('先选一天', 'info'); return; }
        var contact = contactInfo();
        if (!contact) return;
        var hint = $('replayHint');
        if (hint) hint.textContent = '读取中…';
        try {
            var res = await fetch('/api/ai/replay?contact=' + encodeURIComponent(contact.contact_id) +
                '&date=' + encodeURIComponent(day), { headers: { Authorization: 'Bearer ' + token() } });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            replay.messages = data.messages || [];
            replay.day = day;
            if (!replay.messages.length) {
                if (hint) hint.textContent = '这一天没有消息';
                return;
            }
            if (hint) hint.textContent = '';
            var title = $('replayTitle');
            if (title) title.textContent = (contact.display_name || contact.contact_id) + ' · ' + day;
            startPlayback();
        } catch (e) {
            if (hint) hint.textContent = '读取失败：' + e.message;
        }
    }

    function startPlayback() {
        stopPlayback();
        var list = $('replayList');
        var stage = $('replayStage');
        if (!list || !stage) return;
        list.innerHTML = '';
        stage.hidden = false;
        replay.idx = 0;
        replay.paused = false;
        replay.playing = true;
        updatePauseBtn();
        step();
    }

    function updatePauseBtn() {
        var btn = $('replayPause');
        if (!btn) return;
        btn.innerHTML = replay.paused
            ? '<i class="fas fa-play"></i> 继续'
            : '<i class="fas fa-pause"></i> 暂停';
    }

    function step() {
        if (!replay.playing || replay.paused) return;
        var list = $('replayList');
        if (!list) return;
        if (replay.idx >= replay.messages.length) {
            replay.playing = false;
            var hint = $('replayHint');
            if (hint) hint.textContent = '播放完毕，共 ' + replay.messages.length + ' 条';
            return;
        }
        var m = replay.messages[replay.idx];
        replay.idx += 1;
        appendReplayMessage(list, m);
        updateProgress();
        replay.timer = setTimeout(step, Math.round(820 / replay.speed));
    }

    function appendReplayMessage(list, m) {
        var isUser = m.role === 'user';
        var contact = contactInfo();
        var div = el('div', 'message ' + (isUser ? 'sent' : 'received') + ' replay-msg');
        var avatar = el('div', 'msg-avatar');
        if (isUser) {
            avatar.innerHTML = '<i class="fas fa-user"></i>';
        } else if (contact && contact.avatar) {
            avatar.innerHTML = '<img src="' + esc(contact.avatar) + '" alt="">';
        } else {
            avatar.innerHTML = '<i class="fas fa-robot"></i>';
        }
        var bubble = el('div', 'msg-bubble');
        var text = el('div', 'message-text markdown-body');
        text.innerHTML = mdToHtml(String(m.content || ''));
        bubble.appendChild(text);
        var row = el('div', 'msg-row');
        row.appendChild(avatar);
        row.appendChild(bubble);
        div.appendChild(row);
        var t = el('div', 'replay-time', timeHM(m.created_at));
        div.insertBefore(t, row);
        list.appendChild(div);
        // 自动滚到底部（.replay-list 自己是滚动容器）
        list.scrollTop = list.scrollHeight;
    }

    function updateProgress() {
        var p = $('replayProgress');
        if (p) p.textContent = replay.idx + ' / ' + replay.messages.length;
    }

    function togglePause() {
        if (!replay.messages.length) return;
        if (!replay.playing) {
            replay.playing = true;
            replay.paused = false;
            updatePauseBtn();
            step();
            return;
        }
        replay.paused = !replay.paused;
        if (!replay.paused) step();
        updatePauseBtn();
    }

    function cycleSpeed() {
        replay.speed = replay.speed === 1 ? 2 : (replay.speed === 2 ? 3 : 1);
        var btn = $('replaySpeed');
        if (btn) btn.textContent = replay.speed + 'x';
        if (replay.playing && !replay.paused) {
            clearTimeout(replay.timer);
            step();
        }
    }

    function stopPlayback() {
        replay.playing = false;
        replay.paused = false;
        if (replay.timer) { clearTimeout(replay.timer); replay.timer = null; }
    }

    // ============================================================
    // 2. 分享卡片
    // ============================================================
    var card = {
        modal: null,
        messages: [],
        dark: false
    };

    function readColor(prop, fallback) {
        try {
            var v = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
            if (!v) return fallback;
            var m = v.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/);
            if (!m) return fallback;
            return m[0];
        } catch (e) {
            return fallback;
        }
    }

    var colorProbe = null;
    function toRGB(color) {
        if (!color) return [0, 0, 0];
        if (!colorProbe) {
            colorProbe = document.createElement('span');
            colorProbe.style.display = 'none';
            document.body.appendChild(colorProbe);
        }
        colorProbe.style.color = '';
        colorProbe.style.color = color;
        var v = getComputedStyle(colorProbe).color;
        var m = v.match(/-?\d+(\.\d+)?/g);
        return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0];
    }

    function rgba(rgb, a) {
        return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + a + ')';
    }

    function plainText(md) {
        return String(md || '')
            .replace(/^\/me\s+/i, '')   // 动作气泡的 /me 前缀不进卡片正文
            .replace(/```[\s\S]*?```/g, function (m) { return m.replace(/```[a-zA-Z]*\n?/g, ''); })
            .replace(/`([^`]*)`/g, '$1')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/^#{1,6}\s*/gm, '')
            .replace(/^\s*>\s?/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // 按字符宽度换行（对中文友好；同时尊重显式换行）
    function wrapText(ctx, text, maxWidth) {
        var lines = [];
        String(text).split('\n').forEach(function (paragraph) {
            if (!paragraph) { lines.push(''); return; }
            var line = '';
            for (var i = 0; i < paragraph.length; i++) {
                var ch = paragraph[i];
                var test = line + ch;
                if (ctx.measureText(test).width > maxWidth && line) {
                    lines.push(line);
                    line = ch;
                } else {
                    line = test;
                }
            }
            if (line) lines.push(line);
        });
        return lines;
    }

    function drawCard(messages, opts) {
        var dark = !!opts.dark;
        var contact = contactInfo();
        var scale = 2;
        var W = 760;
        var pad = 40;
        var bubbleMax = 520;
        var fontBody = '16px "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
        var fontSmall = '12px "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
        var fontName = '600 20px "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

        // 颜色：跟随当前主题的 CSS 变量（导出的卡片和界面观感一致）
        var bg = dark ? '#15171b' : '#ffffff';
        var fg = dark ? '#ececec' : '#1c1c1c';
        var muted = dark ? '#8e949c' : '#8b8b8b';
        var line = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
        var sentBgRaw = readColor('--bubble-sent', '#262626');
        var sentTextRaw = readColor('--bubble-sent-text', '#ffffff');
        var recvBgRaw = readColor('--bubble-received', dark ? '#1f1f1f' : '#ffffff');
        var accentRaw = readColor('--enh-accent', '#333333');
        if (dark) {
            // 深色卡片：气泡用同一套辅色，但把 received 压暗，避免整张卡发白
            recvBgRaw = '#202226';
            fg = '#ececec';
            muted = '#8e949c';
            line = 'rgba(255,255,255,0.10)';
        }

        var sentBg = toRGB(sentBgRaw);
        var sentText = toRGB(sentTextRaw);
        var recvBg = toRGB(recvBgRaw);
        var accent = toRGB(accentRaw);
        var fgRGB = toRGB(fg);
        var mutedRGB = toRGB(muted);

        // 先测量：算出总高度
        var measureCanvas = document.createElement('canvas');
        var mctx = measureCanvas.getContext('2d');
        mctx.font = fontBody;
        var layout = [];
        var contentH = 0;
        messages.forEach(function (m) {
            var isUser = m.role === 'user';
            var text = plainText(m.content);
            var lines = wrapText(mctx, text, bubbleMax - 36);
            var h = Math.max(46, lines.length * 24 + 26);
            layout.push({ m: m, lines: lines, h: h, isUser: isUser });
            contentH += h + 14;
        });

        var headerH = 96;
        var footerH = 74;
        var H = Math.max(320, headerH + contentH + footerH + pad);

        var canvas = document.createElement('canvas');
        canvas.width = W * scale;
        canvas.height = H * scale;
        var ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        // 背景
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
        // 顶部一条主题色渐变
        var grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, rgba(accent, 0.85));
        grad.addColorStop(1, rgba(accent, 0.25));
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, 5);

        // 头部
        ctx.fillStyle = fg;
        ctx.font = fontName;
        var name = (contact && (contact.display_name || contact.contact_id)) || '对话';
        ctx.fillText(name, pad, 52);
        ctx.font = fontSmall;
        ctx.fillStyle = rgba(mutedRGB, 1);
        ctx.fillText(layout.length ? (layout[0].m.created_at || '').slice(0, 16).replace('T', ' ') : '', pad, 74);
        ctx.textAlign = 'right';
        ctx.fillStyle = rgba(accent, 1);
        ctx.fillText('Personal Chat', W - pad, 52);
        ctx.textAlign = 'left';

        ctx.strokeStyle = line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad, 88);
        ctx.lineTo(W - pad, 88);
        ctx.stroke();

        // 消息
        var y = headerH + 8;
        layout.forEach(function (item) {
            var bubbleW = 0;
            ctx.font = fontBody;
            item.lines.forEach(function (l) {
                bubbleW = Math.max(bubbleW, ctx.measureText(l).width);
            });
            bubbleW = Math.min(bubbleMax, bubbleW + 36);
            var bubH = item.h;
            var x = item.isUser ? W - pad - bubbleW : pad;

            // 气泡底
            var r = 16;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(x, y, bubbleW, bubH, r);
            } else {
                ctx.rect(x, y, bubbleW, bubH);
            }
            ctx.fillStyle = item.isUser ? rgba(sentBg, 1) : rgba(recvBg, 1);
            ctx.fill();
            if (!item.isUser) {
                ctx.strokeStyle = line;
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            // 文本
            ctx.fillStyle = item.isUser ? rgba(sentText, 1) : rgba(fgRGB, 1);
            ctx.font = fontBody;
            item.lines.forEach(function (l, i) {
                ctx.fillText(l, x + 18, y + 28 + i * 24);
            });

            // 时间（气泡外的小字）
            ctx.font = fontSmall;
            ctx.fillStyle = rgba(mutedRGB, 0.9);
            var hm = (item.m.created_at || '').slice(11, 16) || '';
            if (item.isUser) {
                ctx.textAlign = 'right';
                ctx.fillText(hm, x - 10, y + 20);
                ctx.textAlign = 'left';
            } else {
                ctx.fillText(hm, x + bubbleW + 10, y + 20);
            }

            y += bubH + 14;
        });

        // 底部
        ctx.strokeStyle = line;
        ctx.beginPath();
        ctx.moveTo(pad, H - 50);
        ctx.lineTo(W - pad, H - 50);
        ctx.stroke();
        ctx.font = fontSmall;
        ctx.fillStyle = rgba(mutedRGB, 1);
        ctx.fillText('由 Personal Chat 生成 · ' + new Date().toLocaleDateString(), pad, H - 26);
        ctx.textAlign = 'right';
        ctx.fillText('v' + (window.APP_VERSION || ''), W - pad, H - 26);
        ctx.textAlign = 'left';

        return canvas;
    }

    function buildCardModal() {
        if (card.modal) return card.modal;
        var overlay = el('div', 'modal enh-card-modal');
        var content = el('div', 'modal-content enh-card-content');
        content.innerHTML =
            '<div class="modal-header">' +
            '  <h2><i class="fas fa-image"></i> 分享卡片</h2>' +
            '  <button class="close-btn" data-close>&times;</button>' +
            '</div>' +
            '<div class="modal-body">' +
            '  <div class="enh-card-preview" id="cardPreviewBox"></div>' +
            '  <div class="form-actions" style="margin-top:14px;">' +
            '    <button class="btn-secondary" type="button" id="cardTheme">深色卡片</button>' +
            '    <button class="btn-accent" type="button" id="cardDownload"><i class="fas fa-download"></i> 下载 PNG</button>' +
            '  </div>' +
            '</div>';
        overlay.appendChild(content);
        document.body.appendChild(overlay);

        content.querySelector('[data-close]').addEventListener('click', function () {
            if (typeof hideModal === 'function') hideModal(overlay);
            else overlay.classList.remove('active');
        });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) {
                if (typeof hideModal === 'function') hideModal(overlay);
                else overlay.classList.remove('active');
            }
        });
        $('cardTheme').addEventListener('click', function () {
            card.dark = !card.dark;
            $('cardTheme').textContent = card.dark ? '浅色卡片' : '深色卡片';
            renderCardPreview();
        });
        $('cardDownload').addEventListener('click', downloadCard);
        card.modal = overlay;
        return overlay;
    }

    function renderCardPreview() {
        var box = $('cardPreviewBox');
        if (!box) return;
        var canvas = drawCard(card.messages, { dark: card.dark });
        box.innerHTML = '';
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.display = 'block';
        box.appendChild(canvas);
        card.canvas = canvas;
    }

    function openShareCard(messages) {
        if (!messages || !messages.length) { toast('没有可制作的消息', 'info'); return; }
        card.messages = messages.slice(0, 8);
        card.dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var modal = buildCardModal();
        var btn = $('cardTheme');
        if (btn) btn.textContent = card.dark ? '浅色卡片' : '深色卡片';
        renderCardPreview();
        if (typeof showModal === 'function') showModal(modal);
        else modal.classList.add('active');
    }

    function downloadCard() {
        var canvas = card.canvas;
        if (!canvas) return;
        canvas.toBlob(function (blob) {
            if (!blob) { toast('生成图片失败', 'error'); return; }
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            var contact = contactInfo();
            var stamp = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = 'pchat-card_' + ((contact && (contact.display_name || contact.contact_id)) || 'chat') + '_' + stamp + '.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
            toast('卡片已开始下载', 'success');
        }, 'image/png');
    }

    // ---- 入口 ----
    function messageToPlain(msgEl) {
        if (!msgEl) return null;
        var raw = msgEl.dataset && msgEl.dataset.rawContent ? msgEl.dataset.rawContent : '';
        if (!raw) {
            var t = msgEl.querySelector('.message-text');
            raw = t ? t.textContent : '';
        }
        return {
            role: msgEl.classList.contains('sent') ? 'user' : 'assistant',
            content: raw,
            created_at: (msgEl.dataset && msgEl.dataset.createdAt) || new Date().toISOString()
        };
    }

    function shareCardForMessage(msgEl) {
        var one = messageToPlain(msgEl);
        if (!one) { toast('无法读取这条消息', 'error'); return; }
        // 顺手带上它前面那条我的问题，读起来更完整
        var list = [one];
        if (one.role === 'assistant') {
            var prev = msgEl.previousElementSibling;
            while (prev && !prev.classList.contains('message')) prev = prev.previousElementSibling;
            if (prev && prev.classList.contains('sent')) {
                var p = messageToPlain(prev);
                if (p) list.unshift(p);
            }
        }
        openShareCard(list);
    }

    function shareLastMessage() {
        if (typeof chatBox === 'undefined' || !chatBox) return;
        var nodes = chatBox.querySelectorAll('.message:not(.system):not(.director)');
        var last = nodes[nodes.length - 1];
        if (!last) { toast('还没有可分享的消息', 'info'); return; }
        shareCardForMessage(last);
    }

    // ---- 右键菜单：加「生成分享卡片」 ----
    function wrapContextMenu() {
        if (typeof window.buildMessageContextItems !== 'function' || window.__cinemaCtxWrapped) return;
        var orig = window.buildMessageContextItems;
        window.buildMessageContextItems = function (msgEl) {
            var items = orig.apply(this, arguments) || [];
            try {
                if (msgEl && !msgEl.classList.contains('director') && !msgEl.classList.contains('system')) {
                    items.push({
                        icon: 'fa-image',
                        label: '生成分享卡片',
                        fn: function () { shareCardForMessage(msgEl); }
                    });
                }
            } catch (e) {
                console.debug('[cinema] 右键菜单扩展失败:', e);
            }
            return items;
        };
        window.__cinemaCtxWrapped = true;
    }

    function bindEntry() {
        var btn = document.getElementById('replayBtn');
        if (btn) btn.addEventListener('click', function (e) { e.preventDefault(); openReplay(); });
    }

    // ---- 对外暴露 ----
    window.openReplay = openReplay;
    window.shareLastMessage = shareLastMessage;
    if (window.enhance) {
        window.enhance.openReplay = openReplay;
        window.enhance.shareLastMessage = shareLastMessage;
        window.enhance.shareCardForMessage = shareCardForMessage;
    }

    function init() {
        bindEntry();
        wrapContextMenu();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
