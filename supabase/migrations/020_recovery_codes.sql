-- 020_recovery_codes.sql
--
-- 为什么要有恢复码：
--   我们的身份是「匿名登录」，会话只存在浏览器/设备的本地存储里。
--   用户清一次缓存、换个浏览器、重装 App，身份就变了 —— 历史记录全部变成孤儿，
--   而且没有任何找回手段。对真实用户这是不可接受的。
--
-- 做法（最小可用）：
--   每个身份生成一个 12 位恢复码（本地随机，服务端只存 SHA-256 哈希），
--   用户换设备时输入这串码，就把旧身份名下的数据搬到当前身份下。
--   不引入邮箱/短信，不依赖第三方，成本为零。
--
-- 隐私取舍：
--   恢复码是 60 bit 随机（32 字符集 × 12 位），暴力猜解不可行；
--   服务端拿不到明文，数据泄露也推不回去。代价是「码丢了就永久找不回」，
--   所以界面上要明确提示用户截图保存。

create extension if not exists pgcrypto with schema extensions;

begin;

create table if not exists public.recovery_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  last_redeemed_at timestamptz
);

comment on table public.recovery_codes is '匿名身份的恢复码哈希；只存 sha256，明文只存在用户设备上';

alter table public.recovery_codes enable row level security;
-- 不给任何角色建策略：客户端连 select 都做不到，只能通过下面两个 definer 函数
revoke all on public.recovery_codes from anon, authenticated;

-- 归一化：去掉分隔符、转大写；改这里要同步改客户端 normalizeRecoveryCode
create or replace function public.normalize_recovery_code(p_code text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- 登记 / 覆盖当前身份的恢复码
create or replace function public.register_recovery_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  normalized text := public.normalize_recovery_code(p_code);
begin
  if me is null then
    raise exception '未登录';
  end if;
  if length(normalized) < 10 then
    raise exception '恢复码长度不足';
  end if;

  insert into public.recovery_codes (user_id, code_hash)
  values (me, encode(digest(normalized, 'sha256'), 'hex'))
  on conflict (user_id) do update
    set code_hash = excluded.code_hash,
        created_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- 用恢复码接回旧身份的数据
create or replace function public.redeem_recovery_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  target uuid;
  moved_tasks int := 0;
  moved_posts int := 0;
  moved_entitlements int := 0;
begin
  if me is null then
    raise exception '未登录';
  end if;

  select rc.user_id into target
    from public.recovery_codes rc
   where rc.code_hash = encode(digest(public.normalize_recovery_code(p_code), 'sha256'), 'hex')
   limit 1;

  if target is null then
    return jsonb_build_object('ok', false, 'error', '恢复码无效，请检查后重试');
  end if;
  if target = me then
    return jsonb_build_object('ok', true, 'already_current', true, 'moved_tasks', 0, 'moved_posts', 0, 'moved_entitlements', 0);
  end if;

  update public.tryon_tasks set owner_user_id = me::text where owner_user_id = target::text;
  get diagnostics moved_tasks = row_count;

  update public.inspiration_posts set owner_id = me where owner_id = target;
  get diagnostics moved_posts = row_count;

  update public.entitlements set user_id = me where user_id = target;
  get diagnostics moved_entitlements = row_count;

  -- 码本身也移到当前身份：用户换设备后不必再记新码
  delete from public.recovery_codes where user_id = me;
  update public.recovery_codes
     set user_id = me, last_redeemed_at = now()
   where user_id = target;

  return jsonb_build_object(
    'ok', true,
    'already_current', false,
    'moved_tasks', moved_tasks,
    'moved_posts', moved_posts,
    'moved_entitlements', moved_entitlements
  );
end;
$$;

revoke all on function public.normalize_recovery_code(text) from public, anon;
revoke all on function public.register_recovery_code(text) from public, anon;
revoke all on function public.redeem_recovery_code(text) from public, anon;
grant execute on function public.register_recovery_code(text) to authenticated;
grant execute on function public.redeem_recovery_code(text) to authenticated;

commit;

-- 验证：
--   select count(*) from public.recovery_codes;                       -- 应该是 0（还没绑定）
--   select proname, proacl from pg_proc where proname like '%recovery_code%';
