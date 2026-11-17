-- Admin write access for garment management and single-user task cleanup.
-- Add the Supabase Auth user's app_metadata.role = 'admin' before using /admin.

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Starter poses make the video action usable immediately after applying this migration.
insert into public.poses (name, pose_desc, gender)
select seed.name, seed.pose_desc, 'unisex'
from (values
  ('自然展示', 'The model stands naturally and gently shifts weight to show the outfit clearly.'),
  ('侧身展示', 'The model slowly turns slightly to the side and back with a calm, natural movement.'),
  ('轻摆展示', 'The model makes a subtle graceful movement to show the garment fabric and silhouette.')
) as seed(name, pose_desc)
where not exists (
  select 1 from public.poses existing
  where existing.name = seed.name and existing.gender = 'unisex'
);

grant insert, update, delete on public.garments to authenticated;

drop policy if exists "admin insert garments" on public.garments;
create policy "admin insert garments" on public.garments
  for insert to authenticated with check (public.is_admin());

drop policy if exists "admin update garments" on public.garments;
create policy "admin update garments" on public.garments
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin delete garments" on public.garments;
create policy "admin delete garments" on public.garments
  for delete to authenticated using (public.is_admin());

drop policy if exists "admin upload garments" on storage.objects;
create policy "admin upload garments" on storage.objects
  for insert to authenticated with check (bucket_id = 'garments' and public.is_admin());

drop policy if exists "admin update garment images" on storage.objects;
create policy "admin update garment images" on storage.objects
  for update to authenticated using (bucket_id = 'garments' and public.is_admin())
  with check (bucket_id = 'garments' and public.is_admin());

drop policy if exists "admin delete garment images" on storage.objects;
create policy "admin delete garment images" on storage.objects
  for delete to authenticated using (bucket_id = 'garments' and public.is_admin());

-- This project is configured for one trusted, self-use installation without end-user accounts.
-- If it is shared with other users, replace these anon policies with per-user ownership before deployment.
drop policy if exists "public delete tryon_tasks" on public.tryon_tasks;
create policy "public delete tryon_tasks" on public.tryon_tasks
  for delete to anon using (true);

drop policy if exists "anon delete user-photos" on storage.objects;
create policy "anon delete user-photos" on storage.objects
  for delete to anon using (bucket_id = 'user-photos');

drop policy if exists "anon delete tryon-results" on storage.objects;
create policy "anon delete tryon-results" on storage.objects
  for delete to anon using (bucket_id = 'tryon-results');
