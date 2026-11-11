-- Milestones (a change of donation tier, becoming or ceasing to be a Pet Master) are recorded by the
-- bot's own commands, so member_events gets a fourth source: 'bot'.
alter table member_events drop constraint member_events_source_check;
alter table member_events add constraint member_events_source_check
  check (source in ('wom', 'discord', 'import', 'bot'));
