-- Display order of the pet catalog (the Pets sheet tab's row order).
alter table pets add column sort_order integer not null default 0;

-- Every display name a member has had, oldest first. A row is added when the name changes.
create table member_names (
  id           bigint generated always as identity primary key,
  discord_id   text not null references members(discord_id),
  display_name text not null,
  changed_at   timestamptz not null default now()
);
create index member_names_member_idx on member_names (discord_id, changed_at);

-- One row per time a member was in the server. The earliest joined_at is their first join, a
-- later row is a rejoin, and left_at is null while they are still in the server.
create table member_stays (
  id         bigint generated always as identity primary key,
  discord_id text not null references members(discord_id),
  joined_at  timestamptz not null,
  left_at    timestamptz,
  check (left_at is null or left_at >= joined_at)
);
create index member_stays_member_idx on member_stays (discord_id, joined_at);
create unique index member_stays_one_open_idx on member_stays (discord_id) where left_at is null;
