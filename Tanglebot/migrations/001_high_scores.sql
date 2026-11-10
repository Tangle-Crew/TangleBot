create table members (
  discord_id   text primary key,
  display_name text not null,
  updated_at   timestamptz not null default now()
);
create table donations (
  discord_id text primary key references members(discord_id),
  total_gp   bigint not null default 0 check (total_gp >= 0)
);
create table donation_log (
  id            bigint generated always as identity primary key,
  discord_id    text not null references members(discord_id),
  change_gp     bigint not null,
  total_after   bigint not null check (total_after >= 0),
  by_discord_id text,
  source        text not null default 'command' check (source in ('command', 'import', 'manual')),
  created_at    timestamptz not null default now()
);
create index donation_log_member_idx on donation_log (discord_id, created_at);
create table pets (
  key      text primary key,
  name     text not null,
  emoji_id text
);
create table member_pets (
  discord_id text not null references members(discord_id),
  pet_key    text not null references pets(key),
  added_by   text,
  added_at   timestamptz not null default now(),
  primary key (discord_id, pet_key)
);
create table pet_log (
  id            bigint generated always as identity primary key,
  discord_id    text not null references members(discord_id),
  pet_key       text not null references pets(key),
  action        text not null check (action in ('add', 'remove')),
  by_discord_id text,
  created_at    timestamptz not null default now()
);
create index pet_log_member_idx on pet_log (discord_id, created_at);
