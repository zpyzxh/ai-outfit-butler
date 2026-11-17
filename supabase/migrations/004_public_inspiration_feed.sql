-- Public inspiration feed. Uploaders get an anonymous Auth session so they can
-- delete only their own posts without entering account credentials.

create table if not exists public.inspiration_posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  caption text not null default '',
  media_type text not null check (media_type in ('image', 'video')),
  media_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_inspiration_posts_created_at
  on public.inspiration_posts(created_at desc);

alter table public.inspiration_posts enable row level security;
grant select on public.inspiration_posts to anon, authenticated;
grant insert, delete on public.inspiration_posts to authenticated;

drop policy if exists "public read inspiration posts" on public.inspiration_posts;
create policy "public read inspiration posts" on public.inspiration_posts
  for select to anon, authenticated using (true);

drop policy if exists "users publish own inspiration posts" on public.inspiration_posts;
create policy "users publish own inspiration posts" on public.inspiration_posts
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists "users delete own inspiration posts" on public.inspiration_posts;
create policy "users delete own inspiration posts" on public.inspiration_posts
  for delete to authenticated using (owner_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'inspiration-posts', 'inspiration-posts', true, 52428800,
  array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public read inspiration media" on storage.objects;
create policy "public read inspiration media" on storage.objects
  for select to anon, authenticated using (bucket_id = 'inspiration-posts');

drop policy if exists "users upload own inspiration media" on storage.objects;
create policy "users upload own inspiration media" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'inspiration-posts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users delete own inspiration media" on storage.objects;
create policy "users delete own inspiration media" on storage.objects
  for delete to authenticated using (
    bucket_id = 'inspiration-posts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
