// functions/_middleware.js —— 全局安全响应头（对所有请求生效，含静态资源）
// ============================================================
// - CSP：限制脚本/样式/连接来源，禁止被 iframe 嵌入（frame-ancestors 'none'）
// - X-Content-Type-Options / X-Frame-Options / Referrer-Policy
// - 不依赖任何外部资源，纯透传；流式响应（SSE）不受影响
// - Turnstile 站点密钥不再硬编码：从环境变量 TURNSTILE_SITE_KEY 注入到 index.html 的
//   <meta name="turnstile-site-key">，静态 HTML 里不再硬编码（开源部署各配各的）。
//   只有 HTML 页面会读 body 做替换，API / SSE 等响应仍然纯流式透传。
// ============================================================

import { getTurnstileState } from './_lib.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    // marked / DOMPurify 由 jsdelivr 提供，font-awesome 由 cdnjs 提供
    // 第 9 项：Turnstile 组件与其校验接口来自 challenges.cloudflare.com
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://cdnjs.cloudflare.com",
    "connect-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://challenges.cloudflare.com data: blob:",
    "frame-src https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

// 需要注入站点密钥的页面（登录页也是唯一渲染 Turnstile 的页面）
const TURNSTILE_PAGES = new Set(['/', '/index.html']);
// 精确匹配 index.html 里那一行 meta，只替换 content 的值
const TURNSTILE_META_RE = /(<meta\s+name="turnstile-site-key"\s+content=")([^"]*)(")/i;

// 未启用时原样返回（静态文件里 content 为空，前端 turnstile.js 见空即关闭），
// 因此「删掉 Functions 直接静态托管」也会自动降级为不启用。
async function injectTurnstileSiteKey(env, request, response) {
  // 只处理正常的 GET 200 HTML；HEAD / 304 / 重定向等不读 body
  if (request.method !== 'GET') return response;
  if (!response || response.status !== 200) return response;

  let pathname = '';
  try {
    pathname = new URL(request.url).pathname;
  } catch (e) {
    return response;
  }
  if (!TURNSTILE_PAGES.has(pathname)) return response;
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;

  let state;
  try {
    state = await getTurnstileState(env);
  } catch (e) {
    console.warn('读取 Turnstile 配置失败（本次不下发站点密钥）:', e.message);
    return response;
  }
  if (!state.active) return response;

  let html;
  try {
    html = await response.text();
  } catch (e) {
    return response;
  }

  const out = html.replace(TURNSTILE_META_RE, (_m, head, _old, tail) => head + state.siteKey + tail);
  const headers = new Headers(response.headers);
  headers.delete('content-length'); // 长度变了，交给运行时重算
  headers.delete('etag');
  // 内容随部署环境变量变化，别让浏览器拿旧 HTML 里的旧密钥
  headers.set('Cache-Control', 'no-cache');
  return new Response(out, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function onRequest(context) {
  try {
    const response = await context.next();
    const finalResponse = await injectTurnstileSiteKey(context.env, context.request, response);
    const headers = new Headers(finalResponse.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(finalResponse.body, {
      status: finalResponse.status,
      statusText: finalResponse.statusText,
      headers,
    });
  } catch (err) {
    console.error('全局中间件错误:', err);
    return new Response(JSON.stringify({ error: '服务器内部错误' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...SECURITY_HEADERS,
      },
    });
  }
}
