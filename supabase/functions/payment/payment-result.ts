// 线上 Supabase 函数编辑器不支持 `../_shared/` 相对引用，payment-result.ts 被内联在
// payment 函数目录中。仓库保持与线上一致的组织方式：payment/index.ts 只从
// `./payment-result.ts` 导入；不要再改回 `_shared/`，否则线上与仓库会再次分叉。
// 修改本文件后需执行 `supabase functions deploy payment` 同步线上。

// mark_order_paid 的返回契约（008_fix_mark_order_paid.sql 起）：
//   成功：{"status":"paid"|"already_paid"|"duplicate", ...}
//   拒绝：{"status":"rejected","code":"ORDER_EXPIRED"|"AMOUNT_MISMATCH"|"PLAN_MISMATCH"|"ORDER_STATE_INVALID"|"ORDER_NOT_FOUND"}
// 拒绝是 HTTP 200 + 业务状态，不再靠抛异常表达，调用方必须自己判断 status。

export type MarkPaidResult = {
  status?: string;
  code?: string;
  order_no?: string;
};

export type MarkPaidOutcome =
  | { kind: "success" }
  | { kind: "rejected"; status: number; code: string; message: string }
  | { kind: "error"; status: number; code: string; message: string };

// 每个拒绝码对应独立 HTTP 状态与用户可读文案，避免全部折叠成同一个错误
const REJECTED_RESPONSES: Record<string, { status: number; message: string }> = {
  ORDER_NOT_FOUND: { status: 404, message: "订单不存在，请重新下单" },
  ORDER_EXPIRED: { status: 410, message: "订单已过期，请重新下单" },
  AMOUNT_MISMATCH: { status: 422, message: "订单金额校验失败，已停止支付" },
  PLAN_MISMATCH: { status: 400, message: "订单套餐校验失败，已停止支付" },
  ORDER_STATE_INVALID: { status: 409, message: "订单状态已变化，请刷新后重试" },
};

const SUCCESS_STATUSES = new Set(["paid", "already_paid", "duplicate"]);

export function classifyMarkPaidResult(
  data: MarkPaidResult | null,
  error: { message?: string } | null,
): MarkPaidOutcome {
  if (error) {
    const detail = (error.message || "").split("\n")[0].trim();
    return {
      kind: "error",
      status: 500,
      code: "CALLBACK_FAILED",
      message: `回调处理失败: ${detail || "数据库错误"}`,
    };
  }

  const status = String(data?.status ?? "");
  if (status === "rejected") {
    const code = String(data?.code ?? "");
    const mapped = REJECTED_RESPONSES[code];
    if (mapped) return { kind: "rejected", code, ...mapped };
    return {
      kind: "rejected",
      status: 400,
      code: code || "CALLBACK_REJECTED",
      message: `回调被拒绝: ${code || "(未知原因)"}`,
    };
  }

  if (SUCCESS_STATUSES.has(status)) return { kind: "success" };

  return {
    kind: "error",
    status: 502,
    code: "CALLBACK_RESULT_UNKNOWN",
    message: `支付回调返回了未知状态: ${status || "(空)"}`,
  };
}
