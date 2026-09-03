import { Card, Empty, Typography } from 'antd';

interface PagePlaceholderProps {
  title: string;
  description: string;
}

// 通用空页面占位：S0 脚手架阶段，各业务页先用它占位，后续按 Sprint 逐个实现
export default function PagePlaceholder({ title, description }: PagePlaceholderProps) {
  return (
    <Card title={title}>
      <Empty
        description={
          <Typography.Text type="secondary">{description}</Typography.Text>
        }
      />
    </Card>
  );
}
