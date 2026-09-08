import {
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { confirmOrder, formatTime, formatYuan, listOrders } from '../api';
import type { OrderChannel, OrderKind, OrderRow } from '../api';

const STATUS_OPTIONS = [
  { value: 'pending', label: '待确权' },
  { value: 'paid', label: '已确权' },
  { value: 'refunded', label: '已退款' },
  { value: 'closed', label: '已关闭' },
];

const KIND_OPTIONS = [
  { value: 'subscription', label: '订阅' },
  { value: 'recharge', label: '充值' },
];

const CHANNEL_OPTIONS = [
  { value: 'manual', label: '人工确认' },
  { value: 'alipay_scan', label: '扫码直充' },
  { value: 'card', label: '卡密核销' },
];

function statusTag(status: OrderRow['status']) {
  const map: Record<OrderRow['status'], { color: string; text: string }> = {
    pending: { color: 'gold', text: '待确权' },
    paid: { color: 'green', text: '已确权' },
    refunded: { color: 'red', text: '已退款' },
    closed: { color: 'default', text: '已关闭' },
  };
  const item = map[status];
  return <Tag color={item.color}>{item.text}</Tag>;
}

function kindTag(kind?: OrderKind | null) {
  if (kind === 'recharge') {
    return <Tag color="geekblue">充值</Tag>;
  }
  return <Tag color="blue">订阅</Tag>;
}

function channelText(channel?: OrderChannel | null): string {
  const map: Record<OrderChannel, string> = {
    manual: '人工确认',
    alipay_scan: '扫码直充',
    card: '卡密核销',
  };
  return channel ? map[channel] : '—';
}

// 订单订阅：订阅/充值订单台账；待确权可人工收款确认（扫码充值单入时长余额，订阅单刷新订阅+额度）
export default function OrderPage() {
  const { message } = AntdApp.useApp();
  const [status, setStatus] = useState<string>();
  const [kind, setKind] = useState<OrderKind>();
  const [channel, setChannel] = useState<OrderChannel>();
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [qrcodeOrder, setQrcodeOrder] = useState<OrderRow>();

  const load = useCallback(
    async (nextPage: number, nextSize: number) => {
      setLoading(true);
      setErrorText('');
      try {
        const res = await listOrders({ page: nextPage, pageSize: nextSize, status, kind, channel });
        setRows(res.items);
        setTotal(res.total);
        setPage(res.page);
        setPageSize(res.pageSize);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : '订单数据加载失败');
      } finally {
        setLoading(false);
      }
    },
    [status, kind, channel],
  );

  useEffect(() => {
    void load(1, 20);
  }, [load]);

  const handleConfirm = async (record: OrderRow) => {
    try {
      await confirmOrder(record.id);
      void message.success(`订单 ${record.order_no} 已确权`);
      void load(page, pageSize);
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '确权失败');
      void load(page, pageSize);
    }
  };

  const columns: ColumnsType<OrderRow> = [
    {
      title: '订单号',
      dataIndex: 'order_no',
      width: 200,
      render: (value: string) => <Typography.Text copyable>{value}</Typography.Text>,
    },
    {
      title: '商家',
      key: 'user',
      width: 170,
      render: (_, record) => (
        <span>
          {record.nickname ? <div>{record.nickname}</div> : null}
          <Typography.Text type="secondary">{record.phone}</Typography.Text>
        </span>
      ),
    },
    { title: '类型', dataIndex: 'kind', width: 80, render: (value?: OrderKind | null) => kindTag(value ?? 'subscription') },
    {
      title: '渠道',
      dataIndex: 'channel',
      width: 100,
      render: (value?: OrderChannel | null) => channelText(value ?? 'manual'),
    },
    {
      title: '档位',
      key: 'plan',
      width: 120,
      render: (_, record) => (record.kind === 'recharge' && record.hours ? `${record.hours} 小时` : record.plan || '—'),
    },
    {
      title: '金额',
      dataIndex: 'amount_cents',
      width: 110,
      render: (value: number) => <Typography.Text strong>{formatYuan(value)}</Typography.Text>,
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (value: OrderRow['status']) => statusTag(value) },
    { title: '下单时间', dataIndex: 'created_at', width: 145, render: (value: string) => formatTime(value) },
    { title: '确权时间', dataIndex: 'paid_at', width: 145, render: (value?: string | null) => formatTime(value ?? null) },
    {
      title: '操作',
      key: 'action',
      width: 180,
      fixed: 'right',
      render: (_, record) => {
        const actions: ReactNode[] = [];
        if (record.kind === 'recharge' && record.channel === 'alipay_scan' && record.status === 'pending') {
          actions.push(
            <Button type="link" size="small" key="qr" onClick={() => setQrcodeOrder(record)}>
              收款码
            </Button>,
          );
        }
        if (record.status === 'pending') {
          actions.push(
            <Popconfirm
              key="confirm"
              title="确认收到该笔款项？"
              description={
                record.kind === 'recharge'
                  ? '确权后将按订单时长入账时长余额，不改变订阅状态'
                  : '确权后订阅将顺延 30 天，当月额度按付费档刷新'
              }
              okText="确认收款"
              cancelText="取消"
              onConfirm={() => handleConfirm(record)}
            >
              <Button type="link" size="small">
                确认收款
              </Button>
            </Popconfirm>,
          );
        }
        return actions.length > 0 ? <Space>{actions}</Space> : <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
  ];

  return (
    <Card
      title="订单台账"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="按类型"
            style={{ width: 110 }}
            value={kind}
            options={KIND_OPTIONS}
            onChange={(value?: OrderKind) => setKind(value)}
          />
          <Select
            allowClear
            placeholder="按渠道"
            style={{ width: 130 }}
            value={channel}
            options={CHANNEL_OPTIONS}
            onChange={(value?: OrderChannel) => setChannel(value)}
          />
          <Select
            allowClear
            placeholder="按状态"
            style={{ width: 120 }}
            value={status}
            options={STATUS_OPTIONS}
            onChange={(value?: string) => setStatus(value)}
          />
        </Space>
      }
    >
      {errorText ? <Typography.Paragraph type="danger">{errorText}</Typography.Paragraph> : null}
      <Table
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 1350 }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (value: number) => `共 ${value} 条`,
          onChange: (nextPage, nextSize) => {
            void load(nextPage, nextSize ?? pageSize);
          },
        }}
      />

      <Modal
        title="扫码直充收款码"
        open={qrcodeOrder !== undefined}
        onCancel={() => setQrcodeOrder(undefined)}
        footer={
          <Button onClick={() => setQrcodeOrder(undefined)}>关闭</Button>
        }
      >
        {qrcodeOrder ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="订单号">
              <Typography.Text copyable>{qrcodeOrder.order_no}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="金额">{formatYuan(qrcodeOrder.amount_cents)}</Descriptions.Item>
            <Descriptions.Item label="档位">{qrcodeOrder.hours ?? 0} 小时</Descriptions.Item>
            <Descriptions.Item label="收款码（mock 通道）">
              <Typography.Text code copyable>
                mock://alipay-scan/{qrcodeOrder.order_no}
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>
        ) : null}
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          当前为 mock 收款通道，不产生真实收款码；待运营主体支付宝凭证接入（M8）后由服务端返回真实收款码并自动对账入账。
        </Typography.Paragraph>
      </Modal>
    </Card>
  );
}
