import { Alert, Card, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTime, listAgreements, listAuditLogs, listBlockedScripts } from '../api';
import type { AgreementRow, AuditLogRow, BlockedScriptRow, PageResult } from '../api';

// 通用远端分页列表：初载第 1 页，翻页/改页大小按需拉取
function usePagedList<T>(loader: (page: number, pageSize: number) => Promise<PageResult<T>>) {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const serial = useRef(0);

  const load = useCallback(
    async (nextPage: number, nextSize: number) => {
      const current = ++serial.current;
      setLoading(true);
      setErrorText('');
      try {
        const res = await loader(nextPage, nextSize);
        if (current === serial.current) {
          setRows(res.items);
          setTotal(res.total);
          setPage(res.page);
          setPageSize(res.pageSize);
        }
      } catch (err) {
        if (current === serial.current) {
          setErrorText(err instanceof Error ? err.message : '数据加载失败');
        }
      } finally {
        if (current === serial.current) {
          setLoading(false);
        }
      }
    },
    [loader],
  );

  useEffect(() => {
    void load(1, 20);
  }, [load]);

  return { rows, total, page, pageSize, loading, errorText, load };
}

interface PagedTableProps<T> {
  loader: (page: number, pageSize: number) => Promise<PageResult<T>>;
  columns: ColumnsType<T>;
  expandedRowRender?: (record: T) => ReactNode;
}

function PagedTable<T>({ loader, columns, expandedRowRender }: PagedTableProps<T>) {
  const { rows, total, page, pageSize, loading, errorText, load } = usePagedList<T>(loader);
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      {errorText ? (
        <Alert type="error" showIcon message="数据加载失败" description={errorText} />
      ) : null}
      <Table
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 980 }}
        expandable={expandedRowRender ? { expandedRowRender } : undefined}
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
    </Space>
  );
}

function renderUser(phone?: string | null, nickname?: string | null) {
  if (!phone && !nickname) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  return (
    <span>
      {nickname ? <div>{nickname}</div> : null}
      <Typography.Text type="secondary">{phone}</Typography.Text>
    </span>
  );
}

// Tab 1：生成被拦截的话术（含命中违禁词），供运营复核；展开查看全文
function BlockedScriptsTab() {
  const loader = useCallback(
    (nextPage: number, nextPageSize: number) =>
      listBlockedScripts({ page: nextPage, pageSize: nextPageSize }),
    [],
  );
  const columns: ColumnsType<BlockedScriptRow> = [
    { title: '时间', dataIndex: 'createdAt', width: 150, render: (value: string) => formatTime(value) },
    { title: '商家', key: 'user', width: 200, render: (_, record) => renderUser(record.phone, record.nickname) },
    { title: '话术标题', dataIndex: 'title', width: 240, ellipsis: true },
    {
      title: '命中违禁词',
      dataIndex: 'matchedWords',
      width: 240,
      render: (words?: string[] | null) =>
        words && words.length > 0 ? (
          <Space size={4} wrap>
            {words.map((word) => (
              <Tag color="red" key={word}>
                {word}
              </Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    { title: '扫描时间', dataIndex: 'scannedAt', width: 150, render: (value?: string | null) => formatTime(value ?? null) },
  ];
  return (
    <PagedTable
      loader={loader}
      columns={columns}
      expandedRowRender={(record) => (
        <div style={{ padding: '4px 0' }}>
          <Typography.Text strong>标题：</Typography.Text>
          {record.title}
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 8 }}>{record.content}</div>
        </div>
      )}
    />
  );
}

// Tab 2：《声音授权协议》签署存档（合规红线档案）
function AgreementsTab() {
  const loader = useCallback(
    (nextPage: number, nextPageSize: number) =>
      listAgreements({ page: nextPage, pageSize: nextPageSize }),
    [],
  );
  const columns: ColumnsType<AgreementRow> = [
    { title: '签署时间', dataIndex: 'signedAt', width: 150, render: (value: string) => formatTime(value) },
    { title: '商家', key: 'user', width: 200, render: (_, record) => renderUser(record.phone, record.nickname) },
    {
      title: '协议版本',
      dataIndex: 'agreementVersion',
      width: 140,
      render: (value: string) => <Tag color="blue">{value}</Tag>,
    },
    { title: '签署 IP', dataIndex: 'signedIp', width: 160, render: (value?: string | null) => value || '—' },
    { title: 'User-Agent', dataIndex: 'userAgent', width: 320, ellipsis: true },
  ];
  return <PagedTable loader={loader} columns={columns} />;
}

// Tab 3：运营写操作审计日志（额度调整 / 订单确权等）；展开查看留痕明细
function AuditLogsTab() {
  const loader = useCallback(
    (nextPage: number, nextPageSize: number) =>
      listAuditLogs({ page: nextPage, pageSize: nextPageSize }),
    [],
  );
  const actionLabel = (action: string) =>
    action === 'quota.adjust' ? '额度调整' : action === 'order.confirm' ? '订单确权' : action;
  const columns: ColumnsType<AuditLogRow> = [
    { title: '时间', dataIndex: 'createdAt', width: 150, render: (value: string) => formatTime(value) },
    {
      title: '操作人',
      dataIndex: 'adminUsername',
      width: 140,
      render: (value?: string | null) => value || <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '操作',
      dataIndex: 'action',
      width: 120,
      render: (value: string) => <Tag color="geekblue">{actionLabel(value)}</Tag>,
    },
    {
      title: '商家',
      dataIndex: 'userPhone',
      width: 160,
      render: (value?: string | null) => value || <Typography.Text type="secondary">—</Typography.Text>,
    },
    { title: '资源类型', dataIndex: 'resourceType', width: 120 },
    {
      title: '资源 ID',
      dataIndex: 'resourceId',
      width: 260,
      ellipsis: true,
      render: (value?: string | null) =>
        value ? (
          <Typography.Text copyable={{ text: value }}>{value}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];
  return (
    <PagedTable
      loader={loader}
      columns={columns}
      expandedRowRender={(record) => (
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {record.detail ? JSON.stringify(record.detail, null, 2) : '—'}
        </pre>
      )}
    />
  );
}

// 内容审核：话术拦截复核 / 授权存档 / 审计日志三个合规档案 Tab
export default function AuditPage() {
  return (
    <Card>
      <Tabs
        items={[
          { key: 'blocked', label: '拦截话术', children: <BlockedScriptsTab /> },
          { key: 'agreements', label: '授权存档', children: <AgreementsTab /> },
          { key: 'logs', label: '审计日志', children: <AuditLogsTab /> },
        ]}
      />
    </Card>
  );
}
