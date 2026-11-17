import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  GENDER_OPTIONS,
  OCCASION_OPTIONS,
  VIBE_OPTIONS,
  type StyleProfile,
} from '@/lib/styleProfile';
import { useTheme, type Theme } from '@/theme';

/**
 * 风格档案编辑面板（底部抽屉）。
 * 「搭配」页和「我的」页共用同一个组件，避免两处维护两份表单。
 */
export function StyleProfileSheet({
  visible,
  initial,
  onClose,
  onSave,
}: {
  visible: boolean;
  initial: StyleProfile;
  onClose: () => void;
  onSave: (profile: StyleProfile) => void;
}) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [draft, setDraft] = useState<StyleProfile>(initial);

  // 每次打开都用最新的档案初始化草稿，避免上次未保存的选择残留
  const [lastVisible, setLastVisible] = useState(visible);
  if (visible !== lastVisible) {
    setLastVisible(visible);
    if (visible) setDraft(initial);
  }

  const toggleIn = (list: string[], value: string, max: number) => {
    if (list.includes(value)) return list.filter((item) => item !== value);
    if (list.length >= max) return [...list.slice(1), value];
    return [...list, value];
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.dismiss} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
            <Text style={styles.eyebrow}>STYLE PROFILE</Text>
            <Text style={styles.title}>你的风格</Text>
            <Text style={styles.note}>只存在本机，用来给推荐加权，不上传服务器。</Text>

            <Text style={styles.fieldLabel}>我常穿</Text>
            <View style={styles.chipRow}>
              {GENDER_OPTIONS.map((option) => {
                const active = draft.gender === option;
                return (
                  <Pressable
                    key={option}
                    onPress={() => setDraft({ ...draft, gender: option })}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {option === '不限' ? '不限性别' : `女装/男装 · ${option}`}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.fieldLabel}>气质关键词（最多 3 个）</Text>
            <View style={styles.chipRow}>
              {VIBE_OPTIONS.map((option) => {
                const active = draft.vibes.includes(option);
                return (
                  <Pressable
                    key={option}
                    onPress={() => setDraft({ ...draft, vibes: toggleIn(draft.vibes, option, 3) })}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.fieldLabel}>常出现的场合</Text>
            <View style={styles.chipRow}>
              {OCCASION_OPTIONS.map((option) => {
                const active = draft.occasions.includes(option);
                return (
                  <Pressable
                    key={option}
                    onPress={() => setDraft({ ...draft, occasions: toggleIn(draft.occasions, option, 3) })}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable style={styles.save} onPress={() => onSave(draft)}>
              <Text style={styles.saveText}>保存并重新推荐</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button, nav } = theme;
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim },
    dismiss: { flex: 1 },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg + 8,
      borderTopRightRadius: radius.lg + 8,
      maxHeight: '82%',
      paddingBottom: nav.height + 16,
    },
    grabber: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginTop: 10,
    },
    content: { paddingHorizontal: spacing.md, paddingTop: spacing.md, gap: 10 },
    eyebrow: { ...type.label, color: colors.muted, letterSpacing: 1.6 },
    title: { ...type.display, fontSize: 24 },
    note: { ...type.caption, color: colors.muted },
    fieldLabel: { ...type.label, color: colors.muted, marginTop: 10, letterSpacing: 0.8 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { ...type.caption, color: colors.text },
    chipTextActive: { color: colors.onImage },
    save: {
      marginTop: spacing.md,
      minHeight: 50,
      borderRadius: button.radius,
      backgroundColor: button.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveText: { ...type.label, color: colors.onImage, fontSize: 12, letterSpacing: 1.2 },
  });
};
