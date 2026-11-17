import { AppIcon } from '@/components/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchGarments, getDeviceId, getFunctionErrorMessage, supabase } from '@/lib/supabase';
import { loadStyleProfile, profileIsSet, profileSummary } from '@/lib/styleProfile';
import { fetchWeather } from '@/lib/weather';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string };
type ApiMessage = Pick<ChatMessage, 'role' | 'content'>;

const starters = ['今天上班怎么穿？', '白衬衫可以怎么搭？', '约会穿什么颜色好？'];
const welcome: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: '你好，我是你的穿搭顾问。告诉我今天的场合、天气或想穿的单品，我来帮你搭配。',
};

export default function ChatScreen() {
  const { theme } = useTheme();
  const { colors, button } = theme;
  const styles = useThemedStyles(makeStyles);
  const [messages, setMessages] = useState<ChatMessage[]>([welcome]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  // 同步锁：state 生效前的窗口内，连点发送/重试只放行一次
  const busyRef = useRef(false);
  // 个性化上下文：风格档案 + 今天天气 + 衣橱清单。
  // 三份数据都只读本地/公开接口，任何一项失败就少说一句，不影响对话本身。
  const contextRef = useRef<string>('');
  const [contextLabels, setContextLabels] = useState<string[]>([]);

  const scrollToEnd = () => requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [profile, weather, garments] = await Promise.all([
        loadStyleProfile().catch(() => null),
        fetchWeather().catch(() => null),
        fetchGarments().catch(() => []),
      ]);
      if (!alive) return;
      const parts: string[] = [];
      const labels: string[] = [];
      if (profile && profileIsSet(profile)) {
        parts.push(`我的风格偏好：${profileSummary(profile)}`);
        labels.push(profileSummary(profile));
      }
      if (weather) {
        parts.push(`今天的天气：${weather.tempC}°C，${weather.text}${weather.city ? `，城市${weather.city}` : ''}`);
        labels.push(`${weather.tempC}°C ${weather.text}`);
      }
      const wardrobe = garments.slice(0, 10);
      if (wardrobe.length > 0) {
        parts.push(`我衣橱里的单品：${wardrobe.map((item) => `${item.name}（${item.category}${item.color ? `/${item.color}` : ''}）`).join('、')}`);
        labels.push(`衣橱 ${garments.length} 件`);
      }
      contextRef.current = parts.length
        ? `【我的情况】${parts.join('；')}。请结合这些信息回答后面的问题，优先从我已有的单品里挑，并说明为什么适合我。`
        : '';
      setContextLabels(labels);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 用已有对话历史请求回复。重试时直接传当前 messages，避免把最后一条 user 消息再追加一遍。
  const requestReply = useCallback(async (history: ChatMessage[]) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setSending(true);
    setError(null);
    scrollToEnd();
    try {
      const apiMessages: ApiMessage[] = history
        .filter((message) => message.id !== 'welcome')
        .slice(-10)
        .map(({ role, content: text }) => ({ role, content: text }));
      if (apiMessages.length === 0) throw new Error('先输入一句想咨询的搭配问题');
      // 后端只接受 user/assistant 两种角色（system 由函数自己拼），所以把上下文
      // 伪装成一轮「我交代过情况 → 顾问表示记住了」的开场，让模型有据可依。
      if (contextRef.current) {
        apiMessages.unshift(
          { role: 'user', content: contextRef.current },
          { role: 'assistant', content: '好的，我记住了你的风格偏好、天气和衣橱，会只从你现有的单品里给建议。' },
        );
      }
      const { data, error: invokeError } = await supabase.functions.invoke<{ reply: string; error?: string }>('chat', {
        body: { messages: apiMessages },
        headers: { 'x-device-id': await getDeviceId() },
        // 不传 timeout 时 functions-js 完全不设超时，上游悬挂会把输入框永久锁死
        timeout: 30_000,
      });
      // 非 2xx 时 functions-js 返回 { data: null, error }，响应体只能从 error.context 里读
      if (invokeError) throw new Error(await getFunctionErrorMessage(invokeError));
      if (!data?.reply) throw new Error('没有收到回复，请稍后重试');
      setMessages((current) => [...current, { id: `${Date.now()}-assistant`, role: 'assistant', content: data.reply }]);
      scrollToEnd();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，请重试');
    } finally {
      busyRef.current = false;
      setSending(false);
    }
  }, []);

  const sendMessage = useCallback(async (value = input) => {
    const content = value.trim();
    if (!content || sending || busyRef.current) return;
    const userMessage: ChatMessage = { id: `${Date.now()}-user`, role: 'user', content };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    await requestReply(nextMessages);
  }, [input, messages, sending, requestReply]);

  const renderMessage = ({ item }: { item: ChatMessage }) => (
    <View style={[styles.messageRow, item.role === 'user' && styles.userRow]}>
      {item.role === 'assistant' ? <View style={styles.avatar}><AppIcon name="sparkles" size={14} color={colors.accent} /></View> : null}
      <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
        <Text style={[styles.messageText, item.role === 'user' && styles.userText]}>{item.content}</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <View style={styles.headerIcon}><AppIcon name="sparkles" size={18} color={colors.accent} /></View>
          <View style={styles.headerCopy}><Text style={styles.title}>穿搭问答</Text><Text style={styles.subtitle}>描述场合和偏好，获取搭配灵感</Text></View>
          <View style={styles.onlineDot} />
        </View>

        {contextLabels.length > 0 ? (
          <View style={styles.contextBar}>
            <AppIcon name="info" size={12} color={colors.muted} />
            <Text style={styles.contextText} numberOfLines={1}>已带上 {contextLabels.join(' · ')}</Text>
          </View>
        ) : null}

        <FlatList
          ref={listRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messageList}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListFooterComponent={sending ? <View style={styles.typing}><ActivityIndicator size="small" color={colors.accent} /><Text style={styles.typingText}>正在整理搭配建议…</Text></View> : undefined}
        />

        {messages.length === 1 ? (
          <View style={styles.starters}>
            {starters.map((starter) => <Pressable key={starter} onPress={() => void sendMessage(starter)} style={styles.starter}><Text style={styles.starterText}>{starter}</Text></Pressable>)}
          </View>
        ) : null}
        {error ? <View style={styles.errorRow}><Text style={styles.error}>{error}</Text><Pressable onPress={() => void requestReply(messages)}><Text style={styles.retry}>重试</Text></Pressable></View> : null}

        <View style={styles.composer}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="例如：周末出游，想穿得轻松一点…"
            placeholderTextColor={colors.muted}
            style={styles.input}
            multiline
            maxLength={2000}
            editable={!sending}
            onSubmitEditing={() => void sendMessage()}
            returnKeyType="send"
          />
          <Pressable accessibilityRole="button" accessibilityLabel="发送消息" disabled={!input.trim() || sending} onPress={() => void sendMessage()} style={[styles.sendButton, (!input.trim() || sending) && styles.disabled]}>
            {sending ? <ActivityIndicator color={button.color} size="small" /> : <AppIcon name="arrow-up" size={20} color={button.color} />}
          </Pressable>
        </View>
        <Text style={styles.disclaimer}>AI 建议仅供穿搭灵感参考 · 对话仅保存在当前页面</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, button, chip, type, nav } = theme;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
    headerIcon: { width: 38, height: 38, borderRadius: radius.pill, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
    headerCopy: { flex: 1, gap: 2 },
    title: { ...type.title, color: colors.text },
    subtitle: { ...type.caption, color: colors.muted },
    onlineDot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.success },
    contextBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: 8, backgroundColor: colors.accentSoft },
    contextText: { ...type.caption, color: colors.muted, flex: 1 },
    messageList: { flexGrow: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.md },
    messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs },
    userRow: { justifyContent: 'flex-end' },
    avatar: { width: 26, height: 26, borderRadius: radius.pill, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
    bubble: { maxWidth: '82%', borderRadius: radius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    assistantBubble: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 5 },
    userBubble: { backgroundColor: colors.accent, borderBottomRightRadius: 5 },
    messageText: { ...type.body, color: colors.text, fontSize: 14 },
    userText: { color: colors.surface },
    starters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
    starter: { borderWidth: 1, borderColor: chip.borderColor, borderRadius: chip.radius, backgroundColor: chip.background, paddingHorizontal: spacing.sm, paddingVertical: 7 },
    starterText: { ...type.caption, color: chip.color },
    typing: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingLeft: 34 },
    typingText: { ...type.caption, color: colors.muted },
    errorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingBottom: spacing.xs },
    error: { color: colors.danger, fontSize: 12 },
    retry: { color: colors.accent, fontSize: 12, fontWeight: '700' },
    composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginHorizontal: spacing.md, padding: spacing.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    input: { ...type.body, flex: 1, maxHeight: 120, minHeight: 42, paddingHorizontal: spacing.sm, paddingVertical: 10, color: colors.text },
    sendButton: { width: 38, height: 38, borderRadius: button.radius, backgroundColor: button.background, borderWidth: button.borderWidth, borderColor: button.borderColor, alignItems: 'center', justifyContent: 'center' },
    disabled: { opacity: 0.45 },
    disclaimer: { ...type.caption, color: colors.muted, textAlign: 'center', paddingTop: spacing.xs, paddingBottom: nav.floating ? nav.height + 22 : spacing.xs },
  });
};

