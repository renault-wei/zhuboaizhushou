import { ReloadOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import {
  adjustQuota,
  currentMonthPeriod,
  formatTime,
  listMerchants,
  listQuotas,
} from '../api';
import type { MerchantRow, QuotaAdjustInput, QuotaRow } from '../api';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// 订阅状态展示：免费 / 付费（带到期时间，过期标灰提醒）
function renderSubscription(status: MerchantRow['subscriptionStatus'], expiresAt?: string | null) {
  if (status !== 'paid') {
    return <Tag>免费</Tag>;
  }
  const expired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
  return (
    <span>
      <Tag color={expired ? 'default' : 'green'}>{expired ? '已到期' : '付费'}</Tag>
      {expiresAt ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatTime(expiresAt)}
        </Typography.Text>
      ) : null}
    </span>
  );
}

interface AdjustFormValues {
  period?: string;
  ttsCharsQuota?: number | null;
  scriptGenerationsQuota?: number | null;
  liveMinutesQuota?: number | null;
}

// 商家管理：手机号/昵称搜索台账 + 按周期调整 AI 额度（只改上限、保留已用量，写操作自动审计留痕）
export default function MerchantPage() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<AdjustFormValues>();
  const [rows, setRows] = useState<MerchantRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  const [target, setTarget] = useState<MerchantRow | null>(null);
  const [quotaRows, setQuotaRows] = useState<QuotaRow[]>([]);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [adjustVisible, setAdjustVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(
    async (nextPage: number, nextSize: number) => {
      setLoading(true);
      setErrorText('');
      try {
        const res = await listMerchants({ page: nextPage, pageSize: nextSize, search: keyword || undefined });
        setRows(res.items);
        setTotal(res.total);
        setPage(res.page);
        setPageSize(res.pageSize);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : '商家数据加载失败');
      } finally {
        setLoading(false);
      }
    },
    [keyword],
  );

  useEffect(() => {
    void load(1, 20);
  }, [load]);

  const openAdjust = async (record: MerchantRow) => {
    setTarget(record);
    setQuotaRows([]);
    setAdjustVisible(true);
    setQuotaLoading(true);
    try {
      const res = await listQuotas({ page: 1, pageSize: 12, userId: record.id });
      setQuotaRows(res.items);
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '额度信息读取失败');
    } finally {
      setQuotaLoading(false);
    }
  };

  const closeAdjust = () => {
    setAdjustVisible(false);
    setTarget(null);
    setQuotaRows([]);
  };

  const watchedPeriod = Form.useWatch('period', form) ?? currentMonthPeriod();
  const base = quotaRows.find((row) => row.period === watchedPeriod);

  const onAdjustSubmit = async (values: AdjustFormValues) => {
    if (!target) {
      return;
    }
    const period = values.period?.trim() ?? '';
    if (!PERIOD_PATTERN.test(period)) {
      void message.warning('周期格式应为 YYYY-MM');
      return;
    }
    const body: QuotaAdjustInput = { period };
    if (typeof values.ttsCharsQuota === 'number') {
      body.ttsCharsQuota = values.ttsCharsQuota;
    }
    if (typeof values.scriptGenerationsQuota === 'number') {
      body.scriptGenerationsQuota = values.scriptGenerationsQuota;
    }
    if (typeof values.liveMinutesQuota === 'number') {
      body.liveMinutesQuota = values.liveMinutesQuota;
    }
    if (
      body.ttsCharsQuota === undefined &&
      body.scriptGenerationsQuota === undefined &&
      body.liveMinutesQuota === undefined
    ) {
      void message.warning('至少填写一档新额度（留空表示不改动）');
      return;
    }
    setSubmitting(true);
    try {
      await adjustQuota(target.id, body);
      void message.success(`已调整 ${target.phone} 的 ${period} 额度（已用量保留）`);
      setAdjustVisible(false);
      setTarget(null);
      setQuotaRows([]);
      void load(page, pageSize);
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '额度调整失败');
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<MerchantRow> = [
    {
      title: '商家',
      key: 'merchant',
      width: 220,
      render: (_, record) => (
        <span>
          <Typography.Text strong>{record.nickname || record.phone}</Typography.Text>
          {record.nickname ? (
            <div>
              <Typography.Text type="secondary">{record.phone}</Typography.Text>
            </div>
          ) : null}
        </span>
      ),
    },
    {
      title: '订阅',
      key: 'subscription',
      width: 220,
      render: (_, record) => renderSubscription(record.subscriptionStatus, record.subscriptionExpiresAt),
    },
    {
      title: '资源概况',
      key: 'counts',
      width: 240,
      render: (_, record) => (
        <Typography.Text type="secondary">
          音色 {record.voiceCount} · 话术 {record.scriptCount} · 直播 {record.liveCount} · 已购订单{' '}
          {record.paidOrderCount}
        </Typography.Text>
      ),
    },
    { title: '注册时间', dataIndex: 'createdAt', width: 150, render: (value: string) => formatTime(value) },
    {
      title: '操作',
      key: 'action',
      width: 110,
      fixed: 'right',
      render: (_, record) => (
        <Button type="link" size="small" onClick={() => openAdjust(record)}>
          额度调整
        </Button>
      ),
    },
  ];

  return (
    <>
      <Card
        title="商家台账"
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder="搜索手机号 / 昵称"
              style={{ width: 240 }}
              onSearch={(value: string) => {
                setKeyword(value.trim());
              }}
            />
            <Button icon={<ReloadOutlined />} onClick={() => load(page, pageSize)}>
              刷新
            </Button>
          </Space>
        }
      >
        {errorText ? (
          <Alert type="error" showIcon message="商家加载失败" description={errorText} style={{ marginBottom: 16 }} />
        ) : null}
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={loading}
          scroll={{ x: 940 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (value: number) => `共 ${value} 个商家`,
            onChange: (nextPage, nextSize) => {
              void load(nextPage, nextSize ?? pageSize);
            },
          }}
        />
      </Card>

      <Drawer
        title={target ? `额度调整 · ${target.nickname || target.phone}` : '额度调整'}
        width={460}
        open={adjustVisible}
        onClose={closeAdjust}
        destroyOnClose
        footer={
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={closeAdjust}>取消</Button>
            <Button type="primary" loading={submitting} onClick={() => form.submit()}>
              保存调整
            </Button>
          </Space>
        }
      >
        {quotaLoading ? (
          <Alert type="info" showIcon message="正在读取该商家历史额度…" style={{ marginBottom: 16 }} />
        ) : base ? (
          <Alert
            type="info"
            showIcon
            message={`周期 ${watchedPeriod} 当前基线（已用 / 上限）`}
            description={`字符 ${base.tts_chars_used.toLocaleString()} / ${base.tts_chars_quota.toLocaleString()}；话术生成 ${base.script_generations_used.toLocaleString()} / ${base.script_generations_quota.toLocaleString()}；直播 ${base.live_minutes_used.toLocaleString()} / ${base.live_minutes_quota.toLocaleString()} 分钟`}
            style={{ marginBottom: 16 }}
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            message={`周期 ${watchedPeriod} 暂无额度行`}
            description="保存后将按所选周期新建额度行；已用量不受影响。"
            style={{ marginBottom: 16 }}
          />
        )}
        <Form form={form} layout="vertical" initialValues={{ period: currentMonthPeriod() }} onFinish={onAdjustSubmit}>
          <Form.Item
            name="period"
            label="调整周期"
            rules={[
              { required: true, message: '请输入周期' },
              { pattern: PERIOD_PATTERN, message: '格式应为 YYYY-MM，例如 2026-09' },
            ]}
          >
            <Input placeholder="2026-09" />
          </Form.Item>
          <Form.Item
            name="ttsCharsQuota"
            label="语音合成字符上限"
            tooltip="留空表示不改动这一档额度"
          >
            <InputNumber min={0} step={10000} placeholder={base ? `当前 ${base.tts_chars_quota}` : '留空不改动'} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="scriptGenerationsQuota"
            label="话术生成次数上限"
            tooltip="留空表示不改动这一档额度"
          >
            <InputNumber
              min={0}
              step={100}
              placeholder={base ? `当前 ${base.script_generations_quota}` : '留空不改动'}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            name="liveMinutesQuota"
            label="直播分钟上限"
            tooltip="留空表示不改动这一档额度"
          >
            <InputNumber
              min={0}
              step={1000}
              placeholder={base ? `当前 ${base.live_minutes_quota}` : '留空不改动'}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          说明：额度调整是人工干预手段（如线下收款后手动放量），仅修改所选周期的上限，不触碰已用量；
          每次调整都会写入审计日志，供「内容审核 → 审计日志」追溯。
        </Typography.Paragraph>
      </Drawer>
    </>
  );
}
