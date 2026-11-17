-- 007_payments.sql
-- 支付骨架：订单表 + 权益表 + 回调去重表 + 原子发放函数
-- 说明：金额一律用整数分（integer/cents），不使用浮点。

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,
  user_id text not null,                         -- 匿名设备标识 / 将来的 auth uid
  plan_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'CNY',
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'closed', 'refunded')),
  channel text not null,                         -- mock / wechat / alipay
  idempotency_key text not null,
  external_txn_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  expires_at timestamptz not null,
  unique (user_id, idempotency_key)
);

create index if not exists idx_payment_orders_user on public.payment_orders (user_id, created_at desc);
create index if not exists idx_payment_orders_status on public.payment_orders (status, expires_at);

create table if not exists public.payment_callbacks (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  event_id text not null,
  order_no text,
  result text not null,
  raw jsonb,
  received_at timestamptz not null default now(),
  unique (channel, event_id)                      -- 同一通道同一通知只处理一次
);

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  plan_id text not null,
  order_id uuid not null references public.payment_orders (id) on delete restrict,
  quota_total integer,                            -- 次数型套餐：总次数
  quota_used integer not null default 0,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,                        -- 有效期型套餐
  status text not null default 'active'
    check (status in ('active', 'expired', 'revoked')),
  created_at timestamptz not null default now(),
  unique (order_id)                               -- 一单一权益，天然幂等
);

create index if not exists idx_entitlements_user on public.entitlements (user_id, valid_until desc);

-- 只允许 service_role 读写；anon / authenticated 一律不可直接写
alter table public.payment_orders enable row level security;
alter table public.payment_callbacks enable row level security;
alter table public.entitlements enable row level security;

revoke all on public.payment_orders from anon, authenticated;
revoke all on public.payment_callbacks from anon, authenticated;
revoke all on public.entitlements from anon, authenticated;

grant all on public.payment_orders to service_role;
grant all on public.payment_callbacks to service_role;
grant all on public.entitlements to service_role;

-- 原子处理回调：去重 -> 校验 -> 置已支付 -> 发权益
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
  -- 1) 回调去重（同一 channel + event_id 只允许成功插入一次）
  insert into public.payment_callbacks (channel, event_id, order_no, result)
  values (p_channel, p_event_id, p_order_no, 'processing')
  on conflict (channel, event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if not v_inserted then
    return jsonb_build_object('status', 'duplicate', 'order_no', p_order_no);
  end if;

  -- 2) 锁单
  select * into v_order from public.payment_orders where order_no = p_order_no for update;
  if not found then
    update public.payment_callbacks set result = 'order_not_found'
      where channel = p_channel and event_id = p_event_id;
    raise exception 'ORDER_NOT_FOUND';
  end if;

  -- 3) 金额与套餐校验
  if p_amount_cents is distinct from v_order.amount_cents then
    update public.payment_callbacks set result = 'amount_mismatch'
      where channel = p_channel and event_id = p_event_id;
    raise exception 'AMOUNT_MISMATCH';
  end if;
  if p_plan_id is distinct from v_order.plan_id then
    update public.payment_callbacks set result = 'plan_mismatch'
      where channel = p_channel and event_id = p_event_id;
    raise exception 'PLAN_MISMATCH';
  end if;

  -- 4) 已支付：直接返回，不再发权益
  if v_order.status = 'paid' then
    update public.payment_callbacks set result = 'already_paid'
      where channel = p_channel and event_id = p_event_id;
    return jsonb_build_object('status', 'already_paid', 'order_no', p_order_no);
  end if;

  if v_order.status <> 'pending' then
    update public.payment_callbacks set result = 'order_state_invalid'
      where channel = p_channel and event_id = p_event_id;
    raise exception 'ORDER_STATE_INVALID';
  end if;

  -- 5) 已过期则关单
  if v_order.expires_at < now() then
    update public.payment_orders set status = 'closed' where id = v_order.id;
    update public.payment_callbacks set result = 'order_expired'
      where channel = p_channel and event_id = p_event_id;
    raise exception 'ORDER_EXPIRED';
  end if;

  -- 6) 置为已支付 + 发权益（同一事务）
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

  return jsonb_build_object(
    'status', 'paid',
    'order_no', p_order_no,
    'entitlement_created', true
  );
end;
$$;

revoke all on function public.mark_order_paid(text, text, text, text, integer, text, integer, integer) from anon, authenticated;
grant execute on function public.mark_order_paid(text, text, text, text, integer, text, integer, integer) to service_role;
