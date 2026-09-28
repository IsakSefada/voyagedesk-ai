-- VoyageDesk AI v0.3 — Supabase schema
-- Run this entire file once in Supabase Dashboard > SQL Editor.
-- It creates private per-agent tables protected by Row Level Security (RLS).

create extension if not exists pgcrypto;

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  language text,
  currency text,
  notes text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  title text,
  client_name text,
  destination text,
  travel_dates text,
  budget text,
  status text not null default 'Draft',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agency_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists trips_user_id_idx on public.trips(user_id);
create index if not exists trips_client_id_idx on public.trips(client_id);
create index if not exists clients_user_id_idx on public.clients(user_id);

alter table public.clients enable row level security;
alter table public.trips enable row level security;
alter table public.agency_profiles enable row level security;

grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.trips to authenticated;
grant select, insert, update, delete on public.agency_profiles to authenticated;

drop policy if exists "clients_select_own" on public.clients;
drop policy if exists "clients_insert_own" on public.clients;
drop policy if exists "clients_update_own" on public.clients;
drop policy if exists "clients_delete_own" on public.clients;
create policy "clients_select_own" on public.clients for select to authenticated using ((select auth.uid()) = user_id);
create policy "clients_insert_own" on public.clients for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "clients_update_own" on public.clients for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "clients_delete_own" on public.clients for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "trips_select_own" on public.trips;
drop policy if exists "trips_insert_own" on public.trips;
drop policy if exists "trips_update_own" on public.trips;
drop policy if exists "trips_delete_own" on public.trips;
create policy "trips_select_own" on public.trips for select to authenticated using ((select auth.uid()) = user_id);
create policy "trips_insert_own" on public.trips for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "trips_update_own" on public.trips for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "trips_delete_own" on public.trips for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "profiles_select_own" on public.agency_profiles;
drop policy if exists "profiles_insert_own" on public.agency_profiles;
drop policy if exists "profiles_update_own" on public.agency_profiles;
drop policy if exists "profiles_delete_own" on public.agency_profiles;
create policy "profiles_select_own" on public.agency_profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "profiles_insert_own" on public.agency_profiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "profiles_update_own" on public.agency_profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "profiles_delete_own" on public.agency_profiles for delete to authenticated using ((select auth.uid()) = user_id);
