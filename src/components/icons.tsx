import { Feather } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

// 图标系统（第一版）
// - 统一到 Feather 单一线宽家族：全部描边、同一线宽，不再混用实心图标
// - 尺寸只允许 4 档，调用方传任意数字会被就近归一到档位，避免 12/13/15/17… 的散乱
// - 语义名（home/stylist/tryon…）是新增代码的唯一写法；旧 Ionicons 名保留映射，
//   让还没迁完的调用点继续可用，迁移时不必一次性改完 51 处 JSX

type FeatherName = ComponentProps<typeof Feather>['name'];

const SEMANTIC = {
  home: 'home',
  chat: 'message-circle',
  create: 'plus',
  tryon: 'layers', // 试衣：衣物叠上身，比「一件衬衫」更抽象克制
  profile: 'user',
  stylist: 'compass', // 搭配师 / AI 建议：停用 sparkles
  video: 'video',
  pose: 'move', // 姿势：一个「人」的抽象位移感，比人物剪影更克制
  camera: 'camera',
  gallery: 'image',
  grid: 'grid',
  check: 'check',
  checkCircle: 'check-circle',
  chevronRight: 'chevron-right',
  chevronLeft: 'chevron-left',
  chevronUp: 'chevron-up',
  close: 'x',
  search: 'search',
  edit: 'edit-2',
  trash: 'trash-2',
  refresh: 'refresh-cw',
  settings: 'sliders',
  swap: 'repeat',
  globe: 'globe',
  upload: 'upload-cloud',
  play: 'play-circle',
  arrowUp: 'arrow-up',
  palette: 'droplet',
  offline: 'cloud-off',
  test: 'zap',
  calendar: 'calendar',
  mail: 'mail',
  userPlus: 'user-plus',
  heart: 'heart',
  bookmark: 'bookmark',
  share: 'share-2',
  plus: 'plus',
  minus: 'minus',
  arrowRight: 'arrow-right',
  arrowLeft: 'arrow-left',
  info: 'info',
  shuffle: 'shuffle',
  sun: 'sun',
  cloud: 'cloud',
  rain: 'cloud-rain',
  snow: 'cloud-snow',
  thunder: 'cloud-lightning',
  fog: 'wind',
} satisfies Record<string, FeatherName>;

export type IconName = keyof typeof SEMANTIC;

const LEGACY_FROM_IONICONS: Record<string, IconName> = {
  'home': 'home',
  'home-outline': 'home',
  'chatbubble-ellipses': 'chat',
  'chatbubble-ellipses-outline': 'chat',
  'add': 'create',
  'shirt': 'tryon',
  'shirt-outline': 'tryon',
  'person': 'profile',
  'person-outline': 'profile',
  'person-add-outline': 'userPlus',
  'sparkles': 'stylist',
  'sparkles-outline': 'stylist',
  'videocam': 'video',
  'videocam-outline': 'video',
  'camera-outline': 'camera',
  'image-outline': 'gallery',
  'images-outline': 'grid',
  'checkmark': 'check',
  'checkmark-circle': 'checkCircle',
  'chevron-forward': 'chevronRight',
  'chevron-back': 'chevronLeft',
  'chevron-up': 'chevronUp',
  'close': 'close',
  'search-outline': 'search',
  'create-outline': 'edit',
  'trash-outline': 'trash',
  'refresh-outline': 'refresh',
  'settings-outline': 'settings',
  'swap-horizontal': 'swap',
  'earth-outline': 'globe',
  'cloud-upload-outline': 'upload',
  'play-circle': 'play',
  'arrow-up': 'arrowUp',
  'color-palette-outline': 'palette',
  'cloud-offline-outline': 'offline',
  'flask-outline': 'test',
  'calendar-outline': 'calendar',
  'mail-outline': 'mail',
  'body-outline': 'profile',
};

export type LegacyIconName = keyof typeof LEGACY_FROM_IONICONS;

const SIZE_STEPS = [14, 18, 22, 26, 30] as const;

export type IconSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_BY_KEY: Record<IconSize, number> = { xs: 14, sm: 18, md: 22, lg: 26 };

function snapSize(size: number) {
  let closest: number = SIZE_STEPS[0];
  for (const step of SIZE_STEPS) {
    if (Math.abs(step - size) < Math.abs(closest - size)) closest = step;
  }
  return closest;
}

function resolveGlyph(name: IconName | LegacyIconName): FeatherName {
  if (name in SEMANTIC) return SEMANTIC[name as IconName];
  const mapped = LEGACY_FROM_IONICONS[name];
  return mapped ? SEMANTIC[mapped] : 'circle';
}

type Props = {
  name: IconName | LegacyIconName;
  size?: IconSize | number;
  color?: string;
};

export function AppIcon({ name, size = 'md', color }: Props) {
  const px = typeof size === 'number' ? snapSize(size) : SIZE_BY_KEY[size];
  return <Feather name={resolveGlyph(name)} size={px} color={color} />;
}
