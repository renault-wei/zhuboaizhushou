import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import AuditPage from './pages/AuditPage';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import MerchantPage from './pages/MerchantPage';
import OrderPage from './pages/OrderPage';

// 根路由：/login 为登录页，/ 为带侧边栏的主布局（含 4 个业务空页面）
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<MainLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="merchants" element={<MerchantPage />} />
          <Route path="orders" element={<OrderPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
