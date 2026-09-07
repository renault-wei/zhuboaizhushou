import {
  App as AntdApp,
  Button,
  Card,
  Popconfirm,
  Select,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { confirmOrder, formatTime, formatYuan, listOrders } from '../api';
import type { OrderRow } from '../api';

const STATUS_OPTIONS = [
  { value: 'pending', label: '待确权' },
  { value: 'paid', label: '已确权' },
  { value: 'refunded', label: '已退款' },
  { value: 'closed', label: '已关闭' },
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

// 订单订阅：商家订阅订单台账，待确权订单可人工收款确认（模拟支付回调确权 + 额度刷新）
export default function OrderPage() {
  const { message } = AntdApp.useApp();
  const [status, setStatus] = useState<string>();
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  const load = useCallback(
    async (nextPage: number, nextSize: number) => {
      setLoading(true);
      setErrorText('');
      try {
        const res = await listOrders({ page: nextPage, pageSize: nextSize, status });
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
    [status],
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
      width: 220,
      render: (value: string) => <Typography.Text copyable>{value}</Typography.Text>,
    },
    {
      title: '商家',
      key: 'user',
      width: 180,
      render: (_, record) => (
        <span>
          {record.nickname ? <div>{record.nickname}</div> : null}
          <Typography.Text type="secondary">{record.phone}</Typography.Text>
        </span>
      ),
    },
    { title: '套餐', dataIndex: 'plan', width: 140 },
    {
      title: '金额',
      dataIndex: 'amount_cents',
      width: 120,
      render: (value: number) => <Typography.Text strong>{formatYuan(value)}</Typography.Text>,
    },
    { title: '状态', dataIndex: 'status', width: 100, render: (value: OrderRow['status']) => statusTag(value) },
    { title: '下单时间', dataIndex: 'created_at', width: 150, render: (value: string) => formatTime(value) },
    { title: '确权时间', dataIndex: 'paid_at', width: 150, render: (value?: string | null) => formatTime(value ?? null) },
    {
      title: '操作',
      key: 'action',
      width: 130,
      fixed: 'right',
      render: (_, record) =>
        record.status === 'pending' ? (
          <Popconfirm
            title="确认收到该笔款项？"
            description="确权后订阅将顺延 30 天，当月额度按付费档刷新"
            okText="确认收款"
            cancelText="取消"
            onConfirm={() => handleConfirm(record)}
          >
            <Button type="link" size="small">
              确认收款
            </Button>
          </Popconfirm>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  return (
    <Card
      title="订阅订单台账"
      extra={
        <Select
          allowClear
          placeholder="按状态筛选"
          style={{ width: 160 }}
          value={status}
          options={STATUS_OPTIONS}
          onChange={(value?: string) => setStatus(value)}
        />
      }
    >
      {errorText ? (
        <Typography.Paragraph type="danger">{errorText}</Typography.Paragraph>
      ) : null}
      <Table
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 1150 }}
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
    </Card>
  );
}
