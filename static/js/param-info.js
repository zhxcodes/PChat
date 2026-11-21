// static/js/param-info.js
// ============================================================
// AI 参数详情：每个参数行右上角的「详情」按钮 → 弹出拟态框
// 说明该参数的默认值、推荐范围与作用。
// 自包含实现（不依赖 modal.js），聊天页与管理后台均可直接引用。
// ============================================================

(function () {
    const PARAM_INFO = {
        temperature: {
            title: '温度 (Temperature)',
            defaultValue: '0.7',
            recommend: '0.5 ~ 1.0（稳定输出用 0.5~0.6，创意输出用 0.8~1.0）',
            desc: '控制回答的随机性与创造性：值越高，回答越天马行空、用词越丰富；值越低，回答越保守、越贴近字面意思。如果 AI 经常跑题、格式不稳定，把它调低一些效果最明显。'
        },
        top_p: {
            title: 'Top P（核采样）',
            defaultValue: '0.9',
            recommend: '0.7 ~ 0.95',
            desc: '从概率最高的候选词中，累加选取总概率达到 Top P 的那部分词。值越小，候选越少、输出越可控；值越大越多样。通常与「温度」二选一调节即可，不建议同时大幅调整两个。'
        },
        max_tokens: {
            title: '最大令牌数 (Max Tokens)',
            defaultValue: '2048',
            recommend: '512 ~ 4096（按单次回复长度需求调整）',
            desc: '单次回复允许输出的最大 token 数上限（中文约 1~2 个汉字 ≈ 1 token）。达到上限会被截断，可点击回复下方的「继续」延伸。写长文、大段描写时可调大；想要短回复可调小以节省额度。'
        },
        frequency_penalty: {
            title: '频率惩罚 (Frequency Penalty)',
            defaultValue: '0',
            recommend: '0 ~ 1（通常 0.1 ~ 0.8，可尝试负值反向鼓励重复）',
            desc: '惩罚“已经反复出现过的词”：值越高，模型越会避免重复使用相同的词汇、句式，减少复读、口头禅和车轱辘话。适合要求“不要老说同一句话”的角色；值越低（如负值）反而更愿意重复强调某些词。'
        },
        presence_penalty: {
            title: '存在惩罚 (Presence Penalty)',
            defaultValue: '0',
            recommend: '0 ~ 1（通常 0.1 ~ 0.8，可尝试负值反向鼓励旧话题）',
            desc: '惩罚“已经出现过的内容与话题”：值越高，模型越倾向于谈论新话题、引入新元素，避免一直围绕已经说过的内容打转。适合希望对话更有新鲜感、剧情持续推进的场景。'
        },
        memory_window: {
            title: '记忆窗口 (Memory Window)',
            defaultValue: '30 条',
            recommend: '10 ~ 100 条（按对话密集程度调整）',
            desc: 'AI 自动提取记忆的节奏：每攒够 N 条聊天消息，就把这一段的对话提炼成一条“长期记忆”，之后 AI 回复时会参考这些记忆。改成新值后会立刻把尚未提取的剩余消息补提成记忆。值越小记忆越细致、提取越频繁；值越大记忆越概括、提取越少。'
        },
        context_window: {
            title: '上下文长度 (Context Window)',
            defaultValue: '20 条',
            recommend: '10 ~ 60 条（按消息长短调整，越多越费额度）',
            desc: '每次回复时发送给 AI 的最近聊天消息条数（不含系统提示词与记忆）。值越大，AI 对近期对话的把握越完整，但消耗的 token 越多、响应更慢、成本更高；值越小越省额度，但 AI 更容易"忘记"较早的内容。'
        }
    };

    // 参数详情拟态框（自包含创建/关闭）
    window.showParamInfo = function (key) {
        const info = PARAM_INFO[key];
        if (!info) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal';
        const box = document.createElement('div');
        box.className = 'modal-content param-info-modal';
        box.innerHTML =
            '<div class="modal-header">' +
            '  <h2><i class="fas fa-circle-info"></i> ' + info.title + '</h2>' +
            '  <button class="close-btn" data-pi-close>&times;</button>' +
            '</div>' +
            '<div class="modal-body">' +
            '  <div class="param-info-row"><span class="pi-label">默认值</span><span class="pi-value">' + info.defaultValue + '</span></div>' +
            '  <div class="param-info-row"><span class="pi-label">推荐范围</span><span class="pi-value">' + info.recommend + '</span></div>' +
            '  <div class="param-info-divider"></div>' +
            '  <div class="param-info-desc">' + info.desc + '</div>' +
            '  <div class="form-actions" style="margin-top:16px;">' +
            '    <button class="btn-accent" data-pi-ok>知道了</button>' +
            '  </div>' +
            '</div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('active'));

        const close = () => {
            overlay.classList.remove('active');
            setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 280);
        };
        box.querySelector('[data-pi-close]').addEventListener('click', close);
        box.querySelector('[data-pi-ok]').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
        });
    };

    // 批量绑定详情按钮：.param-info-btn[data-param="xxx"]
    window.bindParamInfoButtons = function (scope) {
        const root = scope || document;
        root.querySelectorAll('.param-info-btn[data-param]').forEach(btn => {
            btn.addEventListener('click', () => window.showParamInfo(btn.dataset.param));
        });
    };
})();
