import {
  CreditCardOutlined,
  DashboardOutlined,
  LogoutOutlined,
  SafetyCertificateOutlined,
  ShopOutlined,
} from '@ant-design/icons';
import { Button, Layout, Menu, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

const { Content, Header, Sider } = Layout;

// 侧边栏一级菜单：key 与路由路径保持一致，点击即跳转
const menuItems: MenuProps['items'] = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '数据看板' },
  { key: '/merchants', icon: <ShopOutlined />, label: '商家管理' },
  { key: '/orders', icon: <CreditCardOutlined />, label: '订单订阅' },
  { key: '/audit', icon: <SafetyCertificateOutlined />, label: '内容审核' },
];

const pageTitles: Record<string, string> = {
  '/dashboard': '数据看板',
  '/merchants': '商家管理',
  '/orders': '订单订阅',
  '/audit': '内容审核',
};

// 主布局：左侧菜单 + 顶部栏 + 内容区，业务页经嵌套路由由 <Outlet /> 渲染
export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const firstSegment = `/${location.pathname.split('/')[1] ?? ''}`;
  const selectedKey = firstSegment in pageTitles ? firstSegment : '/dashboard';

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    navigate(key);
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={216} theme="dark">
        <div className="admin-logo">星辰语音 · 管理后台</div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={handleMenuClick}
        />
      </Sider>
      <Layout>
        <Header className="admin-header">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {pageTitles[selectedKey]}
          </Typography.Title>
          <Button type="text" icon={<LogoutOutlined />} onClick={() => navigate('/login')}>
            退出登录
          </Button>
        </Header>
        <Content className="admin-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
