import {
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { createCardBatch, fetchCardBatch, formatTime, listCardBatches } from '../api';
import type { CardBatchRow, CardCodeRow, CreateCardBatchInput } from '../api';

// 时长展示：整小时/整天折叠，其余按分钟（便于运营快速读档位）
function formatMinutes(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) {
    return `${minutes / 1440} 天`;
  }
  if (minutes > 0 && minutes % 60 === 0) {
    return `${minutes / 60} 小时`;
  }
  return `${minutes} 分钟`;
}

function batchStatusTag(status: CardBatchRow['status']) {
  return status === 'active' ? (
    <Tag color="green">生效中</Tag>
  ) : (
    <Tag>已停用</Tag>
  );
}

function cardStatusTag(status: CardCodeRow['status']) {
  const map: Record<CardCodeRow['status'], { color: string; text: string }> = {
    unused: { color: 'blue', text: '未使用' },
    redeemed: { color: 'green', text: '已核销' },
    revoked: { color: 'red', text: '已作废' },
  };
  const item = map[status];
  return <Tag color={item.color}>{item.text}</Tag>;
}

/** 导出卡密清单为 .txt（UTF-8 BOM，Excel/记事本中文不乱码） */
function downloadCodesText(lines: string[], filename: string) {
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function batchExportFilename(name: string): string {
  const stamp = new Date();
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `卡密-${name}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.txt`;
}

// 卡密批次：线下/渠道分发的时长凭证台账，可生成批次并导出、查看核销明细
export default function CardBatchesPage() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CreateCardBatchInput>();
  const [rows, setRows] = useState<CardBatchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdResult, setCreatedResult] = useState<{ batchName: string; minutes: number; lines: string[] }>();
  const [detailBatch, setDetailBatch] = useState<CardBatchRow>();
  const [detailCodes, setDetailCodes] = useState<CardCodeRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(
    async (nextPage: number, nextSize: number) => {
      setLoading(true);
      setErrorText('');
      try {
        const res = await listCardBatches({ page: nextPage, pageSize: nextSize, status: statusFilter });
        setRows(res.items);
        setTotal(res.total);
        setPage(res.page);
        setPageSize(res.pageSize);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : '批次数据加载失败');
      } finally {
        setLoading(false);
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    void load(1, 20);
  }, [load]);

  const handleCreate = async () => {
    const values = await form.validateFields();
    setCreating(true);
    try {
      const res = await createCardBatch({ ...values, remark: values.remark ?? '' });
      const lines = [
        `批次：${res.batch.name}`,
        `单张时长：${formatMinutes(res.batch.minutesPerCard)}`,
        `张数：${res.codes.length}`,
        '----',
        ...res.codes.map((item) => item.displayCode),
      ];
      setCreatedResult({ batchName: res.batch.name, minutes: res.batch.minutesPerCard, lines });
      setCreateOpen(false);
      form.resetFields();
      void message.success(`批次「${res.batch.name}」已生成 ${res.codes.length} 张卡密`);
      void load(page, pageSize);
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '生成批次失败');
    } finally {
      setCreating(false);
    }
  };

  const openDetail = async (record: CardBatchRow) => {
    setDetailBatch(record);
    setDetailCodes([]);
    setDetailLoading(true);
    try {
      const res = await fetchCardBatch(record.id);
      setDetailCodes(res.codes);
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '批次明细加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const exportCodes = (codes: CardCodeRow[], batchName: string, minutes: number, onlyUnused: boolean) => {
    const target = onlyUnused ? codes.filter((item) => item.status === 'unused') : codes;
    if (target.length === 0) {
      void message.info('没有可导出的未核销卡密');
      return;
    }
    const lines = [
      `批次：${batchName}`,
      `单张时长：${formatMinutes(minutes)}`,
      `张数：${target.length}`,
      '----',
      ...target.map((item) => item.displayCode),
    ];
    downloadCodesText(lines, batchExportFilename(batchName));
  };

  const columns: ColumnsType<CardBatchRow> = [
    { title: '批次名称', dataIndex: 'name', width: 200, ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 90, render: (value: CardBatchRow['status']) => batchStatusTag(value) },
    {
      title: '单张时长',
      dataIndex: 'minutes_per_card',
      width: 110,
      render: (value: number) => formatMinutes(value),
    },
    {
      title: '已核销 / 总张数',
      key: 'redeem',
      width: 140,
      render: (_, record) => `${record.redeemed_count} / ${record.total_count}`,
    },
    { title: '备注', dataIndex: 'remark', width: 180, ellipsis: true, render: (value?: string | null) => value || '—' },
    { title: '创建时间', dataIndex: 'created_at', width: 150, render: (value: string) => formatTime(value) },
    {
      title: '操作',
      key: 'action',
      width: 170,
      render: (_, record) => (
        <Space>
          <Button type="link" size="small" onClick={() => void openDetail(record)}>
            明细
          </Button>
          <Button
            type="link"
            size="small"
            icon={<DownloadOutlined />}
            onClick={async () => {
              try {
                const res = await fetchCardBatch(record.id);
                exportCodes(res.codes, record.name, record.minutes_per_card, true);
              } catch (err) {
                void message.error(err instanceof Error ? err.message : '导出失败');
              }
            }}
          >
            导出未核销
          </Button>
        </Space>
      ),
    },
  ];

  const codeColumns: ColumnsType<CardCodeRow> = [
    {
      title: '卡密',
      dataIndex: 'displayCode',
      width: 190,
      render: (value: string) => <Typography.Text copyable>{value}</Typography.Text>,
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (value: CardCodeRow['status']) => cardStatusTag(value) },
    {
      title: '核销商家',
      key: 'user',
      width: 200,
      render: (_, record) =>
        record.redeemedPhone ? (
          <span>
            {record.redeemedNickname ? <div>{record.redeemedNickname}</div> : null}
            <Typography.Text type="secondary">{record.redeemedPhone}</Typography.Text>
          </span>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    { title: '核销时间', dataIndex: 'redeemedAt', width: 150, render: (value?: string | null) => formatTime(value ?? null) },
  ];

  return (
    <Card
      title="卡密批次台账"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="按状态筛选"
            style={{ width: 150 }}
            value={statusFilter}
            options={[
              { value: 'active', label: '生效中' },
              { value: 'disabled', label: '已停用' },
            ]}
            onChange={(value?: string) => setStatusFilter(value)}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建批次
          </Button>
        </Space>
      }
    >
      {errorText ? <Typography.Paragraph type="danger">{errorText}</Typography.Paragraph> : null}
      <Table
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 1080 }}
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
        title="新建卡密批次"
        open={createOpen}
        okText="生成"
        cancelText="取消"
        confirmLoading={creating}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ count: 10, minutesPerCard: 60 }}>
          <Form.Item
            name="name"
            label="批次名称"
            rules={[
              { required: true, whitespace: true, message: '请输入批次名称' },
              { max: 100, message: '不超过 100 字' },
            ]}
          >
            <Input placeholder="如：上海渠道 10 月推广" />
          </Form.Item>
          <Form.Item
            name="count"
            label="卡密张数"
            rules={[{ required: true, message: '请输入卡密张数' }]}
          >
            <InputNumber min={1} max={200} precision={0} style={{ width: '100%' }} placeholder="1-200" />
          </Form.Item>
          <Form.Item
            name="minutesPerCard"
            label="单张时长（分钟）"
            extra="核销后按此时长入账时长余额"
            rules={[{ required: true, message: '请输入单张时长' }]}
          >
            <InputNumber min={1} max={10080} precision={0} style={{ width: '100%' }} placeholder="如 60 = 1 小时" />
          </Form.Item>
          <Form.Item name="remark" label="备注" rules={[{ max: 200, message: '不超过 200 字' }]}>
            <Input.TextArea rows={2} placeholder="选填：渠道 / 用途等" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="卡密已生成"
        open={createdResult !== undefined}
        onCancel={() => setCreatedResult(undefined)}
        footer={
          <Space>
            <Button onClick={() => setCreatedResult(undefined)}>关闭</Button>
            {createdResult ? (
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={() => downloadCodesText(createdResult.lines, batchExportFilename(createdResult.batchName))}
              >
                下载卡密清单
              </Button>
            ) : null}
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          请立即下载并妥善保存卡密清单，关闭后不再提供完整列表（批次明细仅展示单页）。
        </Typography.Paragraph>
        <Typography.Paragraph>
          <Typography.Text strong>批次：</Typography.Text>
          {createdResult?.batchName}
          <span style={{ marginLeft: 16 }}>
            <Typography.Text strong>单张时长：</Typography.Text>
            {createdResult ? formatMinutes(createdResult.minutes) : ''}
          </span>
        </Typography.Paragraph>
        <Typography.Paragraph
          copyable={{ text: createdResult?.lines.join('\n') }}
          style={{ maxHeight: 260, overflow: 'auto', background: '#fafafa', padding: 8, whiteSpace: 'pre-wrap' }}
        >
          {createdResult?.lines.join('\n')}
        </Typography.Paragraph>
      </Modal>

      <Drawer
        title={`批次明细：${detailBatch?.name ?? ''}`}
        width={760}
        open={detailBatch !== undefined}
        onClose={() => setDetailBatch(undefined)}
        extra={
          detailBatch ? (
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              onClick={() => exportCodes(detailCodes, detailBatch.name, detailBatch.minutes_per_card, true)}
            >
              导出未核销
            </Button>
          ) : null
        }
      >
        {detailBatch ? (
          <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="状态">{batchStatusTag(detailBatch.status)}</Descriptions.Item>
            <Descriptions.Item label="单张时长">{formatMinutes(detailBatch.minutes_per_card)}</Descriptions.Item>
            <Descriptions.Item label="已核销">
              {detailCodes.filter((item) => item.status === 'redeemed').length} / {detailBatch.total_count}
            </Descriptions.Item>
            <Descriptions.Item label="备注" span={3}>
              {detailBatch.remark || '—'}
            </Descriptions.Item>
          </Descriptions>
        ) : null}
        <Table
          rowKey="id"
          size="small"
          columns={codeColumns}
          dataSource={detailCodes}
          loading={detailLoading}
          scroll={{ x: 640 }}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (value: number) => `共 ${value} 张` }}
        />
      </Drawer>
    </Card>
  );
}
