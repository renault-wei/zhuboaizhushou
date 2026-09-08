import { App as AntdApp, Button, Card, Input, InputNumber, Radio, Space, Spin, Switch, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAppConfig, formatTime, updateAppConfigKey } from '../api';
import type { AppConfigRow, PublicAppConfig } from '../api';

type SaveKey = keyof PublicAppConfig;
type PriorityMode = 'balance_quota' | 'quota_balance';

interface PackDraft {
  id: number;
  hours: number;
  amountYuan: number;
}

/** 距上次更新的落点信息（未配置行回落默认值提示） */
function updatedMeta(rows: AppConfigRow[], key: string): string {
  const row = rows.find((item) => item.key === key);
  if (!row) {
    return '默认值 · 尚未自定义';
  }
  return `由 ${row.updatedBy ?? '运营'} 于 ${formatTime(row.updatedAt)} 更新`;
}

// 系统开关：app_config 白名单 Key 编辑，保存即经 /api/app/config 下发，无需发版；写操作全留痕
export default function AppConfigPage() {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<AppConfigRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<SaveKey | null>(null);

  const [showCharge, setShowCharge] = useState(true);
  const [packs, setPacks] = useState<PackDraft[]>([]);
  const [notice, setNotice] = useState('');
  const [priority, setPriority] = useState<PriorityMode>('balance_quota');
  const packIdRef = useRef(1000);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchAppConfig();
      setRows(res.rows);
      setShowCharge(res.config.showCharge);
      setNotice(res.config.notice);
      setPriority(
        res.config.quotaPriority.join(',') === 'quota,balance' ? 'quota_balance' : 'balance_quota',
      );
      setPacks(
        res.config.pricePacks.map((pack) => {
          packIdRef.current += 1;
          return {
            id: packIdRef.current,
            hours: pack.hours,
            amountYuan: pack.amountCents / 100,
          };
        }),
      );
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '系统开关加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (key: SaveKey, value: unknown) => {
    setSavingKey(key);
    try {
      await updateAppConfigKey(key, value);
      void message.success('已保存并下发，商家端下次读取即生效');
      await load();
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingKey(null);
    }
  };

  const savePacks = async () => {
    if (packs.length === 0) {
      void message.warning('至少保留一个时长档位');
      return;
    }
    const seen = new Set<number>();
    const valid = packs.every((pack) => {
      if (
        !Number.isInteger(pack.hours) ||
        pack.hours <= 0 ||
        !Number.isFinite(pack.amountYuan) ||
        pack.amountYuan <= 0 ||
        seen.has(pack.hours)
      ) {
        return false;
      }
      seen.add(pack.hours);
      return true;
    });
    if (!valid) {
      void message.warning('档位时长须为正整数且不重复，价格须大于 0');
      return;
    }
    await save(
      'pricePacks',
      packs.map((pack) => ({ hours: pack.hours, amountCents: Math.round(pack.amountYuan * 100) })),
    );
  };

  const addPack = () => {
    packIdRef.current += 1;
    setPacks((prev) => [...prev, { id: packIdRef.current, hours: 1, amountYuan: 9.9 }]);
  };

  const updatePack = (id: number, patch: Partial<PackDraft>) => {
    setPacks((prev) => prev.map((pack) => (pack.id === id ? { ...pack, ...patch } : pack)));
  };

  const removePack = (id: number) => {
    setPacks((prev) => prev.filter((pack) => pack.id !== id));
  };

  const sectionButton = (key: SaveKey) => (
    <Button
      type="primary"
      size="small"
      loading={savingKey === key}
      onClick={() => {
        if (key === 'showCharge') {
          void save(key, showCharge);
        } else if (key === 'notice') {
          void save(key, notice);
        } else if (key === 'quotaPriority') {
          void save(key, priority === 'balance_quota' ? ['balance', 'quota'] : ['quota', 'balance']);
        } else {
          void savePacks();
        }
      }}
    >
      保存
    </Button>
  );

  return (
    <Card
      title="系统开关"
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        保存即写入 app_config 并随商家端 /api/app/config 下发，无需发版；所有写操作在「内容审核 → 审计日志」留痕。
      </Typography.Paragraph>
      <Spin spinning={loading}>
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <Card
            type="inner"
            size="small"
            title="充值入口显隐"
            extra={sectionButton('showCharge')}
          >
            <Space align="center">
              <Switch checked={showCharge} onChange={setShowCharge} />
              <Typography.Text>
                {showCharge ? '商家端展示充值入口' : '隐藏充值入口（存量余额/卡密不受影响）'}
              </Typography.Text>
            </Space>
            <div>
              <Typography.Text type="secondary">{updatedMeta(rows, 'showCharge')}</Typography.Text>
            </div>
          </Card>

          <Card type="inner" size="small" title="时长档位（扫码直充可选档）" extra={sectionButton('pricePacks')}>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              {packs.map((pack) => (
                <Space key={pack.id} align="center">
                  <InputNumber
                    min={1}
                    max={9999}
                    precision={0}
                    value={pack.hours}
                    style={{ width: 160 }}
                    onChange={(value) => updatePack(pack.id, { hours: value ?? 1 })}
                  />
                  <Typography.Text>小时</Typography.Text>
                  <InputNumber
                    min={0.01}
                    precision={2}
                    value={pack.amountYuan}
                    style={{ width: 180 }}
                    onChange={(value) => updatePack(pack.id, { amountYuan: value ?? 0 })}
                  />
                  <Typography.Text>元</Typography.Text>
                  <Button
                    type="text"
                    size="small"
                    danger
                    disabled={packs.length <= 1}
                    onClick={() => removePack(pack.id)}
                  >
                    删除
                  </Button>
                </Space>
              ))}
              <Button size="small" onClick={addPack}>
                + 添加档位
              </Button>
            </Space>
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="secondary">{updatedMeta(rows, 'pricePacks')}</Typography.Text>
            </div>
          </Card>

          <Card type="inner" size="small" title="公告弹窗" extra={sectionButton('notice')}>
            <Input.TextArea
              rows={3}
              maxLength={500}
              value={notice}
              onChange={(event) => setNotice(event.target.value)}
              placeholder="留空 = 商家端不弹公告"
            />
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="secondary">{updatedMeta(rows, 'notice')}</Typography.Text>
            </div>
          </Card>

          <Card type="inner" size="small" title="直播分钟扣减优先级" extra={sectionButton('quotaPriority')}>
            <Radio.Group
              value={priority}
              onChange={(event) => setPriority(event.target.value as PriorityMode)}
            >
              <Space direction="vertical">
                <Radio value="balance_quota">先扣时长余额，余额为 0 再回落当月免费直播分钟（默认）</Radio>
                <Radio value="quota_balance">先扣当月免费直播分钟，再用时长余额</Radio>
              </Space>
            </Radio.Group>
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="secondary">{updatedMeta(rows, 'quotaPriority')}</Typography.Text>
            </div>
          </Card>
        </Space>
      </Spin>
    </Card>
  );
}
