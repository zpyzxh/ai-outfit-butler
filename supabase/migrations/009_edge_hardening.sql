-- ============================================
-- 009_edge_hardening.sql
-- Edge Functions 安全收口（只新增，不改 001-008）：
-- 1) tryon_tasks.owner_user_id：记录任务归属（Supabase Auth uid），供 GET 校验调用者
-- 2) consume_entitlement / refund_entitlement：权益次数的原子扣减与回滚
--
-- 说明：owner_user_id 允许为空，用于兼容迁移前创建的历史任务（历史行无法反推归属）。
--       新任务由 tryon / video Edge Function 在调用者带有效 JWT 时写入。
-- ============================================

alter table public.tryon_tasks
  add column if not exists owner_user_id text;

create index if not exists idx_tryon_tasks_owner
  on public.tryon_tasks (owner_user_id, created_at desc);

-- 原子扣减一次权益：
--   优先扣「不限次数且临近到期」的权益，其次扣次数型里还有剩余的；
--   返回 consumed / no_entitlement / exhausted 三种状态。
--   未购买过任何套餐 -> no_entitlement（调用方按免费额度放行）
--   买过但全部耗尽或已过期 -> exhausted（调用方阻断）
create or replace function public.consume_entitlement(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ent public.entitlements;
  v_has_any boolean;
begin
  if p_user_id is null or p_user_id = '' then
    return jsonb_build_object('status', 'no_entitlement');
  end if;

  select * into v_ent
  from public.entitlements
  where user_id = p_user_id
    and status = 'active'
    and (valid_until is null or valid_until > now())
    and (quota_total is null or quota_used < quota_total)
  order by (quota_total is null) desc, valid_until asc nulls last, created_at asc
  limit 1
  for update;

  if found then
    update public.entitlements
       set quota_used = quota_used + 1
     where id = v_ent.id;

    return jsonb_build_object(
      'status', 'consumed',
      'entitlement_id', v_ent.id,
      'plan_id', v_ent.plan_id,
      'quota_total', v_ent.quota_total,
      'quota_used', v_ent.quota_used + 1,
      'remaining',
        case when v_ent.quota_total is null then null
             else v_ent.quota_total - v_ent.quota_used - 1 end
    );
  end if;

  select exists(
    select 1 from public.entitlements
    where user_id = p_user_id
      and status = 'active'
      and (valid_until is null or valid_until > now())
  ) into v_has_any;

  if v_has_any then
    return jsonb_build_object('status', 'exhausted');
  end if;

  return jsonb_build_object('status', 'no_entitlement');
end;
$$;

-- 供应商明确失败（未产生计费）时回滚一次扣减，不扣到负数
create or replace function public.refund_entitlement(p_entitlement_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.entitlements
     set quota_used = greatest(quota_used - 1, 0)
   where id = p_entitlement_id;
$$;

-- 只允许 service_role 调用：入参是任意 user_id，绝不能暴露给 anon / authenticated
revoke all on function public.consume_entitlement(text) from public, anon, authenticated;
revoke all on function public.refund_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.consume_entitlement(text) to service_role;
grant execute on function public.refund_entitlement(uuid) to service_role;
