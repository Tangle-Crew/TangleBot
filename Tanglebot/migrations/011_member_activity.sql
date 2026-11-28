-- When each person was first and last seen doing each kind of thing. Times only, no content.
-- No foreign key to members, so anyone's activity is saved, stored as a member or not.
create table member_activity (
  discord_id text not null,
  kind       text not null check (kind in ('message', 'voice', 'command')),
  first_at   timestamptz not null,
  last_at    timestamptz not null,
  primary key (discord_id, kind)
);
