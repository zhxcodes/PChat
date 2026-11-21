// static/js/theme.js
// ========================================
// 主题初始化（默认明亮，优先本地存储）
// 注意：聊天页 app.js 会定义同名 setTheme 覆盖本实现（带丝滑过渡与图标切换）；
// 本文件负责管理后台等页面的首屏主题应用与切换。
// ========================================
document.addEventListener('DOMContentLoaded', () => {
    const themeBtns = document.querySelectorAll('.theme-btn');
    const html = document.documentElement;
    const savedTheme = localStorage.getItem('theme') || 'light';

    function setTheme(theme) {
        if (theme === 'system') {
            html.removeAttribute('data-theme');
        } else {
            html.setAttribute('data-theme', theme);
        }
        localStorage.setItem('theme', theme);
        // 图标随主题切换
        if (window.updateFavicon) window.updateFavicon();
    }

    function updateActiveButton(theme) {
        themeBtns.forEach(btn => {
            if (btn.dataset.theme === theme) btn.classList.add('active');
            else btn.classList.remove('active');
        });
    }

    setTheme(savedTheme);
    updateActiveButton(savedTheme);

    themeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const theme = btn.dataset.theme;
            setTheme(theme);
            updateActiveButton(theme);
        });
    });

    // 系统主题变化时自动同步（仅当选择 system）
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (localStorage.getItem('theme') === 'system') {
            html.removeAttribute('data-theme');
        }
    });
});
