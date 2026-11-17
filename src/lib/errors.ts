/**
 * 把底层错误翻译成用户能看懂的文案。
 * 直接展示 `TypeError: Failed to fetch` 这类信息既吓人也不可行动。
 */
export function toUserMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message) return fallback;

  if (/Failed to fetch|Network request failed|network ?error|ECONNRESET|ETIMEDOUT|Load failed|offline/i.test(message)) {
    return '网络不太稳，请检查网络后重试';
  }
  if (/aborted|timeout|超时/i.test(message)) {
    return '请求超时了，请重试';
  }
  if (/Invalid API key|JWT|Unauthorized|permission denied|row-level security/i.test(message)) {
    return '账号权限异常，请重新进入 App 后再试';
  }
  if (/duplicate key|23505/i.test(message)) {
    return '已经有一条相同的记录了';
  }
  // 中文业务文案直接透传；过长的英文堆栈一律折叠成兜底文案
  if (/[\u4e00-\u9fa5]/.test(message) && message.length <= 60) return message;
  return fallback;
}
