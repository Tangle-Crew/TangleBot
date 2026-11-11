-- One row per slash command run, including ones that failed. No foreign key to members, so anyone
-- who runs a command is logged, member or not.
create table command_log (
  id          bigint generated always as identity primary key,
  discord_id  text not null,
  command     text not null,
  options     jsonb not null default '{}',
  status      text not null check (status in ('ok', 'error')),
  error       text,
  duration_ms integer,
  channel_id  text,
  created_at  timestamptz not null default now()
);
create index command_log_created_idx on command_log (created_at);
create index command_log_user_idx on command_log (discord_id, created_at);
create index command_log_command_idx on command_log (command, created_at);
