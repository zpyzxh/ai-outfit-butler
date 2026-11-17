import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { StyleSheet, View, useWindowDimensions, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/icons';
import { useTheme } from '@/theme';

type IconName = ComponentProps<typeof AppIcon>['name'];

// 选中态不再靠「实心图标」区分（单一线宽家族没有实心变体），
// 改成 1px 发丝圆环 + 主色：图标始终是同一个字形，只在「被圈起来」时变成当前页。
function tabIcon(glyph: IconName) {
  return ({
    color,
    focused,
  }: {
    color?: ColorValue | null;
    size: number;
    focused: boolean;
  }) => (
    <View style={[styles.slot, focused && { borderColor: color as string | undefined }]}>
      <AppIcon name={glyph} size={22} color={color as string | undefined} />
    </View>
  );
}

const SIDE_GUTTER = 14;

// 保留路由、只隐藏底栏按钮
const HIDDEN_TAB = {
  tabBarButton: () => null,
  tabBarItemStyle: { display: 'none' as const },
};

export default function TabsLayout() {
  const { theme } = useTheme();
  const { nav } = theme;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const floating = nav.floating;

  // 浮起胶囊的高度必须自己算宽度：Web 上 position:absolute + left/right 会与
  // tabBar 自带的 width:100% 冲突，导致第 5 个 tab 被挤出屏幕（真机也可能溢出）。
  const barWidth = Math.max(240, width - SIDE_GUTTER * 2);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: nav.active,
        tabBarInactiveTintColor: nav.inactive,
        tabBarStyle: floating
          ? {
              position: 'absolute',
              left: SIDE_GUTTER,
              width: barWidth,
              bottom: Math.max(insets.bottom, 10),
              height: nav.height + 10,
              borderRadius: 22,
              borderWidth: nav.borderWidth,
              borderTopWidth: nav.borderWidth,
              borderColor: nav.borderColor,
              backgroundColor: nav.background,
              paddingTop: 8,
              paddingBottom: 8,
              elevation: 14,
              shadowColor: '#000000',
              shadowOpacity: 0.45,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 14 },
            }
          : {
              backgroundColor: nav.background,
              borderTopColor: nav.borderColor,
              borderTopWidth: nav.borderWidth,
              height: nav.height,
              paddingTop: 6,
              paddingBottom: 8,
            },
        tabBarLabelStyle: { fontSize: nav.labelSize, letterSpacing: 0.4 },
        tabBarItemStyle: { paddingVertical: 0 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: '首页', tabBarIcon: tabIcon('home') }} />
      <Tabs.Screen name="outfits" options={{ title: '搭配', tabBarIcon: tabIcon('stylist') }} />
      <Tabs.Screen
        name="create"
        options={{
          title: '发布',
          tabBarIcon: () => (
            <View
              style={{
                width: nav.fabSize,
                height: nav.fabSize,
                marginTop: -(nav.fabSize / 2 + 4),
                borderRadius: nav.fabRadius,
                backgroundColor: nav.fabBackground,
                borderWidth: nav.fabBorderWidth,
                borderColor: nav.fabBorderColor,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <AppIcon name="create" size={26} color={nav.fabColor} />
            </View>
          ),
          tabBarLabelStyle: { fontSize: nav.labelSize - 1, marginTop: -1 },
        }}
      />
      <Tabs.Screen name="tryon" options={{ title: '试衣', tabBarIcon: tabIcon('tryon') }} />
      <Tabs.Screen name="profile" options={{ title: '我的', tabBarIcon: tabIcon('profile') }} />
      {/* 对话与套餐不进底栏：对话由「搭配」页入口进入，套餐由「我的」页入口进入。
          这里不能用 href: null —— 它会把路由从 linking 表里摘掉，router.push('/chat')
          与直接打开 URL 都会静默回落到首页。改用「隐藏按钮但保留路由」。 */}
      <Tabs.Screen name="chat" options={HIDDEN_TAB} />
      <Tabs.Screen name="plans" options={HIDDEN_TAB} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  slot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
