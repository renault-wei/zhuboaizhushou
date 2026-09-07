// 后台会话：token 与后台信息存 localStorage（内部工具口径，前端不存任何密钥）
const TOKEN_KEY = 'starvoice-admin-token';
const INFO_KEY = 'starvoice-admin-info';

export interface AdminInfo {
  id: string;
  username: string;
  role: string;
}

export function getToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, admin: AdminInfo): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(INFO_KEY, JSON.stringify(admin));
}

export function getSession(): AdminInfo | null {
  const raw = window.localStorage.getItem(INFO_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as AdminInfo;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(INFO_KEY);
}
