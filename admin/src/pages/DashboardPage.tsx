import { Alert, Card, Col, Row, Statistic, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { fetchDashboard, formatYuan } from '../api';
import type { DashboardData } from '../api';

interface MetricItem {
  title: string;
  value: number | string;
}

// 指标组卡片：标题 + 若干 Statistic（栅格均分）
function MetricCard({
  title,
  items,
  extra,
}: {
  title: string;
  items: MetricItem[];
  extra?: ReactNode;
}) {
  return (
    <Card title={title}>
      <Row gutter={[8, 16]}>
        {items.map((item) => (
          <Col key={item.title} xs={12} md={8}>
            <Statistic title={item.title} value={item.value} />
          </Col>
        ))}
      </Row>
      {extra}
    </Card>
  );
}

// 数据看板：商家规模 / 订阅收入 / AI 用量 / 直播场次四组北极星指标（dashboard 只读接口）
export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [errorText, setErrorText] = useState('');

  useEffect(() => {
    let alive = true;
    fetchDashboard()
      .then((res) => {
        if (alive) {
          setData(res);
        }
      })
      .catch((err) => {
        if (alive) {
          setErrorText(err instanceof Error ? err.message : '看板数据加载失败');
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (errorText) {
    return (
      <Card>
        <Alert type="error" showIcon message="看板数据加载失败" description={errorText} />
      </Card>
    );
  }

  if (!data) {
    return <Card loading />;
  }

  const footnote = (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      口径：自然月统计；收入仅计已确权（paid）订单；用量字符 = AI 输出字符。
    </Typography.Text>
  );

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={12}>
        <MetricCard
          title="商家规模"
          items={[
            { title: '商家总数', value: data.merchants.total },
            { title: '本月新增', value: data.merchants.newThisMonth },
            { title: '付费商家', value: data.merchants.paid },
          ]}
        />
      </Col>
      <Col xs={24} xl={12}>
        <MetricCard
          title="订阅收入"
          items={[
            { title: '本月订单', value: data.orders.thisMonth.count },
            { title: '本月收入', value: formatYuan(data.orders.thisMonth.revenueCents) },
            { title: '累计收入', value: formatYuan(data.orders.total.revenueCents) },
          ]}
          extra={footnote}
        />
      </Col>
      <Col xs={24} xl={12}>
        <MetricCard
          title="AI 用量"
          items={[
            { title: '今日调用', value: data.usage.today.calls },
            { title: '今日字符', value: data.usage.today.chars },
            { title: '本月调用', value: data.usage.thisMonth.calls },
          ]}
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本月输出字符：{data.usage.thisMonth.chars}
            </Typography.Text>
          }
        />
      </Col>
      <Col xs={24} xl={12}>
        <MetricCard
          title="直播场次"
          items={[
            { title: '正在直播', value: data.lives.active },
            { title: '累计场次', value: data.lives.total },
          ]}
        />
      </Col>
    </Row>
  );
}
