// 示例循环台本（谈单演示用，G7）：只读预设，不落库、不走生成配额。
// 内容为虚构演示口径，成稿逐条离线通过 scanSensitive（L1 不命中、L2 无提示）；
// 客户端「套用示例」把内容带入新建台本编辑器，保存时仍走 /api/loop-scripts 的
// 落库前敏感词扫描链路，合规红线不变。

import type { LoopItemKind } from './loopScript';

export interface LoopScriptSampleItem {
  kind: LoopItemKind;
  text: string;
  gapAfterSeconds: number;
}

export interface LoopScriptSample {
  /** 稳定示例 id（客户端预填新建台本编辑器用） */
  sampleId: string;
  /** 台本标题（套用后作为草稿标题，可再改） */
  title: string;
  /** 一句话场景说明（台本库示例区选择用） */
  subtitle: string;
  items: LoopScriptSampleItem[];
}

/** 谈单演示示例台本：以火锅团购为主，覆盖午市/家庭聚餐/夜宵三种话术节奏 */
export const loopScriptSamples: readonly LoopScriptSample[] = [
  {
    sampleId: 'hotpot-set-a',
    title: '火锅团购示例一 · 双人餐午市引流',
    subtitle: '双人套餐 · 午市短平快促单',
    items: [
      {
        kind: 'opening',
        text: '欢迎家人们来到直播间，还没安排午饭的朋友别急着走，今天给大家带来一份很实在的双人火锅套餐。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'product',
        text: '锅底牛油麻辣、番茄、菌汤三选一，配菜有肥牛卷、虾滑和时蔬拼盘，两个人吃分量刚好。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'coupon',
        text: '团购价只要九十九元，点下方小黄车就能下单，到店报手机号核销，不用提前预约。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'warmup',
        text: '刚进来的朋友点点关注，主播每天中午都在这，给大家挑附近实惠又好吃的店。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'closing',
        text: '分量够、价格实在，想吃的家人先囤一张，这周约朋友吃饭正好用上。',
        gapAfterSeconds: 2,
      },
    ],
  },
  {
    sampleId: 'hotpot-set-b',
    title: '火锅团购示例二 · 四人家庭聚餐',
    subtitle: '四人套餐 · 周末家庭/朋友聚会',
    items: [
      {
        kind: 'opening',
        text: '晚上好呀家人们，又到吃火锅的点了，今天主播带来一份适合一家人聚餐的四人套餐。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'product',
        text: '四宫格锅底把麻辣、番茄、菌汤、清汤一次尝遍；荤菜有肥牛、羔羊肉和午餐肉，素菜配了土豆、山药、娃娃菜、金针菇。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'coupon',
        text: '四人餐团购价一百九十八元，人均不到五十，下单后三十天内都有效，周末带家人来刚好合适。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'warmup',
        text: '喜欢这家店的朋友把关注点一点，下次开播不迷路，直播间也会不定期送福利。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'closing',
        text: '这家离地铁口近，停车也方便，团好券约好时间直接来就行，省心又划算。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'custom',
        text: '主播再提醒一句：团购券到店出示给店员核销就能用，不需要提前电话预约。',
        gapAfterSeconds: 2,
      },
    ],
  },
  {
    sampleId: 'hotpot-set-c',
    title: '火锅团购示例三 · 深夜夜宵单人场',
    subtitle: '单人小火锅 · 夜宵档营业晚',
    items: [
      {
        kind: 'opening',
        text: '夜深了还在刷直播的朋友辛苦啦，主播送上一份热乎的夜宵小火锅，看完就能安排。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'product',
        text: '单人小火锅配麻辣红油锅底，加一份嫩牛肉、一份鸭血和一碟小酥肉，一个人吃也很有滋味。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'coupon',
        text: '夜宵档团购价五十九元，下单后今天就能用，店里营业到凌晨两点，下班晚也不怕没热饭吃。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'warmup',
        text: '刚进来的朋友点点关注，夜宵场每晚十点准时开播，饿了的家人别错过。',
        gapAfterSeconds: 2,
      },
      {
        kind: 'closing',
        text: '夜宵券份数不多，想吃的朋友先囤上，睡前刷到就是缘分，明天夜里安排一顿。',
        gapAfterSeconds: 2,
      },
    ],
  },
];

/** 按示例 id 查找：查不到返回 undefined（客户端按此兜底提示） */
export function findLoopScriptSample(sampleId: string): LoopScriptSample | undefined {
  return loopScriptSamples.find((sample) => sample.sampleId === sampleId);
}
