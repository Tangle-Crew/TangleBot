-- The clan's finished Wise Old Man (WOM) competitions and how each player did. Results belong to an
-- OSRS account (wom_player_id; account_id is filled in when the account is saved).
create table competitions (
  wom_competition_id integer primary key,
  title              text not null,
  metric             text not null,
  metrics            text[] not null default '{}',
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  participant_count  integer not null default 0,
  total_gained       double precision not null default 0,
  recorded_at        timestamptz not null default now()
);
create index competitions_ends_idx on competitions (ends_at);

-- One row per player who gained anything. rank is 1 plus the number of players who gained more, so
-- a tie for 2nd leaves no 3rd.
create table competition_results (
  wom_competition_id integer not null references competitions(wom_competition_id),
  wom_player_id      integer not null,
  account_id         bigint references accounts(id),
  rsn                text not null,
  rank               integer not null,
  gained             double precision not null,
  primary key (wom_competition_id, wom_player_id)
);
create index competition_results_account_idx on competition_results (account_id);
create index competition_results_player_idx on competition_results (wom_player_id);
