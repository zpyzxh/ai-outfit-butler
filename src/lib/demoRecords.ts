import { DEMO_MODE } from '@/lib/demo';

/**
 * 演示模式下的「我的」页数据。
 *
 * 为什么不直接往库里插几条 owner 是访客的记录：`tryon_tasks` 的读策略是
 * 「owner_user_id = auth.uid()」，访客的匿名 uid 在打开页面之前根本不知道，
 * 没法提前写进去；而放宽策略让所有人看到别的记录，是把安全模型拆了换展示效果，
 * 得不偿失。所以演示数据放在前端，并且**显式标注是演示记录**。
 *
 * 用的图都是本项目真实跑出来的结果（复制到了公开桶），不是网上找的素材。
 */

const PUBLIC = 'https://ydcajujmhlksjgrhjgtl.supabase.co/storage/v1/object/public';

/**
 * 三条真实产出（原始记录在私有桶里，这里用公开副本，访客无需登录即可显示）。
 * 命名跟图片里实际穿的那件对齐 —— 演示数据的标题和画面对不上时，被面试官一眼看出会很减分。
 */
const RESULT_OUTER = `${PUBLIC}/inspiration-posts/demo/result-1-1794896028227.jpg`; // 米色羊毛西装外套
const RESULT_PANTS = `${PUBLIC}/inspiration-posts/demo/result-2-1794896049229.jpg`; // 驼色百褶阔腿裤
const RESULT_KNIT = `${PUBLIC}/inspiration-posts/demo/knit-frame-1794923598940.jpg`; // 奶白针织长袖（视频首帧）
/** 真实的 5 秒成片（含转身定格背面），源任务 3d92efdc-… */
const MOTION = `${PUBLIC}/garments/demo/sample-motion.mp4`;

export type DemoHistoryTask = {
  id: string;
  user_photo_url: string | null;
  first_frame_url: string | null;
  result_url: string | null;
  status: string;
  stage?: string | null;
  output_type?: string | null;
  pose_id?: string | null;
  error_msg?: string | null;
  created_at: string;
  garment: { id: string; name: string; category: string } | null;
};

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

export const DEMO_HISTORY: DemoHistoryTask[] = [
  {
    id: 'demo-tryon-outer',
    user_photo_url: `${PUBLIC}/garments/demo/sample-fullbody.jpg`,
    first_frame_url: RESULT_OUTER,
    result_url: RESULT_OUTER,
    status: 'done',
    stage: 'tryon',
    output_type: 'image',
    created_at: daysAgo(0.2),
    // 真实 garment id，点「再试一件」能预选那件单品
    garment: { id: 'a989c595-dece-459c-8363-28d8eb23ee94', name: '米色羊毛西装外套', category: '外套' },
  },
  {
    id: 'demo-tryon-pants',
    user_photo_url: `${PUBLIC}/garments/demo/sample-fullbody.jpg`,
    first_frame_url: RESULT_PANTS,
    result_url: RESULT_PANTS,
    status: 'done',
    stage: 'tryon',
    output_type: 'image',
    created_at: daysAgo(1.3),
    garment: { id: 'e943f181-61bd-4f31-aad1-8796c0f2ba44', name: '驼色百褶阔腿裤', category: '下装' },
  },
  {
    id: 'demo-video-knit',
    user_photo_url: `${PUBLIC}/garments/demo/sample-fullbody.jpg`,
    first_frame_url: RESULT_KNIT,
    result_url: MOTION,
    status: 'done',
    stage: 'video',
    output_type: 'video',
    created_at: daysAgo(2.1),
    garment: { id: 'e38ef13d-0653-44b0-80cd-a4b2cba994ba', name: '奶白针织长袖', category: '上装' },
  },
];

/** 演示记录 id 前缀：用来判断这条能不能删（演示记录删不了） */
export const DEMO_RECORD_PREFIX = 'demo-';

export const isDemoRecord = (id: string): boolean => id.startsWith(DEMO_RECORD_PREFIX);

/** 只有演示模式、且本机确实一条真实记录都没有时，才用演示数据顶上 */
export const shouldUseDemoHistory = (realCount: number): boolean => DEMO_MODE && realCount === 0;
