import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 验证码回传开关（SMS_DEV_MODE）单元测试：
 * 生产环境默认不回传验证码；显式开启 SMS_DEV_MODE 后在响应里回传明文，
 * 用于演示/验收环境登录（App 拿到后自动填入）。
 */

const originalNodeEnv = process.env.NODE_ENV;

async function loadSmsService() {
  vi.resetModules();
  const mod = await import('../src/services/sms');
  return mod.smsService;
}

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  delete process.env.SMS_DEV_MODE;
  vi.resetModules();
});

describe('SMS_DEV_MODE 验证码回传开关', () => {
  it('生产环境且未开启开关时不回传验证码', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SMS_DEV_MODE;

    const sms = await loadSmsService();
    const result = await sms.sendCode('13900001111');

    expect(result.code).toBeUndefined();
  });

  it('生产环境开启开关后回传验证码明文', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SMS_DEV_MODE = 'true';

    const sms = await loadSmsService();
    const result = await sms.sendCode('13900002222');

    expect(result.code).toMatch(/^\d{6}$/);
  });
});
