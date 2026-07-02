create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  page_url text,
  user_email text,
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

create policy "insert feedback"
on public.feedback
for insert
to anon, authenticated
with check (true);
