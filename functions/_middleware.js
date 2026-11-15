// functions/_middleware.js —— 全局安全响应头（对所有请求生效，含静态资源）
// ============================================================
// - CSP：限制脚本/样式/连接来源，禁止被 iframe 嵌入（frame-ancestors 'none'）
// - X-Content-Type-Options / X-Frame-Options / Referrer-Policy
// - 不依赖任何外部资源，纯透传；流式响应（SSE）不受影响
// ============================================================

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

export async function onRequest(context) {
  try {
    const response = await context.next();
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
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
