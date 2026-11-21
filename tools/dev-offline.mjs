// tools/dev-offline.mjs
// ============================================================
// 离线调试启动器（0.12.0 新增）
// ------------------------------------------------------------
// 背景：wrangler.toml 里声明了 Workers AI / Vectorize 绑定，本地 dev 时
// wrangler 会尝试建立**远程会话**；断网 / Cloudflare 不可达时 `npm run dev`
// 会直接失败（Failed to start the remote proxy session）。
//
// 而 `wrangler pages dev` 不支持 --config 指定别的配置文件，所以这里做
// 一个「临时替换 + 退出还原」的启动器：
//   1. wrangler.toml → 备份为 wrangler.toml.dev-backup
//   2. 用 wrangler.offline.toml（去掉 AI / Vectorize）覆盖 wrangler.toml
//   3. 启动 pages dev
//   4. Ctrl+C 或进程退出时自动还原（异常退出后再次运行会先还原）
//
// 用法：npm run dev:offline
// 正式部署由 GitHub Actions 完成（Direct Upload）；本文件只影响本地 dev
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACTIVE_CONFIG, ensureActiveConfig } from './wrangler-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN = ACTIVE_CONFIG;
const OFFLINE = path.join(ROOT, 'wrangler.offline.toml');
const BACKUP = path.join(ROOT, 'wrangler.toml.dev-backup');
const PORT = process.env.PORT || '8788';

function restore() {
  try {
    if (fs.existsSync(BACKUP)) {
      fs.copyFileSync(BACKUP, MAIN);
      fs.unlinkSync(BACKUP);
      console.log('\n[dev-offline] wrangler.toml 已还原为完整配置');
    }
  } catch (e) {
    console.error('[dev-offline] 还原 wrangler.toml 失败，请手动恢复：', e.message);
  }
}

if (!fs.existsSync(OFFLINE)) {
  console.error('[dev-offline] 找不到 wrangler.offline.toml');
  process.exit(1);
}

// 上一次异常退出留下的备份 → 先还原，避免用离线配置部署
if (fs.existsSync(BACKUP)) {
  console.log('[dev-offline] 检测到上次未还原的备份，先还原 wrangler.toml');
  restore();
}

// 仓库只提供模板：本地没有 wrangler.toml 时先生成一份，否则没法备份/切换
try {
  ensureActiveConfig({ quiet: true });
} catch (e) {
  console.error(`[dev-offline] ✗ ${e.message}`);
  process.exit(1);
}

fs.copyFileSync(MAIN, BACKUP);
// 头部加一行醒目提示：万一被强杀后残留，也能一眼看出这不是完整配置
fs.writeFileSync(
  MAIN,
  '# ⚠️ [dev-offline] 这是 npm run dev:offline 临时生成的离线配置（无 AI / Vectorize）\n' +
  '# 正常退出会自动还原；若看到本行，说明上次被强杀了，跑一次 node tools/restore-config.mjs 还原。\n\n' +
  fs.readFileSync(OFFLINE, 'utf8'),
  'utf8'
);
console.log('[dev-offline] 已切换到离线配置（无 AI / Vectorize 绑定）');

const child = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'pages', 'dev', 'static', '--port', PORT],
  { cwd: ROOT, stdio: 'inherit' }
);

const bye = (signal) => {
  try { child.kill(signal); } catch (e) {}
  restore();
  process.exit(0);
};

process.on('SIGINT', () => bye('SIGINT'));
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGHUP', () => bye('SIGHUP'));
process.on('exit', () => restore());

child.on('exit', (code) => {
  restore();
  process.exit(code || 0);
});
