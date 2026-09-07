// 管理后台 API 客户端：统一注入后台 Bearer token，401 自动登出回登录页
import { clearSession, getToken } from './auth';

export interface ApiError extends Error {
  code?: string;
  status?: number;
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (res.status === 401) {
    clearSession();
    if (window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const payload = (data ?? {}) as Record<string, unknown>;
    const error = new Error(
      typeof payload.message === 'string' ? payload.message : `请求失败（HTTP ${res.status}）`,
    ) as ApiError;
    error.code = typeof payload.error === 'string' ? payload.error : undefined;
    error.status = res.status;
    throw error;
  }
  return data as T;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const raw = search.toString();
  return raw ? `?${raw}` : '';
}

// ---------- 领域类型（对齐 server 返回的字段名） ----------

export interface AdminLoginResponse {
  token: string;
  expiresInSeconds: number;
  admin: { id: string; username: string; role: string };
}

export interface DashboardData {
  merchants: { total: number; newThisMonth: number; paid: number };
  orders: {
    thisMonth: { count: number; revenueCents: number };
    total: { count: number; revenueCents: number };
  };
  usage: {
    today: { calls: number; chars: number };
    thisMonth: { calls: number; chars: number };
  };
  lives: { active: number; total: number };
}

export interface MerchantRow {
  id: string;
  phone: string;
  nickname?: string | null;
  subscriptionStatus: 'free' | 'paid';
  subscriptionExpiresAt?: string | null;
  createdAt: string;
  voiceCount: number;
  scriptCount: number;
  liveCount: number;
  paidOrderCount: number;
}

export interface QuotaRow {
  id: string;
  user_id: string;
  period: string;
  tts_chars_quota: number;
  tts_chars_used: number;
  script_generations_quota: number;
  script_generations_used: number;
  live_minutes_quota: number;
  live_minutes_used: number;
  phone: string;
  nickname?: string | null;
}

export interface UsageRow {
  id: string;
  user_id: string;
  category: 'voice_clone' | 'tts' | 'script_generation' | 'sensitive_check';
  provider: string;
  model?: string | null;
  prompt_chars: number;
  output_chars: number;
  cost_cents: number;
  status: string;
  error_message?: string | null;
  created_at: string;
  phone: string;
  nickname?: string | null;
}

export interface OrderRow {
  id: string;
  user_id: string;
  order_no: string;
  wx_transaction_id?: string | null;
  plan: string;
  amount_cents: number;
  status: 'pending' | 'paid' | 'refunded' | 'closed';
  paid_at?: string | null;
  created_at: string;
  phone: string;
  nickname?: string | null;
}

export interface BlockedScriptRow {
  id: string;
  title: string;
  content: string;
  matchedWords?: string[] | null;
  scannedAt?: string | null;
  createdAt: string;
  phone: string;
  nickname?: string | null;
}

export interface AgreementRow {
  id: string;
  agreementVersion: string;
  signedAt: string;
  signedIp?: string | null;
  userAgent?: string | null;
  phone: string;
  nickname?: string | null;
}

export interface AuditLogRow {
  id: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  detail: Record<string, unknown> | null;
  ip?: string | null;
  createdAt: string;
  adminUsername?: string | null;
  userPhone?: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UsageListResult extends PageResult<UsageRow> {
  summary: { promptChars: number; outputChars: number; costCents: number };
}

// ---------- 接口封装 ----------

export async function adminLogin(username: string, password: string): Promise<AdminLoginResponse> {
  return request<AdminLoginResponse>('/api/admin/login', {
    method: 'POST',
    body: { username, password },
  });
}

export async function fetchDashboard(): Promise<DashboardData> {
  return request<DashboardData>('/api/admin/dashboard');
}

export async function listMerchants(params: {
  page: number;
  pageSize: number;
  search?: string;
}): Promise<PageResult<MerchantRow>> {
  return request<PageResult<MerchantRow>>(
    `/api/admin/merchants${buildQuery(params)}`,
  );
}

export async function listQuotas(params: {
  page: number;
  pageSize: number;
  userId?: string;
}): Promise<PageResult<QuotaRow>> {
  return request<PageResult<QuotaRow>>(`/api/admin/quotas${buildQuery(params)}`);
}

/** 额度调整输入：后端按字段局部更新（至少提供一档），period 缺省为当月 */
export interface QuotaAdjustInput {
  period?: string;
  ttsCharsQuota?: number;
  scriptGenerationsQuota?: number;
  liveMinutesQuota?: number;
}

export async function adjustQuota(
  userId: string,
  body: QuotaAdjustInput,
): Promise<unknown> {
  return request(`/api/admin/quotas/${userId}`, { method: 'PUT', body });
}

export async function listUsage(params: {
  page: number;
  pageSize: number;
  category?: string;
  userId?: string;
}): Promise<UsageListResult> {
  return request<UsageListResult>(`/api/admin/usage${buildQuery(params)}`);
}

export async function listOrders(params: {
  page: number;
  pageSize: number;
  status?: string;
}): Promise<PageResult<OrderRow>> {
  return request<PageResult<OrderRow>>(`/api/admin/orders${buildQuery(params)}`);
}

export async function confirmOrder(orderId: string): Promise<unknown> {
  return request(`/api/admin/orders/${orderId}/confirm`, { method: 'POST' });
}

export async function listBlockedScripts(params: {
  page: number;
  pageSize: number;
}): Promise<PageResult<BlockedScriptRow>> {
  return request<PageResult<BlockedScriptRow>>(
    `/api/admin/audit/scripts${buildQuery(params)}`,
  );
}

export async function listAgreements(params: {
  page: number;
  pageSize: number;
}): Promise<PageResult<AgreementRow>> {
  return request<PageResult<AgreementRow>>(
    `/api/admin/audit/agreements${buildQuery(params)}`,
  );
}

export async function listAuditLogs(params: {
  page: number;
  pageSize: number;
}): Promise<PageResult<AuditLogRow>> {
  return request<PageResult<AuditLogRow>>(
    `/api/admin/audit/logs${buildQuery(params)}`,
  );
}

/** 本地月周期 YYYY-MM（与 server 的口径一致用于筛选/定位当前额度行） */
export function currentMonthPeriod(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}`;
}

/** 金额格式化：分 → 元字符串 */
export function formatYuan(cents: number | undefined | null): string {
  const value = Number(cents ?? 0);
  return `¥${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}`;
}

/** 时间展示：ISO/时间戳 → 本地字符串；空值返回 — */
export function formatTime(value: string | undefined | null): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
