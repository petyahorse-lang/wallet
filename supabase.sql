-- Кошелёк BYN: одна таблица под все документы.
-- Выполнить один раз в Supabase: SQL Editor, New query, Run.

create table if not exists public.wallet_docs (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  path       text        not null,
  data       jsonb       not null,
  -- Версия растёт на единицу при каждой записи. Клиент пишет только при
  -- совпадении прочитанной версии, поэтому чужая запись, попавшая между
  -- нашим чтением и нашей записью, не может быть затёрта: обновление
  -- просто не найдёт строку, и клиент повторит слияние.
  version    bigint      not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

-- Право на таблицу для вошедшего пользователя. В новых проектах Supabase
-- ролям anon и authenticated по умолчанию достаются только REFERENCES,
-- TRIGGER и TRUNCATE, поэтому без этой строки приложение получает
-- permission denied for table wallet_docs ещё до всякой политики.
-- Роли anon права не даём намеренно: без входа приложение в базу не ходит.
grant select, insert, update, delete on table public.wallet_docs to authenticated;

-- Без этой строки чужие данные были бы доступны всем, у кого есть ключ anon.
alter table public.wallet_docs enable row level security;

-- Каждый видит и меняет только свои строки.
drop policy if exists wallet_docs_own on public.wallet_docs;
create policy wallet_docs_own on public.wallet_docs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
