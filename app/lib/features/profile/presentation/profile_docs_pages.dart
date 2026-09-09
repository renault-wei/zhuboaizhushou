import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:starvoice_app/core/config/app_meta.dart';
import 'package:starvoice_app/core/theme/app_colors.dart';
import 'package:starvoice_app/core/theme/theme_tokens.dart';

/// 「我的」页帮助与协议类静态页合集。
/// 页面文案为产品侧初稿，正式对外公示前需经法务 / 运营复核定稿；
/// 声音授权协议等需签署的合同仍走服务端下发（/api/agreements/voice）。

/// 页面章节：标题 + 段落。
class _DocSection {
  const _DocSection(this.title, this.paragraphs);

  final String title;
  final List<String> paragraphs;
}

/// 通用文本页骨架：标题 + 若干章节 + 可选的免责尾注。
class _DocsScaffold extends StatelessWidget {
  const _DocsScaffold({
    required this.pageKey,
    required this.title,
    required this.sections,
    this.disclaimer,
  });

  final Key pageKey;
  final String title;
  final List<_DocSection> sections;
  final String? disclaimer;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: pageKey,
      appBar: AppBar(title: Text(title)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: <Widget>[
          if (disclaimer != null) ...<Widget>[
            _TipNote(text: disclaimer!),
            const SizedBox(height: 16),
          ],
          for (final section in sections) ...<Widget>[
            _SectionTitle(section.title),
            for (final paragraph in section.paragraphs) ...<Widget>[
              _BodyText(paragraph),
              const SizedBox(height: 10),
            ],
            const SizedBox(height: 6),
          ],
        ],
      ),
    );
  }
}

/// 顶部提示条（初稿 / 说明类文案）。
class _TipNote extends StatelessWidget {
  const _TipNote({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.warningSoft,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(
            Icons.info_outline_rounded,
            size: 16,
            color: AppColors.warning,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(fontSize: 12, color: AppColors.warning),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8, top: 4),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 15,
          fontWeight: FontWeight.bold,
          color: context.tokenTextStrong,
        ),
      ),
    );
  }
}

class _BodyText extends StatelessWidget {
  const _BodyText(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: TextStyle(
        fontSize: 13.5,
        height: 1.7,
        color: context.tokenTextBody,
      ),
    );
  }
}

/// 隐私政策（/profile/privacy）：App 内初稿页，正式版待复核后公示。
class PrivacyPolicyPage extends StatelessWidget {
  const PrivacyPolicyPage({super.key});

  static const List<_DocSection> _sections = <_DocSection>[
    _DocSection('1. 我们收集的信息', <String>[
      '账号信息：登录使用的手机号、用户 ID 与注册时间；',
      '声音素材：你在使用声音克隆时录制的语音样本与生成的克隆音色特征；',
      '直播配置：开播场次、所选音色、话术 / 循环台本与绑定的商品信息；',
      '消费记录：时长充值、卡密核销、直播扣费与账单流水；',
      '客服沟通：你联系官方客服时提交的问题与处理记录。',
    ]),
    _DocSection('2. 信息的使用', <String>[
      '用于提供登录、声音克隆、话术生成、AI 直播与计费结算等核心功能；',
      '用于生成与播放 AI 合成语音；',
      '用于账号安全、异常检测与客服服务。',
    ]),
    _DocSection('3. 第三方服务', <String>[
      '话术生成与语音合成会调用第三方 AI 服务（如大模型、语音合成供应商），仅按需传输必要的文本 / 声音特征，不会用于其他目的；',
      '第三方服务详见对应服务商的隐私条款。',
    ]),
    _DocSection('4. 存储与保护', <String>[
      '你的录音素材、克隆音色、话术与订单数据存储在服务端；我们采取访问控制与加密等措施保护数据安全。',
    ]),
    _DocSection('5. 你的权利', <String>[
      '你可随时在音色库删除录音样本与克隆音色；',
      '如需更正账号信息、删除账号或行使其他个人信息权利，请联系官方客服，我们核验身份后在合理期限内处理；',
      '声音克隆相关删除 / 撤销机制以《声音授权协议》为准。',
    ]),
    _DocSection('6. 政策更新', <String>['本政策更新后会通过 App 内公告等方式公示；重大变更会显著提示。']),
  ];

  @override
  Widget build(BuildContext context) {
    return const _DocsScaffold(
      pageKey: Key('privacyPolicyPage'),
      title: '隐私政策',
      sections: _sections,
      disclaimer: '本文为产品演示初稿，正式对外前需经法务复核并以公示版本为准。',
    );
  }
}

/// 用户服务协议（/profile/terms）：App 内初稿页，正式版待复核后公示。
class TermsOfServicePage extends StatelessWidget {
  const TermsOfServicePage({super.key});

  static const List<_DocSection> _sections = <_DocSection>[
    _DocSection('1. 服务说明', <String>[
      '星辰语音为本地团购商家提供 AI 语音直播辅助工具：克隆 / 选用音色、生成带货话术、在你自己开播的直播间中循环介绍商品，并在真人出镜的间歇用 AI 语音补位。',
    ]),
    _DocSection('2. 账号与使用', <String>[
      '你应对账号下的操作负责，妥善保管验证码；开播与发声内容需符合法律法规与所在直播平台规则。',
    ]),
    _DocSection('3. 声音授权', <String>['使用克隆音色前，你需完成《声音授权协议》签署；不得克隆他人声音用于侵权用途。']),
    _DocSection('4. 内容合规', <String>[
      '话术生成与开播前会进行敏感词扫描，命中拦截级词直接阻断；AI 回复内容由大模型生成，可能存在偏差，请保持真人监控。',
    ]),
    _DocSection('5. 计费与退款', <String>[
      '充值时长按实际入账后的直播在线分钟扣减，规则以收银台展示为准；退款与账号问题请联系官方客服人工处理。',
    ]),
    _DocSection('6. 免责与联系', <String>[
      '因直播平台策略、网络或第三方服务导致的异常，我们将在合理范围内协助处理；如需注销账号或行使权利，请联系官方客服。',
    ]),
  ];

  @override
  Widget build(BuildContext context) {
    return const _DocsScaffold(
      pageKey: Key('termsOfServicePage'),
      title: '用户服务协议',
      sections: _sections,
      disclaimer: '本文为产品演示初稿，正式对外前需经法务复核并以公示版本为准。',
    );
  }
}

/// AI 语音直播说明（/profile/ai-info）：介绍 AI 语音直播的用法与合规口径，
/// 纯说明页，不含可关闭的合规开关。
class AiLiveInfoPage extends StatelessWidget {
  const AiLiveInfoPage({super.key});

  static const List<_DocSection> _sections = <_DocSection>[
    _DocSection('AI 语音直播是什么', <String>[
      '你在自己选择的直播平台开播，App 在后台用 AI 合成语音循环介绍团购商品、在空档回应弹幕；真人出镜时 AI 语音停口，两者交替配合。',
    ]),
    _DocSection('怎么用', <String>[
      '第一步：完成声音授权并选好音色（克隆音色或火山预设）；',
      '第二步：生成带货话术并绑定循环台本；',
      '第三步：完善场次后进入直播工作台，开启出声（本机出声或助播机出声）；',
      '第四步：用测试弹幕验证 AI 回复，确认无误后正式开播。',
    ]),
    _DocSection('合规要求', <String>[
      '直播画面必须叠加「AI 智能直播」角标，App 不提供关闭入口；',
      '使用克隆音色前必须完成《声音授权协议》签署并存档；',
      '话术生成后、开播前自动执行敏感词扫描，命中拦截级词直接阻断；',
      '请遵守所在直播平台对 AI 生成内容与商业直播的规则，直播主体与责任由开播商家承担。',
    ]),
    _DocSection('注意事项', <String>[
      'AI 回复由大模型实时生成，可能存在不准确表达，请保持真人监控并及时静音接管；',
      '建议为循环台本提前试听，保证语速、间隔与真人直播节奏匹配。',
    ]),
  ];

  @override
  Widget build(BuildContext context) {
    return const _DocsScaffold(
      pageKey: Key('aiLiveInfoPage'),
      title: 'AI 语音直播说明',
      sections: _sections,
    );
  }
}

/// 官方客服（/profile/support）：展示客服时段与可配置的联系方式，
/// 客服微信未配置前仅提示「待配置」，不展示编造号码。
class SupportPage extends StatelessWidget {
  const SupportPage({super.key});

  Future<void> _copyWechat(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final wechat = SupportContact.supportWechat.trim();
    if (wechat.isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('客服微信号待配置，敬请期待')));
      return;
    }
    await Clipboard.setData(ClipboardData(text: wechat));
    if (context.mounted) {
      messenger.showSnackBar(const SnackBar(content: Text('已复制客服微信号')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final wechat = SupportContact.supportWechat.trim();
    final wechatText = wechat.isEmpty ? '待配置（运营上线前提供）' : wechat;
    return Scaffold(
      key: const Key('supportPage'),
      appBar: AppBar(title: const Text('官方客服')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          Card(
            margin: EdgeInsets.zero,
            child: ListTile(
              leading: const Icon(Icons.chat_rounded, size: 22),
              title: const Text('客服微信'),
              subtitle: Text(
                wechatText,
                style: TextStyle(fontSize: 12, color: context.tokenTextBody),
              ),
              trailing: TextButton(
                key: const Key('profileCopySupportWechatButton'),
                onPressed: () => _copyWechat(context),
                child: const Text('复制'),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Card(
            margin: EdgeInsets.zero,
            child: ListTile(
              leading: const Icon(Icons.schedule_rounded, size: 22),
              title: const Text('在线服务时间'),
              subtitle: Text(
                SupportContact.serviceHours,
                style: TextStyle(fontSize: 12, color: context.tokenTextBody),
              ),
            ),
          ),
          const SizedBox(height: 16),
          const _TipNote(text: '官方客服不会索要你的登录验证码与支付密码，谨防诈骗。'),
          const SizedBox(height: 16),
          _BodyText(
            '充值到账、卡密、退款与账号注销等事项，请先联系官方客服并提供账号手机号，'
            '客服核验身份后协助处理。',
          ),
        ],
      ),
    );
  }
}

/// 关于星辰语音（/profile/about）：产品定位 + 当前版本 + 版权信息。
class AboutPage extends StatelessWidget {
  const AboutPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('aboutPage'),
      appBar: AppBar(title: const Text('关于星辰语音')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: <Widget>[
          const SizedBox(height: 8),
          Center(
            child: Container(
              width: 72,
              height: 72,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: <Color>[AppColors.primary, AppColors.primaryDark],
                ),
                borderRadius: BorderRadius.circular(22),
              ),
              child: const Icon(
                Icons.auto_awesome_rounded,
                color: Colors.white,
                size: 34,
              ),
            ),
          ),
          const SizedBox(height: 14),
          Center(
            child: Text(
              AppMeta.appName,
              style: Theme.of(context).textTheme.titleLarge
                  ?.copyWith(fontWeight: FontWeight.bold),
            ),
          ),
          const SizedBox(height: 4),
          Center(
            child: Text(
              AppMeta.slogan,
              style: TextStyle(fontSize: 13, color: context.tokenTextBody),
            ),
          ),
          const SizedBox(height: 8),
          Center(
            child: Text(
              'v${AppMeta.version}',
              key: const Key('profileVersionLabel'),
              style: TextStyle(fontSize: 12, color: context.tokenTextHint),
            ),
          ),
          const SizedBox(height: 24),
          const _SectionTitle('产品简介'),
          const _BodyText(
            '星辰语音面向本地团购商家：录制你的声音生成专属克隆音色，AI 生成团购带货话术，'
            '在你自己开播的直播间中后台循环介绍商品、回应弹幕，真人出镜与 AI 语音交替补位，'
            '让商家用一台手机也能长期稳定地做 AI 直播。',
          ),
          const SizedBox(height: 20),
          const _SectionTitle('合规声明'),
          const _BodyText(
            'AI 直播画面叠加「AI 智能直播」角标且不可关闭；声音克隆前需完成《声音授权协议》'
            '签署；话术开播前自动通过敏感词扫描。',
          ),
          const SizedBox(height: 28),
          Center(
            child: Text(
              AppMeta.copyright,
              style: TextStyle(fontSize: 12, color: context.tokenTextHint),
            ),
          ),
        ],
      ),
    );
  }
}
