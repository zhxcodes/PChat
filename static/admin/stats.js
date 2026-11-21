// static/admin/stats.js
// 管理后台统计页（第 30、31 项）——数据来自 D1 聚合（/api/stats），图表使用 ECharts 6。
// 主题：初始化时按 data-theme 选 dark/default；切换主题后对所有实例 setTheme，
//       并按 ECharts 6 的要求用 { notMerge: true } 重新 setOption。

const EMOTION_COLORS = {
    '开心': '#10b981',
    '平静': '#6366f1',
    '低落': '#3b82f6',
    '焦虑': '#f59e0b',
    '愤怒': '#ef4444',
};
const EMOTION_ORDER = ['开心', '平静', '低落', '焦虑', '愤怒'];

let token = null;
let currentDays = 30;
let lastStatsData = null;
const chartInstances = [];
const chartMap = Object.create(null);

function authHeaders() {
    return { 'Authorization': `Bearer ${token}` };
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

// ---------- 主题 ----------
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
    if (lastStatsData) renderAll(lastStatsData);
}

function ensureChartTheme(chart) {
    const theme = getEchartsTheme();
    if (chart.__pchatTheme === theme) return;
    try {
        chart.setTheme(theme);
        chart.__pchatTheme = theme;
    } catch (e) {
        console.warn('设置图表主题失败:', e && e.message);
    }
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

// ---------- ECharts 实例管理 ----------
function initChart(id) {
    const dom = document.getElementById(id);
    if (!dom) return null;
    if (chartMap[id]) return chartMap[id];

    if (!window.echarts || typeof window.echarts.init !== 'function') {
        dom.innerHTML = '<div class="panel-empty">图表库加载失败，请检查网络后刷新</div>';
        return null;
    }

    const chart = window.echarts.init(dom, getEchartsTheme(), { renderer: 'canvas' });
    chart.__pchatTheme = getEchartsTheme();
    chartMap[id] = chart;
    chartInstances.push(chart);
    return chart;
}

function setChartOption(id, option) {
    const chart = initChart(id);
    if (!chart) return null;
    ensureChartTheme(chart);
    chart.setOption(option, { notMerge: true });
    return chart;
}

function emptyGraphic(text) {
    return {
        type: 'text',
        left: 'center',
        top: 'middle',
        style: { text, fill: '#8a8a8a', fontSize: 12 },
    };
}

// ---------- 数据加载 ----------
async function loadStats() {
    const res = await fetch(`/api/stats?days=${currentDays}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('加载失败');
    return res.json();
}

function renderTotals(d) {
    document.getElementById('totalMessages').textContent = d.totals.total_messages || 0;
    document.getElementById('totalDays').textContent = d.totals.total_days || 0;
    document.getElementById('contactCount').textContent = (d.perContact || []).length;
    const emotionTotal = (d.emotionDistribution || []).reduce((s, e) => s + (e.count || 0), 0);
    document.getElementById('emotionCount').textContent = emotionTotal;
}

// ---------- 图表 ----------
function renderDaily(d) {
    const rows = d.daily || [];
    const hint = document.getElementById('dailyRangeHint');
    if (hint) {
        hint.textContent = rows.length
            ? `（${rows[0].day} ~ ${rows[rows.length - 1].day}）`
            : '';
    }

    setChartOption('dailyChart', {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        grid: { left: 44, right: 18, top: 24, bottom: 30 },
        xAxis: {
            type: 'category',
            boundaryGap: false,
            data: rows.map((r) => String(r.day).slice(5)),
            axisTick: { show: false },
        },
        yAxis: { type: 'value', minInterval: 1 },
        series: [{
            name: '消息数',
            type: 'line',
            smooth: true,
            symbol: 'circle',
            symbolSize: 5,
            data: rows.map((r) => Number(r.count) || 0),
            lineStyle: { width: 2, color: '#6366f1' },
            itemStyle: { color: '#6366f1' },
            areaStyle: { color: 'rgba(99, 102, 241, 0.12)' },
        }],
        graphic: rows.length ? [] : [emptyGraphic(`近 ${d.days || currentDays} 天没有消息`)],
    });
}

function renderEmotionTrend(d) {
    const rows = d.emotionTrend || [];
    const byDay = new Map();
    const usedSet = new Set();
    rows.forEach((r) => {
        if (!byDay.has(r.day)) byDay.set(r.day, {});
        byDay.get(r.day)[r.emotion] = (byDay.get(r.day)[r.emotion] || 0) + r.count;
        usedSet.add(r.emotion);
    });
    const days = [...byDay.keys()].sort();
    const used = [...usedSet].sort((a, b) => {
        const ai = EMOTION_ORDER.indexOf(a);
        const bi = EMOTION_ORDER.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const series = used.map((emotion) => ({
        name: emotion,
        type: 'bar',
        stack: 'emotion',
        barMaxWidth: 18,
        itemStyle: { color: EMOTION_COLORS[emotion] || '#8b8b8b' },
        data: days.map((day) => (byDay.get(day) && byDay.get(day)[emotion]) || 0),
    }));

    setChartOption('emotionChart', {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        legend: { top: 0, type: 'scroll' },
        grid: { left: 44, right: 18, top: 38, bottom: 30 },
        xAxis: { type: 'category', data: days.map((day) => String(day).slice(5)) },
        yAxis: { type: 'value', minInterval: 1 },
        series,
        graphic: rows.length ? [] : [emptyGraphic('暂无情绪数据（对话攒够记忆窗口条数后会自动提炼并标注情绪）')],
    });
}

function renderHorizontalBar(id, rows, colorFn, emptyText) {
    const list = Array.isArray(rows) ? rows : [];
    const ordered = [...list].reverse();
    const labels = ordered.map((r) => r.label);
    const data = ordered.map((r) => ({
        value: Number(r.count) || 0,
        itemStyle: { color: colorFn ? colorFn(r) : '#6366f1' },
    }));

    setChartOption(id, {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 112, right: 50, top: 20, bottom: 20 },
        xAxis: { type: 'value', minInterval: 1 },
        yAxis: {
            type: 'category',
            data: labels,
            axisLabel: { fontSize: 11, width: 96, overflow: 'truncate' },
        },
        series: [{
            name: '消息数',
            type: 'bar',
            barMaxWidth: 16,
            data,
            label: { show: true, position: 'right', fontSize: 10 },
        }],
        graphic: list.length ? [] : [emptyGraphic(emptyText || '暂无数据')],
    });
}

function renderEmotionDistribution(d) {
    const rows = (d.emotionDistribution || []).map((e) => ({
        label: e.emotion,
        count: e.count,
    }));
    renderHorizontalBar('emotionDist', rows, (r) => EMOTION_COLORS[r.label] || '#8b8b8b', '暂无情绪数据');
}

function renderPerContact(d) {
    const rows = (d.perContact || []).map((c) => ({
        label: c.display_name || c.contact_id,
        count: c.count,
    }));
    renderHorizontalBar('perContact', rows, () => '#6366f1', '暂无角色消息数据');
}

function renderHourly(d) {
    const map = new Map((d.hourly || []).map((h) => [Number(h.hour), Number(h.count) || 0]));
    const counts = Array.from({ length: 24 }, (_, hour) => map.get(hour) || 0);
    const total = counts.reduce((sum, n) => sum + n, 0);

    setChartOption('hourlyHeat', {
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'item',
            formatter: (p) => `${p.name}：${p.value} 条`,
        },
        polar: { radius: ['20%', '78%'] },
        angleAxis: {
            type: 'category',
            startAngle: 90,
            data: Array.from({ length: 24 }, (_, hour) => `${hour}时`),
            axisLabel: { fontSize: 9, interval: 1 },
        },
        radiusAxis: { type: 'value', minInterval: 1 },
        series: [{
            name: '消息数',
            type: 'bar',
            coordinateSystem: 'polar',
            data: counts,
            barMaxWidth: 12,
            itemStyle: { color: '#6366f1' },
        }],
        graphic: total > 0 ? [] : [emptyGraphic('暂无活跃时段数据')],
    });
}

function renderAll(d) {
    renderDaily(d);
    renderEmotionTrend(d);
    renderEmotionDistribution(d);
    renderHourly(d);
    renderPerContact(d);
}

async function refresh() {
    try {
        const d = await loadStats();
        lastStatsData = d;
        renderTotals(d);
        renderAll(d);
    } catch (err) {
        lastStatsData = null;
        setChartOption('dailyChart', {
            backgroundColor: 'transparent',
            graphic: [emptyGraphic('加载失败：' + err.message)],
        });
    }
}

function bindEvents() {
    document.querySelectorAll('[data-days]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-days]').forEach(b => b.classList.toggle('active', b === btn));
            currentDays = Number(btn.dataset.days) || 30;
            refresh();
        });
    });
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            const icon = refreshBtn.querySelector('i');
            if (icon) icon.classList.add('fa-spin');
            refresh().finally(() => { if (icon) icon.classList.remove('fa-spin'); });
        });
    }
}

function init() {
    token = sessionStorage.getItem('token');
    if (!token) { window.location.href = '/index.html'; return; }
    initThemeUI();
    bindEvents();
    refresh();
}

document.addEventListener('DOMContentLoaded', init);
