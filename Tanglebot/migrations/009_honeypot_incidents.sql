-- Honeypot activity: someone posted in a trap channel and was timed out, and what staff did next.
-- No foreign keys, like command_log: the people involved may be banned or gone. No message
-- content is stored, only what happened.
create table honeypot_incidents (
  id              bigint generated always as identity primary key,
  discord_id      text not null,
  discord_name    text,
  action          text not null check (action in ('timeout', 'ban', 'false_positive')),
  outcome         text not null check (outcome in ('done', 'failed', 'skipped', 'test')),
  test_mode       boolean not null default false,
  channel_id      text,
  by_discord_id   text,
  by_discord_name text,
  details         jsonb not null default '{}',
  created_at      timestamptz not null default now()
);
create index honeypot_incidents_user_idx on honeypot_incidents (discord_id, created_at);
create index honeypot_incidents_created_idx on honeypot_incidents (created_at);
