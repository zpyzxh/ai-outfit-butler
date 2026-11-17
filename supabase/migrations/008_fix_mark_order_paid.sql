-- 008_fix_mark_order_paid.sql
-- 修正：原实现里失败分支先 update 再 raise exception，整个事务回滚，
-- 导致“已过期订单置 closed”“回调失败记账”全部丢失。
-- 新实现不再 raise，改用返回值表达拒绝，保证失败分支的写入能真正提交。
-- 返回结构：
--   {"status":"paid","order_no":...,"entitlement_created":true}
--   {"status":"duplicate","order_no":...}
--   {"status":"already_paid","order_no":...}
--   {"status":"rejected","code":"ORDER_NOT_FOUND"|"AMOUNT_MISMATCH"|"PLAN_MISMATCH"|"ORDER_STATE_INVALID"|"ORDER_EXPIRED","order_no":...}

create or replace function public.mark_order_paid(
  p_order_no text,
  p_channel text,
  p_event_id text,
  p_external_txn_id text,
  p_amount_cents integer,
  p_plan_id text,
  p_quota_total integer,
  p_valid_days integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.payment_orders;
  v_inserted boolean;
begin
  insert into public.payment_callbacks (channel, event_id, order_no, result)
  values (p_channel, p_event_id, p_order_no, 'processing')
  on conflict (channel, event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if not v_inserted then
    return jsonb_build_object('status', 'duplicate', 'order_no', p_order_no);
  end if;

  select * into v_order from public.payment_orders where order_no = p_order_no for update;

  if not found then
    update public.payment_callbacks set result = 'order_not_found'
      where channel = p_channel and event_id = p_event_id;
    return jsonb_build_object('status', 'rejected', 'code', 'ORDER_NOT_FOUND', 'order_no', p_order_no);
  end if;

  if p_amount_cents is distinct from v_order.amount_cents then
    update public.payment_callbacks set result = 'amount_mismatch'
      where channel = p_channel and event_id = p_event_id;
    return jsonb_build_object('status', 'rejected', 'code', 'AMOUNT_MISMATCH', 'order_no', p_order_no);
  end if;

  if p_plan_id is distinct from v_order.plan_id then
    update public.payment_callbacks set result = 'plan_mismatch'
      where channel = p_channel and event_id = p_event_id;
    return jsonb_build_object('status', 'rejected', 'code', 'PLAN_MISMATCH', 'order_no', p_order_no);
  end if;

  if v_order.status = 'paid' then
    update public.payment_callbacks set result = 'already_paid'
      where channel = p_channel and event_id = p_event_id;
    return jsonb_build_object('status', 'already_paid', 'order_no', p_order_no);
  end if;

  if v_order.status <> 'pending' then
    update public.payment_callbacks set result = 'order_state_invalid'
      where channel = p_channel and event_id = p_event_id;
    return jsonb_build_object('status', 'rejected', 'code', 'ORDER_STATE_INVALID', 'order_no', p_order_no);
  end if;

  -- 过期：先把订单置 closed 并记账，再返回拒绝（不再 raise，写入可提交）
  if v_order.expires_at < now() then
    update public.payment_orders set status = 'closed' where id = v_order.id;
    update public.payment_callbacks set result = 'order_expired'
      where channel = p_channel and event_id = p_event_id;
    return jsonb_build_object('status', 'rejected', 'code', 'ORDER_EXPIRED', 'order_no', p_order_no);
  end if;

  update public.payment_orders
     set status = 'paid', paid_at = now(), external_txn_id = p_external_txn_id
   where id = v_order.id;

  insert into public.entitlements (user_id, plan_id, order_id, quota_total, valid_from, valid_until)
  values (
    v_order.user_id,
    v_order.plan_id,
    v_order.id,
    p_quota_total,
    now(),
    case when p_valid_days is null then null else now() + make_interval(days => p_valid_days) end
  )
  on conflict (order_id) do nothing;

  update public.payment_callbacks set result = 'paid'
    where channel = p_channel and event_id = p_event_id;

  return jsonb_build_object('status', 'paid', 'order_no', p_order_no, 'entitlement_created', true);
end;
$$;

revoke all on function public.mark_order_paid(text, text, text, text, integer, text, integer, integer) from anon, authenticated;
grant execute on function public.mark_order_paid(text, text, text, text, integer, text, integer, integer) to service_role;
