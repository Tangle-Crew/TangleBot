-- Small pieces of bot state that used to live only in data/*.json files (leaderboard message IDs,
-- the honeypot's test mode, and so on), so a lost data volume doesn't lose them. The key is the
-- file name; the value is the file's JSON.
create table bot_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
