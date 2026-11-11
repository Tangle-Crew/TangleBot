-- Discord history as person events in member_events:
--   display_name_changed (old_value, new_value)   a display name change
--   server_joined / server_left                    being in the Discord server
-- A person is in the server when their latest server_joined/server_left event is server_joined.

-- Copy the history the bot recorded before this migration. Only a database that has the old
-- tables has anything to copy; a fresh install does not create them (see 002), so this skips.
do $$
begin
  if to_regclass('member_names') is not null then
    insert into member_events (member_id, kind, old_value, new_value, source, occurred_at)
    select n.discord_id, 'display_name_changed',
           lag(n.display_name) over (partition by n.discord_id order by n.changed_at, n.id),
           n.display_name, 'discord', n.changed_at
    from member_names n
    on conflict do nothing;
  end if;
  if to_regclass('member_stays') is not null then
    insert into member_events (member_id, kind, source, occurred_at)
    select s.discord_id, 'server_joined', 'discord', s.joined_at from member_stays s
    on conflict do nothing;
    insert into member_events (member_id, kind, source, occurred_at)
    select s.discord_id, 'server_left', 'discord', s.left_at from member_stays s where s.left_at is not null
    on conflict do nothing;
  end if;
end $$;

-- One row per person: their Discord side, donations and pets, and their linked accounts (none
-- until accounts are linked to people).
create view member_overview as
select m.discord_id,
       m.display_name,
       coalesce(d.total_gp, 0) as donated_gp,
       (select count(*) from member_pets mp where mp.discord_id = m.discord_id) as pets,
       (select e.kind = 'server_joined' from member_events e
         where e.member_id = m.discord_id and e.kind in ('server_joined', 'server_left')
         order by e.occurred_at desc, e.id desc limit 1) as in_server,
       (select min(e.occurred_at) from member_events e
         where e.member_id = m.discord_id and e.kind = 'server_joined') as first_joined_server_at,
       (select count(*) from accounts a where a.member_id = m.discord_id) as accounts,
       (select a.rsn from accounts a where a.member_id = m.discord_id
         order by a.is_main desc, a.first_joined_at limit 1) as main_rsn,
       (select a.wom_role from accounts a where a.member_id = m.discord_id
         order by a.is_main desc, a.first_joined_at limit 1) as main_role
from members m
left join donations d on d.discord_id = m.discord_id;
