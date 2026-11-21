// tools/restore-config.mjs
// ============================================================
// 本地 wrangler 配置守卫（0.12.0 新增，本版扩展）
// ------------------------------------------------------------
// 背景一：`npm run dev:offline` 会临时把 wrangler.toml 换成去掉 AI / Vectorize
// 的离线配置（Pages dev 不支持 --config，只能换文件）。正常情况下退出会还原，
// 但如果进程被强杀（Windows 上收不到 SIGINT/SIGTERM），文件会停留在离线版本。
// 背景二：仓库不再提供 wrangler.toml（只提供 wrangler.example.toml），
// 因为仓库里一旦有 wrangler.toml，Pages 控制台的绑定 / 环境变量就会变成只读，
// 与「控制台部署」这条路冲突。本地 dev / 命令行部署需要它时由本脚本生成。
//
// 这个脚本做三件事：
//   1. 不存在 wrangler.toml 时，从 wrangler.example.toml 生成一份（已被 .gitignore 忽略）
//   2. 如果存在 wrangler.toml.dev-backup，就还原并删除备份
//   3. 打印当前配置的关键状态：AI / Vectorize 绑定是否存在、是否还有未替换的占位符
//
// 用法：作为 npm run dev 的 pre 钩子自动执行；
//       也可以手动 `node tools/restore-config.mjs` 检查。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_CONFIG,
  ROOT,
  ensureActiveConfig,
  findPlaceholders,
  isOfflineConfig,
  readConfigText,
} from './wrangler-config.mjs';

const BACKUP = path.join(ROOT, 'wrangler.toml.dev-backup');

// 1) 有配置就先保住它；没有就从模板生成
const backupExists = fs.existsSync(BACKUP);
if (backupExists) {
  fs.copyFileSync(BACKUP, ACTIVE_CONFIG);
  fs.unlinkSync(BACKUP);
  console.log('[restore-config] 检测到离线配置残留，已还原 wrangler.toml');
} else {
  try {
    ensureActiveConfig();
  } catch (e) {
    console.error(`[restore-config] ✗ ${e.message}`);
    process.exit(1);
  }
}

const text = readConfigText();
const hasAi = text.includes('[ai]');
const hasVectorize = text.includes('[[vectorize]]');
const offline = isOfflineConfig();
const placeholders = findPlaceholders();

console.log(`[restore-config] wrangler.toml：AI 绑定 ${hasAi ? '✓' : '✗'} · Vectorize ${hasVectorize ? '✓' : '✗'}`);

if (offline) {
  console.warn('[restore-config] 警告：当前是离线配置，用它部署会丢失 AI / 向量检索绑定。');
  console.warn('[restore-config] 如果要部署完整功能，请先恢复完整的 wrangler.toml。');
}

if (placeholders.length > 0) {
  console.warn(`[restore-config] 注意：本地 wrangler.toml 仍有占位符：${placeholders.join(', ')}`);
  console.warn('[restore-config] 命令行部署 / 本地联调需要把它们换成你自己的资源 ID；');
  console.warn('[restore-config] 只使用控制台部署时不需要这个文件（可以删除，或保持占位符不动）。');
}
