// static/js/storage.js
// ========================================
// 本地缓存管理（联系人 + 聊天记录）
// 全部为全局函数，供 app.js / roles.js 调用。
// ========================================

const CACHE_KEYS = {
  CONTACTS: 'pchat_contacts',
  CONTACTS_TIME: 'pchat_contacts_time',
  CHAT_HISTORY: 'pchat_history',
};

const CONTACTS_CACHE_DURATION = 60 * 60 * 1000; // 1小时
const HISTORY_MAX_ITEMS = 50;                   // 每会话保留最近 50 条

// ========================================
// 联系人列表（1 小时缓存）
// ========================================
function getContactsCache() {
  const raw = localStorage.getItem(CACHE_KEYS.CONTACTS);
  const time = parseInt(localStorage.getItem(CACHE_KEYS.CONTACTS_TIME) || '0');
  if (!raw || Date.now() - time > CONTACTS_CACHE_DURATION) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function setContactsCache(contacts) {
  localStorage.setItem(CACHE_KEYS.CONTACTS, JSON.stringify(contacts));
  localStorage.setItem(CACHE_KEYS.CONTACTS_TIME, String(Date.now()));
}

// ========================================
// 聊天记录（按登录会话版本隔离，保留最近 50 条）
// 存储结构：{ version: <sessionVersion>, messages: [...] }
// ========================================

// 读取当前会话的聊天缓存；版本不匹配时返回空并清除
function getChatHistoryCache(contactId) {
  const sessionVersion = sessionStorage.getItem('sessionVersion') || '';
  const key = `${CACHE_KEYS.CHAT_HISTORY}_${contactId}`;
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (data.version !== sessionVersion) {
      localStorage.removeItem(key);
      return [];
    }
    return Array.isArray(data.messages) ? data.messages : [];
  } catch {
    localStorage.removeItem(key);
    return [];
  }
}

function setChatHistoryCache(contactId, messages) {
  const sessionVersion = sessionStorage.getItem('sessionVersion') || '';
  const key = `${CACHE_KEYS.CHAT_HISTORY}_${contactId}`;
  const trimmed = (messages || []).slice(-HISTORY_MAX_ITEMS);
  localStorage.setItem(key, JSON.stringify({ version: sessionVersion, messages: trimmed }));
}

function appendChatMessageCache(contactId, message) {
  const history = getChatHistoryCache(contactId);
  history.push(message);
  setChatHistoryCache(contactId, history);
}

// ========================================
// 清除所有缓存
// ========================================
function clearAllCache() {
  const keys = Object.values(CACHE_KEYS);
  // 反向迭代：删除过程中 localStorage 长度会变化，正向迭代会漏删
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && keys.some(prefix => k.startsWith(prefix))) {
      localStorage.removeItem(k);
    }
  }
}
