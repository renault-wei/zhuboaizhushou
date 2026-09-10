// ---------- 火山预设音色目录（只读内置常量，不调火山接口）----------

/** 音色分组：客户端按此顺序分组展示 */
export interface VolcPresetGroup {
  id: string;
  label: string;
}

/** 分组口径：带货口播为主力，讲解解说是长口播场景，客服营销线为机构音色 */
export const VOLC_PRESET_GROUPS: VolcPresetGroup[] = [
  { id: 'broadcast', label: '带货口播' },
  { id: 'narration', label: '讲解解说' },
  { id: 'service', label: '客服营销' },
];

/** 预设音色条目：id 即火山发音人 ID（TTS speaker 参数），name 为客户端展示名 */
export interface VolcPresetVoice {
  id: string;
  name: string;
  /** 性别：female 女声 / male 男声（客户端在组内再分性别展示） */
  gender: 'female' | 'male';
  /** 所属分组 id：取值见 VOLC_PRESET_GROUPS */
  group: string;
  /** 是否推荐：客户端组内置顶并标「推荐」 */
  recommended: boolean;
}

/** 新建场次的默认音色（推荐女声）：音色选择面板首选，服务端 / 客户端共用同一常量 */
export const DEFAULT_VOLC_PRESET_ID = 'zh_female_vv_uranus_bigtts';

/**
 * 可用预设：全部为「豆包语音合成模型 2.0」音色（voice_type 后缀 _uranus_bigtts），
 * 与当前资源 ID seed-tts-2.0 匹配，逐条实合成验证可用（2026-09-10 全量复测）。
 *
 * 说明：
 * - 音色不单独收费，按合成字符计费；音色数量不影响成本，故不再手工筛选数量；
 * - 1.0 系列（_mars_/_moon_/_wvae_ 等）与 2.0 资源 ID 不匹配（报 55000000），如需方言口音音色，
 *   要另配资源 ID 走 1.0 通道，本目录暂不收录；
 * - 命名规则：2.0 为 zh_{gender}_{音色名}_uranus_bigtts；ICL_ 前缀为客服/营销线音色；
 * - group / recommended 为展示元数据（分组 + 推荐置顶），不参与合成请求。
 */
export const VOLC_PRESET_VOICES: VolcPresetVoice[] = [
  // 通用 / 带货口播（主力）
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', gender: 'female', group: 'broadcast', recommended: true },
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0', gender: 'male', group: 'broadcast', recommended: true },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_female_sophie_uranus_bigtts', name: '魅力苏菲 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 2.0', gender: 'female', group: 'broadcast', recommended: true },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_tianmeiyueyue_uranus_bigtts', name: '甜美悦悦 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_qinqienv_uranus_bigtts', name: '亲切女声 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_kailangjiejie_uranus_bigtts', name: '开朗姐姐 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_qiaopinv_uranus_bigtts', name: '俏皮女声 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_liuchangnv_uranus_bigtts', name: '流畅女声 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_zhixingnv_uranus_bigtts', name: '知性女声 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_wenroushunv_uranus_bigtts', name: '温柔淑女 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_wenrouxiaoya_uranus_bigtts', name: '温柔小雅 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_meilinvyou_uranus_bigtts', name: '魅力女友 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_roumeinvyou_uranus_bigtts', name: '柔美女友 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_xinlingjitang_uranus_bigtts', name: '心灵鸡汤 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_female_tvbnv_uranus_bigtts', name: 'TVB女声 2.0', gender: 'female', group: 'broadcast', recommended: false },
  { id: 'zh_male_wennuanahu_uranus_bigtts', name: '温暖阿虎 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_huolixiaoge_uranus_bigtts', name: '活力小哥 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_qingshuangnanda_uranus_bigtts', name: '清爽男大 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_yangguangqingnian_uranus_bigtts', name: '阳光青年 2.0', gender: 'male', group: 'broadcast', recommended: true },
  { id: 'zh_male_ruyayichen_uranus_bigtts', name: '儒雅逸辰 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_ruyaqingnian_uranus_bigtts', name: '儒雅青年 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_wenrouxiaoge_uranus_bigtts', name: '温柔小哥 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_gaolengchenwen_uranus_bigtts', name: '高冷沉稳 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_dongfanghaoran_uranus_bigtts', name: '东方浩然 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_yuanboxiaoshu_uranus_bigtts', name: '渊博小叔 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_linjiananhai_uranus_bigtts', name: '邻家男孩 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_youyoujunzi_uranus_bigtts', name: '悠悠君子 2.0', gender: 'male', group: 'broadcast', recommended: false },
  { id: 'zh_male_kailangxuezhang_uranus_bigtts', name: '开朗学长 2.0', gender: 'male', group: 'broadcast', recommended: false },
  // 讲解 / 解说（长口播、憋单讲解更贴）
  { id: 'zh_male_jieshuoxiaoming_uranus_bigtts', name: '解说小明 2.0', gender: 'male', group: 'narration', recommended: false },
  { id: 'zh_male_cixingjieshuonan_uranus_bigtts', name: '磁性解说男声 2.0', gender: 'male', group: 'narration', recommended: false },
  { id: 'zh_male_guanggaojieshuo_uranus_bigtts', name: '广告解说 2.0', gender: 'male', group: 'narration', recommended: false },
  { id: 'zh_male_shenyeboke_uranus_bigtts', name: '深夜播客 2.0', gender: 'male', group: 'narration', recommended: false },
  // 客服 / 营销线
  { id: 'zh_female_kefunvsheng_uranus_bigtts', name: '暖阳女声 2.0', gender: 'female', group: 'service', recommended: false },
  { id: 'ICL_uranus_zh_female_kefuwanjun_tob', name: '客服婉君 2.0', gender: 'female', group: 'service', recommended: false },
  { id: 'ICL_uranus_zh_female_yingxiaokefu_v2_tob', name: '营销小楠 2.0', gender: 'female', group: 'service', recommended: false },
];

/** 判断是否为内置火山预设音色 id（服务端写入前的白名单校验） */
export function isVolcPresetId(id: string): boolean {
  return VOLC_PRESET_VOICES.some((preset) => preset.id === id);
}

/** 查内置预设音色条目：不在白名单返回 undefined（口播 / 试听解析音色用） */
export function findVolcPreset(id: string): VolcPresetVoice | undefined {
  return VOLC_PRESET_VOICES.find((preset) => preset.id === id);
}
