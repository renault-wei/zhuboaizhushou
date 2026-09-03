import {
  LockOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Button, Card, Form, Input, Typography, message } from 'antd';
import { useNavigate } from 'react-router-dom';

// 登录页（纯 UI 壳）：账号 + 密码 + 验证码，S0 阶段不接后端接口
export default function LoginPage() {
  const navigate = useNavigate();

  const onFinish = () => {
    message.info('演示壳：登录接口尚未接入，S0 阶段仅展示 UI');
  };

  return (
    <div className="login-page">
      <Card className="login-card">
        <Typography.Title level={3} style={{ textAlign: 'center', marginTop: 0 }}>
          星辰语音 · 管理后台
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          内部运营管理平台（账号 + 密码 + 验证码）
        </Typography.Paragraph>
        <Form name="admin-login" size="large" onFinish={onFinish}>
          <Form.Item name="account" rules={[{ required: true, message: '请输入账号' }]}>
            <Input prefix={<UserOutlined />} placeholder="账号" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item name="captcha" rules={[{ required: true, message: '请输入验证码' }]}>
            <Input prefix={<SafetyCertificateOutlined />} placeholder="验证码" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block>
              登录
            </Button>
          </Form.Item>
        </Form>
        <Button type="link" block onClick={() => navigate('/')}>
          跳过登录，预览主布局 →
        </Button>
      </Card>
    </div>
  );
}
