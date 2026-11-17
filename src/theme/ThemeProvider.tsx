import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, Platform, View } from 'react-native';

import { DEFAULT_THEME_ID, THEMES, isThemeId, type Theme, type ThemeId } from './themes';

const STORAGE_KEY = 'style.theme.v1';

type ThemeContextValue = {
  theme: Theme;
  themeId: ThemeId;
  setTheme: (id: ThemeId) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<ThemeId | null>(null);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (alive) setThemeId(isThemeId(value) ? value : DEFAULT_THEME_ID);
      })
      .catch(() => {
        if (alive) setThemeId(DEFAULT_THEME_ID);
      });
    return () => {
      alive = false;
    };
  }, []);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeId(id);
    AsyncStorage.setItem(STORAGE_KEY, id).catch(() => {});
  }, []);

  // 让原生层（系统弹窗、键盘、日期选择器）跟随应用主题：
  // statusBar 为 light 表示深色底，对应原生 dark 模式。
  useEffect(() => {
    if (!themeId || Platform.OS === 'web') return;
    Appearance.setColorScheme(THEMES[themeId].statusBar === 'light' ? 'dark' : 'light');
  }, [themeId]);

  const value = useMemo(
    () => (themeId ? { theme: THEMES[themeId], themeId, setTheme } : null),
    [themeId, setTheme],
  );

  if (!value) {
    return <View style={{ flex: 1, backgroundColor: THEMES[DEFAULT_THEME_ID].colors.background }} />;
  }

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return context;
}

/** 把 StyleSheet 工厂按当前主题缓存：factory 请定义在模块顶层，保持引用稳定 */
export function useThemedStyles<T>(factory: (theme: Theme) => T): T {
  const { theme } = useTheme();
  return useMemo(() => factory(theme), [factory, theme]);
}
