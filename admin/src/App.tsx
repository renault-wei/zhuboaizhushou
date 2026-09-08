import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getSession } from './auth';
import MainLayout from './layouts/MainLayout';
import AppConfigPage from './pages/AppConfigPage';
import AuditPage from './pages/AuditPage';
import CardBatchesPage from './pages/CardBatchesPage';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import MerchantPage from './pages/MerchantPage';
import OrderPage from './pages/OrderPage';
import UsagePage from './pages/UsagePage';

// 受保护区域守卫：无后台会话一律回到登录页
function RequireLogin({ children }: { children: ReactNode }) {
  return getSession() ? <>{children}</> : <Navigate to="/login" replace />;
}

// 登录页守卫：已有会话时直接进入数据看板，避免重复登录
function RedirectIfLoggedIn({ children }: { children: ReactNode }) {
  return getSession() ? <Navigate to="/dashboard" replace /> : <>{children}</>;
}

// 根路由：/login 登录页；/ 为带侧边栏的主布局（看板/商家/算力/订单/审核五页）
export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfLoggedIn>
            <LoginPage />
          </RedirectIfLoggedIn>
        }
      />
      <Route
        path="/"
        element={
          <RequireLogin>
            <MainLayout />
          </RequireLogin>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="merchants" element={<MerchantPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="orders" element={<OrderPage />} />
        <Route path="card-batches" element={<CardBatchesPage />} />
        <Route path="app-config" element={<AppConfigPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
