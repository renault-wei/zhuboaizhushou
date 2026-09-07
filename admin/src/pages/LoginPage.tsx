import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminLogin } from '../api';
import { setSession } from '../auth';

interface LoginFormValues {
  username: string;
  password: string;
}

// 登录页：对接 POST /api/admin/login，成功后存会话并进入数据看板
export default function LoginPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState('');

  const onFinish = async (values: LoginFormValues) => {
    setSubmitting(true);
    setErrorText('');
    try {
      const res = await adminLogin(values.username.trim(), values.password);
      setSession(res.token, res.admin);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <Card className="login-card">
        <Typography.Title level={3} style={{ textAlign: 'center', marginTop: 0 }}>
          星辰语音 · 管理后台
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          内部运营管理平台（仅限预置运营账号登录）
        </Typography.Paragraph>
        {errorText ? (
          <Alert type="error" showIcon message={errorText} style={{ marginBottom: 16 }} />
        ) : null}
        <Form name="admin-login" size="large" onFinish={onFinish}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入账号' }]}>
            <Input prefix={<UserOutlined />} placeholder="账号" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
