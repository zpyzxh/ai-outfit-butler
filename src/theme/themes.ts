import { Platform, type TextStyle, type ViewStyle } from 'react-native';

export type ThemeId = 'runway' | 'atelier' | 'concrete' | 'afterhours' | 'song';

type TypeStyle = Pick<TextStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'letterSpacing' | 'lineHeight' | 'textTransform' | 'color'>;

export type Theme = {
  id: ThemeId;
  name: string;
  en: string;
  tagline: string;
  /** 风格选择器里的三点预览色 */
  swatch: [string, string, string];
  statusBar: 'light' | 'dark';
  colors: {
    background: string;
    surface: string;
    surfaceAlt: string;
    text: string;
    muted: string;
    border: string;
    accent: string;
    accentSoft: string;
    danger: string;
    success: string;
    onImage: string;
    onImageMuted: string;
    /** 图片上的压暗遮罩（纯色，避免引入渐变依赖） */
    scrim: string;
    /** 弹层背后遮罩 */
    overlay: string;
  };
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number };
  radius: { sm: number; md: number; lg: number; pill: number };
  fonts: { display?: string; body?: string };
  type: {
    display: TypeStyle;
    title: TypeStyle;
    section: TypeStyle;
    body: TypeStyle;
    caption: TypeStyle;
    label: TypeStyle;
  };
  card: {
    layout: 'overlay' | 'stacked';
    radius: number;
    borderWidth: number;
    borderColor: string;
    /** 图片四周内缩，做纸边 / 相纸边 */
    inset: number;
    imageRadius: number;
    metaBackground: string;
    shadow?: ViewStyle;
  };
  button: {
    background: string;
    color: string;
    radius: number;
    borderWidth: number;
    borderColor: string;
    letterSpacing: number;
    minHeight: number;
  };
  chip: {
    background: string;
    color: string;
    borderColor: string;
    radius: number;
    activeBackground: string;
    activeColor: string;
    activeBorderColor: string;
  };
  nav: {
    background: string;
    borderColor: string;
    borderWidth: number;
    height: number;
    active: string;
    inactive: string;
    labelSize: number;
    floating: boolean;
    fabBackground: string;
    fabColor: string;
    fabRadius: number;
    fabBorderWidth: number;
    fabBorderColor: string;
    fabSize: number;
  };
};

const serifDisplay = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia, "Songti SC", SimSun, serif',
});

const songSerif = Platform.select({
  ios: 'Songti SC',
  android: 'serif',
  default: '"Songti SC", SimSun, Georgia, serif',
});

const sansBody = Platform.select({
  ios: undefined,
  android: 'sans-serif',
  default: undefined,
});

// 时装白：参考「黑白时装电商」版式——纯白页面、近黑作为唯一强调色、衬线标题 + 无衬线 UI、
// 胶囊按钮与筛选、发丝线卡片、浮起的黑色底栏。彩色只留给照片本身。
export const runway: Theme = {
  id: 'runway',
  name: '时装白',
  en: 'Fashion Editorial',
  tagline: '纯白、黑胶囊、衬线标题',
  swatch: ['#FFFFFF', '#111111', '#F4F4F5'],
  statusBar: 'dark',
  colors: {
    background: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceAlt: '#F4F4F5',
    text: '#111113',
    muted: '#6B6B70',
    border: '#E9E9EC',
    accent: '#111111',
    accentSoft: '#F2F2F4',
    danger: '#B3261E',
    success: '#2F6B4F',
    onImage: '#FFFFFF',
    onImageMuted: 'rgba(255,255,255,0.86)',
    scrim: 'rgba(0,0,0,0.46)',
    overlay: 'rgba(12,12,14,0.42)',
  },
  spacing: { xs: 4, sm: 10, md: 18, lg: 26, xl: 40 },
  radius: { sm: 8, md: 14, lg: 20, pill: 999 },
  fonts: { display: serifDisplay, body: sansBody },
  type: {
    display: { fontFamily: serifDisplay, fontSize: 26, fontWeight: '400', letterSpacing: -0.4, lineHeight: 31 },
    title: { fontFamily: serifDisplay, fontSize: 18, fontWeight: '400', letterSpacing: -0.1 },
    section: { fontFamily: sansBody, fontSize: 13, fontWeight: '600', letterSpacing: 0.1, color: '#111113' },
    body: { fontFamily: sansBody, fontSize: 13, lineHeight: 21 },
    caption: { fontSize: 11, lineHeight: 16 },
    label: { fontSize: 10, fontWeight: '600', letterSpacing: 0.6 },
  },
  card: {
    layout: 'overlay',
    radius: 20,
    borderWidth: 1,
    borderColor: '#E9E9EC',
    inset: 0,
    imageRadius: 20,
    metaBackground: '#FFFFFF',
  },
  button: {
    background: '#111111',
    color: '#FFFFFF',
    radius: 999,
    borderWidth: 0,
    borderColor: 'transparent',
    letterSpacing: 0.3,
    minHeight: 50,
  },
  chip: {
    background: '#FFFFFF',
    color: '#55555A',
    borderColor: '#E2E2E6',
    radius: 999,
    activeBackground: '#111111',
    activeColor: '#FFFFFF',
    activeBorderColor: '#111111',
  },
  nav: {
    background: '#111111',
    borderColor: 'transparent',
    borderWidth: 0,
    height: 62,
    active: '#FFFFFF',
    inactive: '#9A9A9F',
    labelSize: 9,
    floating: true,
    fabBackground: '#FFFFFF',
    fabColor: '#111111',
    fabRadius: 999,
    fabBorderWidth: 0,
    fabBorderColor: 'transparent',
    fabSize: 44,
  },
};

export const atelier: Theme = {
  id: 'atelier',
  name: '纸感画报',
  en: 'Atelier Paper',
  tagline: '暖纸、衬线、砖红',
  swatch: ['#F7F4EF', '#B9553B', '#17171A'],
  statusBar: 'dark',
  colors: {
    background: '#F7F4EF',
    surface: '#FFFFFF',
    surfaceAlt: '#EDE6DC',
    text: '#17171A',
    muted: '#827A72',
    border: '#E8E0D7',
    accent: '#B9553B',
    accentSoft: '#FBEDE8',
    danger: '#C0392B',
    success: '#39735A',
    onImage: '#FFFFFF',
    onImageMuted: 'rgba(255,255,255,0.82)',
    scrim: 'rgba(26,20,16,0.46)',
    overlay: 'rgba(24,18,14,0.42)',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 6, md: 12, lg: 20, pill: 999 },
  fonts: { display: serifDisplay, body: sansBody },
  type: {
    display: { fontFamily: serifDisplay, fontSize: 23, fontWeight: '700', letterSpacing: -0.2 },
    title: { fontFamily: serifDisplay, fontSize: 18, fontWeight: '700', letterSpacing: 0 },
    section: { fontSize: 16, fontWeight: '700', color: '#17171A' },
    body: { fontFamily: sansBody, fontSize: 13, lineHeight: 21 },
    caption: { fontSize: 11, lineHeight: 17 },
    label: { fontSize: 9, fontWeight: '700', letterSpacing: 1.25 },
  },
  card: {
    layout: 'overlay',
    radius: 20,
    borderWidth: 0,
    borderColor: 'transparent',
    inset: 0,
    imageRadius: 20,
    metaBackground: '#FFFFFF',
  },
  button: {
    background: '#B9553B',
    color: '#FFFFFF',
    radius: 20,
    borderWidth: 0,
    borderColor: 'transparent',
    letterSpacing: 0,
    minHeight: 52,
  },
  chip: {
    background: '#FFFFFF',
    color: '#827A72',
    borderColor: '#E8E0D7',
    radius: 18,
    activeBackground: '#B9553B',
    activeColor: '#FFFFFF',
    activeBorderColor: '#B9553B',
  },
  nav: {
    background: '#FFFFFF',
    borderColor: '#E8E0D7',
    borderWidth: 1,
    height: 72,
    active: '#B9553B',
    inactive: '#827A72',
    labelSize: 11,
    floating: false,
    fabBackground: '#B9553B',
    fabColor: '#FFFFFF',
    fabRadius: 23,
    fabBorderWidth: 3,
    fabBorderColor: '#F7F4EF',
    fabSize: 46,
  },
};

export const concrete: Theme = {
  id: 'concrete',
  name: '冷灰水泥',
  en: 'Concrete Editorial',
  tagline: '冷灰、直角、留白',
  swatch: ['#F2F2EF', '#2F4B41', '#101010'],
  statusBar: 'dark',
  colors: {
    background: '#F2F2EF',
    surface: '#FFFFFF',
    surfaceAlt: '#E4E4DF',
    text: '#101010',
    muted: '#7C7C74',
    border: '#D2D2CC',
    accent: '#2F4B41',
    accentSoft: '#E9EDEA',
    danger: '#9B2C24',
    success: '#35594A',
    onImage: '#FFFFFF',
    onImageMuted: 'rgba(255,255,255,0.78)',
    scrim: 'rgba(16,16,16,0.32)',
    overlay: 'rgba(16,16,16,0.48)',
  },
  spacing: { xs: 4, sm: 8, md: 14, lg: 22, xl: 36 },
  radius: { sm: 0, md: 2, lg: 2, pill: 0 },
  fonts: { display: undefined, body: sansBody },
  type: {
    display: { fontSize: 21, fontWeight: '500', letterSpacing: 1.6 },
    title: { fontSize: 16, fontWeight: '600', letterSpacing: 0.6 },
    section: { fontSize: 13, fontWeight: '600', letterSpacing: 1.4, textTransform: 'uppercase' },
    body: { fontFamily: sansBody, fontSize: 12.5, lineHeight: 21 },
    caption: { fontSize: 10, lineHeight: 16, letterSpacing: 0.4 },
    label: { fontSize: 9, fontWeight: '500', letterSpacing: 1.6 },
  },
  card: {
    layout: 'stacked',
    radius: 2,
    borderWidth: 1,
    borderColor: '#D2D2CC',
    inset: 0,
    imageRadius: 0,
    metaBackground: '#FFFFFF',
  },
  button: {
    background: '#101010',
    color: '#FFFFFF',
    radius: 2,
    borderWidth: 0,
    borderColor: 'transparent',
    letterSpacing: 1.2,
    minHeight: 50,
  },
  chip: {
    background: '#FFFFFF',
    color: '#7C7C74',
    borderColor: '#D2D2CC',
    radius: 0,
    activeBackground: '#101010',
    activeColor: '#FFFFFF',
    activeBorderColor: '#101010',
  },
  nav: {
    background: '#F2F2EF',
    borderColor: '#D2D2CC',
    borderWidth: 1,
    height: 64,
    active: '#101010',
    inactive: '#98988F',
    labelSize: 9,
    floating: false,
    fabBackground: '#101010',
    fabColor: '#FFFFFF',
    fabRadius: 0,
    fabBorderWidth: 0,
    fabBorderColor: 'transparent',
    fabSize: 44,
  },
};

export const afterhours: Theme = {
  id: 'afterhours',
  name: '夜场黑金',
  en: 'After Hours',
  tagline: '近黑、香槟金、慢镜',
  swatch: ['#0B0B0D', '#C6B08A', '#EDE8E0'],
  statusBar: 'light',
  colors: {
    background: '#0B0B0D',
    surface: '#16161A',
    surfaceAlt: '#1F1F24',
    text: '#EDE8E0',
    muted: '#8C8578',
    border: 'rgba(237,232,224,0.14)',
    accent: '#C6B08A',
    accentSoft: 'rgba(198,176,138,0.14)',
    danger: '#D07A70',
    success: '#8FB49B',
    onImage: '#F5EFE4',
    onImageMuted: 'rgba(227,213,188,0.72)',
    scrim: 'rgba(5,5,6,0.62)',
    overlay: 'rgba(5,5,6,0.66)',
  },
  spacing: { xs: 6, sm: 12, md: 20, lg: 28, xl: 44 },
  radius: { sm: 4, md: 10, lg: 16, pill: 999 },
  fonts: { display: serifDisplay, body: sansBody },
  type: {
    display: { fontFamily: serifDisplay, fontSize: 24, fontWeight: '400', letterSpacing: 1.2 },
    title: { fontFamily: serifDisplay, fontSize: 19, fontWeight: '400', letterSpacing: 0.6 },
    section: { fontSize: 15, fontWeight: '500', letterSpacing: 0.4, color: '#EDE8E0' },
    body: { fontFamily: sansBody, fontSize: 13, lineHeight: 22 },
    caption: { fontSize: 10, lineHeight: 17, letterSpacing: 0.8 },
    label: { fontSize: 9, fontWeight: '500', letterSpacing: 1.8 },
  },
  card: {
    layout: 'overlay',
    radius: 16,
    borderWidth: 1,
    borderColor: 'rgba(198,176,138,0.28)',
    inset: 0,
    imageRadius: 15,
    metaBackground: '#16161A',
    shadow: { shadowColor: '#000000', shadowOpacity: 0.6, shadowRadius: 30, shadowOffset: { width: 0, height: 22 }, elevation: 14 },
  },
  button: {
    background: '#E3D5BC',
    color: '#141210',
    radius: 999,
    borderWidth: 0,
    borderColor: 'transparent',
    letterSpacing: 1,
    minHeight: 52,
  },
  chip: {
    background: 'transparent',
    color: '#B9AD98',
    borderColor: 'rgba(198,176,138,0.28)',
    radius: 999,
    activeBackground: '#C6B08A',
    activeColor: '#141210',
    activeBorderColor: '#C6B08A',
  },
  nav: {
    background: 'rgba(22,22,26,0.96)',
    borderColor: 'rgba(198,176,138,0.22)',
    borderWidth: 1,
    height: 64,
    active: '#E3D5BC',
    inactive: '#8C8578',
    labelSize: 10,
    floating: true,
    fabBackground: '#E3D5BC',
    fabColor: '#141210',
    fabRadius: 23,
    fabBorderWidth: 0,
    fabBorderColor: 'transparent',
    fabSize: 46,
  },
};

export const song: Theme = {
  id: 'song',
  name: '宋式留白',
  en: 'Song · Negative Space',
  tagline: '宣纸、宋体、朱砂',
  swatch: ['#F6F2E9', '#A63A2E', '#1C1B18'],
  statusBar: 'dark',
  colors: {
    background: '#F6F2E9',
    surface: '#FDFBF6',
    surfaceAlt: '#E7E0D2',
    text: '#1C1B18',
    muted: '#8A8377',
    border: 'rgba(28,27,24,0.14)',
    accent: '#A63A2E',
    accentSoft: '#F3E4E0',
    danger: '#A63A2E',
    success: '#4C5F51',
    onImage: '#F6F2E9',
    onImageMuted: 'rgba(246,242,233,0.82)',
    scrim: 'rgba(28,27,24,0.22)',
    overlay: 'rgba(28,27,24,0.24)',
  },
  spacing: { xs: 8, sm: 16, md: 28, lg: 44, xl: 64 },
  radius: { sm: 2, md: 6, lg: 14, pill: 999 },
  fonts: { display: songSerif, body: sansBody },
  type: {
    display: { fontFamily: songSerif, fontSize: 22, fontWeight: '400', letterSpacing: 4 },
    title: { fontFamily: songSerif, fontSize: 17, fontWeight: '400', letterSpacing: 2 },
    section: { fontFamily: songSerif, fontSize: 15, fontWeight: '400', letterSpacing: 1.4, color: '#1C1B18' },
    body: { fontFamily: sansBody, fontSize: 13, lineHeight: 24, letterSpacing: 0.3 },
    caption: { fontSize: 11, lineHeight: 20, letterSpacing: 0.2 },
    label: { fontFamily: songSerif, fontSize: 9, letterSpacing: 3 },
  },
  card: {
    layout: 'overlay',
    radius: 2,
    borderWidth: 1,
    borderColor: 'rgba(28,27,24,0.12)',
    inset: 10,
    imageRadius: 1,
    metaBackground: '#FDFBF6',
  },
  button: {
    background: 'transparent',
    color: '#1C1B18',
    radius: 2,
    borderWidth: 1,
    borderColor: 'rgba(28,27,24,0.45)',
    letterSpacing: 4,
    minHeight: 52,
  },
  chip: {
    background: 'transparent',
    color: '#6E685C',
    borderColor: 'rgba(28,27,24,0.18)',
    radius: 0,
    activeBackground: '#1C1B18',
    activeColor: '#F6F2E9',
    activeBorderColor: '#1C1B18',
  },
  nav: {
    background: '#F6F2E9',
    borderColor: 'rgba(28,27,24,0.12)',
    borderWidth: 1,
    height: 68,
    active: '#A63A2E',
    inactive: '#8A8377',
    labelSize: 10,
    floating: false,
    fabBackground: '#A63A2E',
    fabColor: '#F6F2E9',
    fabRadius: 23,
    fabBorderWidth: 0,
    fabBorderColor: 'transparent',
    fabSize: 44,
  },
};

export const THEMES: Record<ThemeId, Theme> = { runway, atelier, concrete, afterhours, song };
export const THEME_LIST: Theme[] = [runway, atelier, concrete, afterhours, song];
export const DEFAULT_THEME_ID: ThemeId = 'runway';

export function isThemeId(value: unknown): value is ThemeId {
  return value === 'runway' || value === 'atelier' || value === 'concrete' || value === 'afterhours' || value === 'song';
}
