-- One row per OSRS account, filled from Wise Old Man (WOM). A person (members) can have several
-- accounts; member_id stays empty until an account is linked to a person.
create table accounts (
  id               bigint generated always as identity primary key,
  wom_player_id    integer not null unique,
  username         text not null,
  rsn              text not null,
  member_id        text references members(discord_id),
  is_main          boolean not null default false,
  wom_role         text,
  status           text not null default 'active' check (status in ('active', 'left')),
  wom_joined_at    timestamptz,
  client_joined_at timestamptz,
  first_joined_at  timestamptz,
  left_at          timestamptz,
  wom_data         jsonb,
  synced_at        timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create index accounts_member_idx on accounts (member_id);
create index accounts_status_idx on accounts (status);
create index accounts_username_idx on accounts (username);

-- Append-only history. An event belongs to a person (member_id) or an account (account_id), never
-- both. kind is deliberately not constrained: a new kind of history is a new value.
create table member_events (
  id          bigint generated always as identity primary key,
  member_id   text references members(discord_id),
  account_id  bigint references accounts(id),
  kind        text not null,
  old_value   text,
  new_value   text,
  data        jsonb,
  source      text not null check (source in ('wom', 'discord', 'import')),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check ((member_id is null) <> (account_id is null))
);
create index member_events_member_idx on member_events (member_id, occurred_at) where member_id is not null;
create index member_events_account_idx on member_events (account_id, occurred_at) where account_id is not null;
create index member_events_kind_idx on member_events (kind, occurred_at);
-- A re-sync must not add the same event twice.
create unique index member_events_account_unique
  on member_events (account_id, kind, occurred_at, coalesce(new_value, '')) where account_id is not null;
create unique index member_events_member_unique
  on member_events (member_id, kind, occurred_at, coalesce(new_value, '')) where member_id is not null;
