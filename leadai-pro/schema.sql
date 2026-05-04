-- ============================================================
--  LeadAI Pro — Schema Supabase (com Asaas billing)
--  Execute no SQL Editor do Supabase
-- ============================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";

-- ─── TABELA: profiles ────────────────────────────────────────
create table if not exists public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text,
  name                  text,

  -- Plano
  plan                  text default 'free' check (plan in ('free','starter','pro')),
  subscription_status   text default 'active' check (subscription_status in ('active','overdue','cancelled','pending')),
  plan_expires_at       timestamptz,
  pending_plan          text,

  -- Limites do plano (replicados para consulta rápida)
  credits               int  default 10,   -- leads restantes no mês
  disparos_limit        int  default 3,    -- disparos permitidos no plano
  disparos_used         int  default 0,    -- disparos usados no mês
  credits_reset_at      timestamptz default now(),

  -- Asaas
  asaas_customer_id     text unique,
  asaas_subscription_id text unique,

  -- Config IA
  gemini_key            text,
  serp_key              text,
  waha_url              text,
  waha_token            text,
  produto               text,
  nicho                 text,
  followup_days         int default 2,

  created_at            timestamptz default now()
);

-- Trigger: cria profile no signup com plano Free
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, name, plan, credits, disparos_limit, disparos_used)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    'free',   -- começa sempre no Free
    10,       -- 10 leads no plano Free
    3,        -- 3 disparos no plano Free
    0
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─── TABELA: billing_events ──────────────────────────────────
create table if not exists public.billing_events (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references public.profiles(id) on delete cascade,
  event      text not null,
  plan       text,
  amount     numeric,
  asaas_id   text,
  created_at timestamptz default now()
);

-- ─── TABELA: searches ────────────────────────────────────────
create table if not exists public.searches (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.profiles(id) on delete cascade,
  niche       text not null,
  city        text not null,
  radius_km   int  default 10,
  min_rating  numeric default 3.5,
  min_reviews int  default 20,
  has_website text default 'any',
  total_found int  default 0,
  status      text default 'pending' check (status in ('pending','running','done','error')),
  error_msg   text,
  created_at  timestamptz default now()
);

-- ─── TABELA: leads ───────────────────────────────────────────
create table if not exists public.leads (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references public.profiles(id) on delete cascade,
  search_id       uuid references public.searches(id) on delete set null,
  name            text not null,
  segment         text,
  city            text,
  address         text,
  phone           text,
  website         text,
  google_maps_id  text,
  place_url       text,
  rating          numeric,
  review_count    int,
  reviews_text    jsonb default '[]',
  has_whatsapp    boolean,
  whatsapp_validated_at timestamptz,
  ai_score        int check (ai_score between 0 and 100),
  pain_points     jsonb default '[]',
  ai_message      text,
  score_label     text,
  ai_analyzed_at  timestamptz,
  status          text default 'new' check (status in ('new','sent','replied','closed','lost')),
  notes           text,
  followup_at     timestamptz,
  last_contact    timestamptz,
  history         jsonb default '[]',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists leads_user_id_idx  on public.leads(user_id);
create index if not exists leads_status_idx   on public.leads(status);
create index if not exists leads_score_idx    on public.leads(ai_score desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

create trigger leads_updated_at
  before update on public.leads
  for each row execute procedure public.set_updated_at();

-- ─── TABELA: messages ────────────────────────────────────────
create table if not exists public.messages (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references public.profiles(id) on delete cascade,
  lead_id    uuid references public.leads(id) on delete cascade,
  content    text not null,
  channel    text default 'whatsapp',
  status     text default 'draft' check (status in ('draft','sent','delivered','read','failed')),
  sent_at    timestamptz,
  created_at timestamptz default now()
);

-- ─── RLS ────────────────────────────────────────────────────
alter table public.profiles        enable row level security;
alter table public.searches        enable row level security;
alter table public.leads           enable row level security;
alter table public.messages        enable row level security;
alter table public.billing_events  enable row level security;

create policy "profiles_own"       on public.profiles        for all using (auth.uid() = id);
create policy "searches_own"       on public.searches        for all using (auth.uid() = user_id);
create policy "leads_own"          on public.leads           for all using (auth.uid() = user_id);
create policy "messages_own"       on public.messages        for all using (auth.uid() = user_id);
create policy "billing_events_own" on public.billing_events  for select using (auth.uid() = user_id);

-- ─── FUNÇÃO: reset mensal automático ─────────────────────────
-- Rode via Supabase cron (pg_cron) ou Supabase Edge Function agendada
create or replace function public.reset_monthly_credits()
returns void language plpgsql as $$
begin
  update public.profiles
  set
    credits          = case plan when 'pro' then 500 when 'starter' then 100 else 10 end,
    disparos_used    = 0,
    credits_reset_at = now()
  where credits_reset_at < now() - interval '30 days';
end;
$$;

-- ─── VIEWS ÚTEIS ────────────────────────────────────────────
create or replace view public.leads_hot as
  select * from public.leads where status='new' and ai_score >= 80 order by ai_score desc;

create or replace view public.followups_due as
  select l.*, p.email as user_email
  from public.leads l join public.profiles p on p.id = l.user_id
  where l.followup_at <= now() + interval '1 hour' and l.status not in ('closed','lost');
