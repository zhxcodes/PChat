// tools/wrangler-config.mjs
// ============================================================
// 本地 wrangler 配置的统一入口
// ------------------------------------------------------------
// 约定（与在线手册的部署说明对应）：
//   - 仓库只提供模板 wrangler.example.toml，里面没有任何真实 ID / 密钥；
//   - 控制台（Git 集成）部署不需要 wrangler.toml，D1 / KV 绑定都在控制台配；
//   - 本地 dev 与命令行部署需要 wrangler.toml，由本模块从模板自动生成，
//     生成出来的文件已被 .gitignore 忽略，填了真实 ID 也不会被提交。
//
// 这样做的原因：Pages 项目一旦读到仓库里的 wrangler.toml，就会以它作为配置来源，
// 控制台里的绑定 / 环境变量随之变成只读。让配置文件留在一个被忽略的本地文件里，
// 两种部署方式才不会互相干扰。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const ACTIVE_CONFIG = path.join(ROOT, 'wrangler.toml');
export const TEMPLATE_CONFIG = path.join(ROOT, 'wrangler.example.toml');

// 仓库模板里的占位符（生成后仍需开发者自己替换）
const PLACEHOLDER_RE = /REPLACE_WITH_[A-Z0-9_]+/g;

export function readConfigText(file) {
  const target = file || ACTIVE_CONFIG;
  if (!fs.existsSync(target)) return '';
  return fs.readFileSync(target, 'utf8');
}

export function findPlaceholders(file) {
  const text = readConfigText(file);
  const matches = text.match(PLACEHOLDER_RE);
  return matches ? Array.from(new Set(matches)) : [];
}

/**
 * 确保本地存在 wrangler.toml：
 *   - 已存在：原样保留（可能已被离线调试换成精简版，交给 restore-config 处理）
 *   - 不存在：从 wrangler.example.toml 复制一份
 * @returns {{ created: boolean, path: string }}
 */
export function ensureActiveConfig(options) {
  const opts = options || {};
  if (fs.existsSync(ACTIVE_CONFIG)) {
    return { created: false, path: ACTIVE_CONFIG };
  }
  if (!fs.existsSync(TEMPLATE_CONFIG)) {
    throw new Error(
      '缺少 wrangler.example.toml：命令行部署 / 本地开发需要它作为配置模板；控制台部署不需要 wrangler.toml。'
    );
  }
  fs.copyFileSync(TEMPLATE_CONFIG, ACTIVE_CONFIG);
  if (!opts.quiet) {
    console.log('[wrangler-config] 未检测到 wrangler.toml，已从 wrangler.example.toml 生成本地配置');
    console.log('[wrangler-config] 该文件已被 .gitignore 忽略；请把其中的占位符换成你自己的资源 ID。');
  }
  return { created: true, path: ACTIVE_CONFIG };
}

export function isOfflineConfig(file) {
  const text = readConfigText(file);
  return text.includes('[dev-offline]') || !text.includes('[ai]') || !text.includes('[[vectorize]]');
}
