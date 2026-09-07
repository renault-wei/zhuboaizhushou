import { Alert, Card, Col, Row, Select, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { formatTime, formatYuan, listUsage } from '../api';
import type { UsageRow } from '../api';

const CATEGORY_OPTIONS = [
  { value: 'voice_clone', label: '音色克隆' },
  { value: 'tts', label: '语音合成' },
  { value: 'script_generation', label: '话术生成' },
  { value: 'sensitive_check', label: '违禁检测' },
];

const categoryColor: Record<string, string> = {
  voice_clone: 'purple',
  tts: 'blue',
  script_generation: 'green',
  sensitive_check: 'orange',
};

function categoryTag(category: UsageRow['category']) {
  const option = CATEGORY_OPTIONS.find((item) => item.value === category);
  return <Tag color={categoryColor[category] ?? 'default'}>{option?.label ?? category}</Tag>;
}

// 算力用量：AI 调用流水（音色克隆/合成/话术/违禁检测）汇总 + 列表，可筛类别与商家
export default function UsagePage() {
  const [category, setCategory] = useState<string>();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [summary, setSummary] = useState({ promptChars: 0, outputChars: 0, costCents: 0 });
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  const load = useCallback(
    async (nextPage: number, nextSize: number) => {
      setLoading(true);
      setErrorText('');
      try {
        const res = await listUsage({ page: nextPage, pageSize: nextSize, category });
        setRows(res.items);
        setTotal(res.total);
        setPage(res.page);
        setPageSize(res.pageSize);
        setSummary(res.summary);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : '用量数据加载失败');
      } finally {
        setLoading(false);
      }
    },
    [category],
  );

  useEffect(() => {
    void load(1, 20);
  }, [load]);

  const handleCategoryChange = (value?: string) => {
    setCategory(value);
  };

  const columns: ColumnsType<UsageRow> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 150,
      render: (value: string) => formatTime(value),
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
    { title: '类别', dataIndex: 'category', width: 110, render: (value: UsageRow['category']) => categoryTag(value) },
    {
      title: '引擎/模型',
      key: 'provider',
      width: 180,
      render: (_, record) => (
        <Typography.Text type="secondary">
          {record.provider}
          {record.model ? ` · ${record.model}` : ''}
        </Typography.Text>
      ),
    },
    {
      title: '输出/输入（字符）',
      key: 'chars',
      width: 150,
      render: (_, record) => `${record.output_chars} / ${record.prompt_chars}`,
    },
    { title: '成本', dataIndex: 'cost_cents', width: 110, render: (value: number) => formatYuan(value) },
    { title: '状态', dataIndex: 'status', width: 100 },
  ];

  return (
    <>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic title="符合筛选的输出字符" value={summary.outputChars} />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic title="符合筛选的输入字符" value={summary.promptChars} />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic title="符合筛选的折算成本" value={formatYuan(summary.costCents)} />
          </Card>
        </Col>
      </Row>
      <Card
        title="AI 用量流水"
        extra={
          <Select
            allowClear
            placeholder="按类别筛选"
            style={{ width: 180 }}
            value={category}
            options={CATEGORY_OPTIONS}
            onChange={handleCategoryChange}
          />
        }
      >
        {errorText ? (
          <Alert type="error" showIcon message="用量加载失败" description={errorText} style={{ marginBottom: 16 }} />
        ) : null}
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={loading}
          scroll={{ x: 980 }}
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
    </>
  );
}
