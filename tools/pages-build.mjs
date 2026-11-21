// tools/pages-build.mjs
// ============================================================
// 构建步骤（npm run build）
// ------------------------------------------------------------
// 本项目的前端是随仓库提供的静态资源（static/），没有编译过程。
// 这里只做三件事，目的是让 CI 在「部署前」尽早失败，而不是把坏包传上去：
//   1) 校验静态入口 static/index.html 存在；
//   2) 打印版本号与运行环境（GitHub Actions / 本地），便于对照构建日志；
//   3) 清理不应随静态资源上传的残留（.assetsignore 控制 Pages 上传范围）。
//
// 注意：D1 迁移不在这里执行。迁移由 .github/workflows/deploy.yml 在构建之前
// 单独执行（wrangler d1 migrations apply），账本由 Wrangler 托管。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'static');

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '(unknown)';
  } catch (e) {
    return '(unknown)';
  }
}

function fail(message) {
  console.error(`\n[build] ✗ ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(OUTPUT_DIR)) {
  fail('缺少 static/ 目录：它既是前端资源，也是 wrangler pages deploy 要上传的目录，不能删除。');
}

const indexHtml = path.join(OUTPUT_DIR, 'index.html');
if (!fs.existsSync(indexHtml)) {
  fail(`找不到静态入口 ${indexHtml}。请确认仓库完整。`);
}

// 上传前的最小自检：管理后台与外观中心也在静态目录里，缺了说明仓库不完整
for (const required of ['studio.html', path.join('admin', 'admin.html'), path.join('js', 'app.js')]) {
  if (!fs.existsSync(path.join(OUTPUT_DIR, required))) {
    fail(`缺少静态资源 static/${required}`);
  }
}

// 安全兜底：历史上 static/functions 曾被误放成根目录 functions/ 的副本，
// 一旦再次出现，Pages 会把服务端源码当静态资源公开。这里直接让构建失败。
const leakedFunctions = path.join(OUTPUT_DIR, 'functions');
if (fs.existsSync(leakedFunctions)) {
  fail(
    'static/functions 不允许存在：根目录 functions/ 会被 Wrangler 打包成 Pages Functions，' +
    '而 static/functions 只会被当作静态资源公开。请删除该目录。'
  );
}

console.log('[build] 静态资源就绪：static/（无编译步骤）');
console.log(`[build] 版本：${readPackageVersion()}`);
console.log(`[build] 输出目录：static/（wrangler pages deploy 上传此目录）`);

const facts = [
  ['GITHUB_ACTIONS', process.env.GITHUB_ACTIONS],
  ['GITHUB_REF_NAME', process.env.GITHUB_REF_NAME],
  ['GITHUB_SHA', process.env.GITHUB_SHA],
].filter(([, value]) => value !== undefined && value !== '');

if (facts.length > 0) {
  console.log('[build] 运行环境：GitHub Actions');
  for (const [key, value] of facts) {
    console.log(`[build]   ${key}=${key === 'GITHUB_SHA' ? String(value).slice(0, 7) : value}`);
  }
} else {
  console.log('[build] 运行环境：本地');
}
