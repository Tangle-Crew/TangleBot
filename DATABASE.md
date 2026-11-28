# Database

How TangleBot stores its information in PostgreSQL and the rules for changing it. **Read this before changing the schema, and update it in the same pull request when you do.** Anyone adding to the database, people or AI assistants, should be able to work from this file alone.

- The README has the setup, the commands and the operations (backups, health alerts). This file is about the data.

## Overview

- PostgreSQL 17 (the `postgres:17-alpine` container `tanglebot-db`), one database, one shared connection pool. No ORM: plain SQL through the `pg` package.
- The bot uses the database when `DATABASE_URL` is set. Unset, the database commands (including the three high score commands) don't load and the command log goes to a file.
- Schema changes are SQL files in `Tanglebot/migrations/`, applied automatically on startup. Data is never moved by a migration.

| Code | What it does |
|---|---|
| `src/utils/database.js` | The pool, `withTransaction`, and the migration runner |
| `src/utils/highScoresDb.js` | Donations, pets and member storage; the only place those tables are written |
| `src/utils/memberHistory.js` | Records Discord joins, leaves and name changes; the startup roster sync |
| `src/utils/commandLog.js` | Writes, reads and prunes the command log |
| `src/utils/memberActivity.js` | What counts as activity, live tracking, and all `member_activity` reads and writes |
| `src/utils/activityBackfill.js` | `/activitybackfill`: the channel access check and the run (saves through `memberActivity.js`) |
| `src/utils/milestones.js` | Finds and rebuilds milestones (donation tier changes, Pet Master) from the logs |
| `src/utils/competitionSync.js` | Reads finished WOM competitions and saves them and their results |
| `src/utils/honeypotLog.js` | Records honeypot incidents (never throws, does nothing without the database) |
| `src/utils/state.js` | `readState`/`writeState`: the small `data/*.json` files, mirrored in `bot_state` |
| `src/utils/history.js` | Reads `donation_log` and `pet_log` for `/history` and builds its embeds |
| `src/utils/profile.js` | Reads one person or one account (read only) and builds the `/profile` embeds |
| `src/utils/memberSync.js` | Reads the Wise Old Man group and saves `accounts` and clan events (used by `/memberdata` and a timer) |
| `src/utils/dbStatus.js` | Read only: the connection check, row counts and pool counters for `/dbstatus` |
| `src/utils/dbHealth.js` | The health monitor: `select 1` on a timer, the admin log alerts, `data/health.json` for the Docker health check |

## Core concepts

- **Member:** a person on Discord, keyed by their Discord ID. Donations, pets and Discord names belong to a member.
- **Account:** an OSRS account, keyed by its Wise Old Man (WOM) player ID. A clan rank, a WOM join date and an RSN change belong to an account. A member can have several accounts (alts), and an account can exist before anyone has linked it to a member.
- **Event:** one row in an append-only history. New kinds of history are new event kinds, not new tables.
- **Source of truth:** Discord for members and their names, WOM for accounts and clan history, the bot's own commands for donations and pets.

## Tables

| Table | One row is | Columns that matter | Written by |
|---|---|---|---|
| `members` | A Discord person | `discord_id` (text, **primary key**), `display_name`, `updated_at` | Commands, the leaderboard name refresh, the startup roster sync, join and name events |
| `donations` | A member's running total | `discord_id` (PK, FK), `total_gp` (bigint, never negative) | `/donationhighscore` |
| `donation_log` | A change to a total | `change_gp` (can be negative), `total_after`, `by_discord_id`, `source` (`command`, `manual`, or `import` for each member's starting total from before the bot kept a log), `created_at` | Same as above, append-only |
| `pets` | A pet in the catalog | `key` (PK), `name`, `emoji_id`, `sort_order` (display order) | `/pethighscore new` |
| `member_pets` | A pet a member owns | `(discord_id, pet_key)` (PK), `added_by`, `added_at` | `/pethighscore` |
| `pet_log` | A pet added or removed | `discord_id`, `pet_key`, `action` (`add`, `remove`), `by_discord_id`, `created_at` | `/pethighscore`, append-only |
| `command_log` | A slash command run | `discord_id` (no foreign key), `discord_name`, `command`, `options` (jsonb), `status` (`ok`, `error`, `denied`), `error`, `duration_ms`, `channel_id`, `created_at` | Every command, from `runCommand` in `eventHandler.js`; pruned daily |
| `accounts` | An OSRS account, from WOM | `wom_player_id` (unique), `username` (WOM's lower-case form), `rsn`, `member_id` (empty until accounts are linked to people), `is_main` (reserved), `wom_role`, `status` (`active`, `left`), `wom_joined_at`, `client_joined_at`, `first_joined_at`, `left_at`, `wom_data` (jsonb copy of WOM's last payload), `synced_at` | `memberSync.js` (`/memberdata`, hourly timer) |
| `member_events` | One change in someone's history | `member_id` **or** `account_id` (exactly one), `kind`, `old_value`, `new_value`, `data` (jsonb), `source` (`wom`, `discord`, `bot`, or `import` for names saved with the starting totals), `occurred_at`, `recorded_at`. Account events from WOM: `joined`, `left`, `rank_changed`, `name_changed`. Person events from Discord: `display_name_changed`, `server_joined`, `server_left` | `memberSync.js` (accounts), `highScoresDb.js`, `memberHistory.js` and `milestones.js` (people); append-only, a unique key stops duplicates |
| `member_overview` (a view) | One row per person | `discord_id`, `display_name`, `donated_gp`, `pets`, `in_server`, `first_joined_server_at`, `accounts`, `main_rsn`, `main_role` | Read only |
| `competitions` | A finished WOM competition | `wom_competition_id` (PK), `title`, `metric`, `metrics`, `starts_at`, `ends_at`, `participant_count`, `total_gained` | `competitionSync.js` (`/memberdata competitions`, then the automatic sync) |
| `competition_results` | One player's result in a competition | `(wom_competition_id, wom_player_id)` (PK), `account_id` (empty if the account was not saved yet), `rsn`, `rank`, `gained`. Only players who gained | `competitionSync.js` |
| `honeypot_incidents` | One honeypot event | `discord_id` and `discord_name` (no foreign key), `action` (`timeout`, `ban`, `false_positive`), `outcome` (`done`, `failed`, `skipped`, `test`), `test_mode`, `channel_id`, `by_discord_id`, `by_discord_name`, `details` (jsonb, never message content), `created_at` | `honeypot.js`, through `honeypotLog.js`; append-only |
| `member_activity` | One person's activity of one kind | `(discord_id, kind)` (PK, no foreign key), `kind` (`message`, `voice`, `command`), `first_at`, `last_at`. Times only, never content | `memberActivity.js`: live, and the backfill |
| `bot_state` | A copy of one small state file | `key` (the file name, PK), `value` (jsonb, the file's contents), `updated_at` | `state.js` (loaded at startup; written with every change). Files covered: the leaderboard message IDs, `stalemembers.json`, `lfg-start-post.json`, `lfg-groups.json`, `weeklyannounce.json` (read from disk, see below), the honeypot test mode, the intake URL override and `last-submission.json`, `admin-commands-post.json` (the admin commands post's message IDs and content hash), `member-activity.json` (when activity tracking started, the backfill's progress and result, and its channel list post), `quietmembers.json` (the newest report's message IDs) |
| `schema_migrations` | An applied migration file | `name` (PK), `applied_at` | The migration runner |

How they connect: `accounts.member_id` (empty for now) points at `members`, `member_events` points at an account or a member, and `competition_results` points at `competitions` and (when known) an account. `donations`, `donation_log`, `member_pets` and `pet_log` all point at `members.discord_id`. `member_pets` and `pet_log` also point at `pets.key`. `command_log`, `honeypot_incidents` and `member_activity` deliberately point at nothing: anyone who runs a command, trips the trap or is active is recorded, member or not.

Milestones (donation tiers, Pet Master) are event kinds, not a table.

## Conventions

- **Discord IDs** are `text` everywhere, never numbers. **OSRS and WOM IDs** are integers.
- **Times** are `timestamptz`. Event rows keep when it happened (`occurred_at`) separate from when the bot learned it (`recorded_at`).
- **Amounts** are `bigint` in the database. `pg` returns them as strings, so the code converts to a Number and keeps totals under 10 trillion GP (`MAX_TOTAL_GP`), far inside `Number.MAX_SAFE_INTEGER`.
- **Never delete members or accounts.** Use a status. History rows must never point at nothing.
- **Logs are append-only** (`donation_log`, `pet_log`, `command_log`, events). Corrections are new rows. The one exception is the command log's age-based prune.
- **Every history row records where it came from** (`source`, or `by_discord_id`).
- **Constrained text** uses `text` plus a `check (... in (...))`, not Postgres enums, so adding a value is a small migration.
- **Event `kind` is not constrained** (no `check`): a new kind of history is a new value. Account kinds are `joined`, `left`, `rank_changed` and `name_changed` (the clan, from WOM); Person kinds are `display_name_changed`, `server_joined` and `server_left` (Discord), and the milestones `donation_tier_changed`, `pet_master_reached` and `pet_master_lost` (the bot).. A rejoin is a join after a leave. Clan and server events have different kinds because leaving the clan and leaving the server are different things. Milestones are person kinds written by the bot's own commands (source `bot`).
- **"In the server" is the latest event.** A person is in the server when their latest `server_joined`/`server_left` event (by `occurred_at`) is `server_joined`. A join is never dated before the leave it follows.
- **jsonb** is for data you will not join or filter on (options, copies of WOM payloads). If you filter on it, make it a column.
- **Primary keys:** `members` uses the Discord ID. New tables use `bigint generated always as identity`.
- **Naming:** lowercase snake_case, plural table names, `<table>_<column>_idx` for indexes.
- **All writes go through the store modules**, inside a transaction when more than one table changes. No SQL in command files.

## Adding to the database

### Migration rules

- Files are `Tanglebot/migrations/NNN_name.sql`, three digits, in order. They run in name order, each in its own transaction, once, on startup. A failed migration stops the bot starting.
- **Applied migrations are not changed.** The runner records the file name only and never compares contents, so an edit changes fresh installs but not the live database. If the live database needs a change, it is a new numbered file.
- **One exception, made once:** step B2 removed `member_names` and `member_stays` from `002_member_history.sql`, so fresh installs never create them. The live database still has them until the Owner drops them by hand (see Operations). The rule: edit an old migration only to remove or reshape something the live database already has and someone will handle by hand. Anything the live database needs applied is a new file.
- **Add in steps** (add the new thing, fill it, switch the code to it, remove the old thing later), so a deploy never leaves the bot and the schema out of step.
- New columns on existing tables are `nullable` or have a default, so the live table is not rewritten.
- A migration creates structure only. Moving data between systems is a command a person runs and checks (such as `/memberdata sync`).

### Checklist for a change

1. The migration file, and a check that it applies cleanly on top of the existing ones.
2. The store function (in `highScoresDb.js`, or a new module for a new area), using parameters, never string-built SQL.
3. Offline tests with the mocked client (`tests/helpers/mockPg.mjs`). Also run the migration and queries on a real PostgreSQL engine, for example with PGlite in a scratch folder outside the repo, since the mocks do not check SQL.
4. The README (commands and operations), this file (tables, conventions), `.env.example` for any new setting, and a line in today's `What-was-done` file.
5. No secrets in the repo; `.env` stays ignored.
6. Re-read the diff for names and code that are no longer used.

## Decisions

- **Two entities, not one table:** a person (Discord) and an account (OSRS) are different things. WOM tracks accounts and the clan has alts, so one row per person cannot hold ranks per account, and one row per account cannot be the target of donations and pets. Keeping `members` as the person table also meant the six tables pointing at it did not change.
- **History as events:** a new kind of history is a new event kind, with no schema change. A unique key on events keeps a re-sync from duplicating them.
- **Sync failures are alerted, not just logged:** an automatic sync that fails posts to the admin log once, repeats at most every 6 hours, and says when it recovers, so a stopped sync is noticed rather than found weeks later.
- **Manual first:** data moves (the WOM sync, the competition history) are Owner commands with a preview and a verify step, run by hand the first time. Nothing imports on startup, and the timer does nothing until the first manual WOM sync has happened.
- **`member_activity` is a summary, not a log:** one row per person and kind, updated in place. Every write keeps the earliest `first_at` and the latest `last_at`, so live tracking and a repeated backfill can overlap safely. There is no count, because it could not be kept right across re-reads. `/quietmembers` only needs "anything since their latest join".
- **`command_log` has no foreign key:** staff attempts by people not in `members` should still be logged.
- **Donation total cap:** 10 trillion GP per member, as a typo guard and to stay inside safe Number range.
- **Competitions are saved by the sync, not when `/weeklyannounce` sends:** that covers every competition, announced or not, and needs no hook into the announcement code.
- **State files are mirrored, not replaced:** every change is still written to the file, and also to `bot_state`. A lost `data/` folder is restored from the table at startup, and removing `DATABASE_URL` still works with no step. Reads come from memory once the table is loaded, so the code that reads them did not need to become asynchronous. The exception is `weeklyannounce.json`: it is always read from the file, because its "claim a job once" check relies on a running bot and a new one seeing each other's changes through it during a deploy. The table is only a copy for restoring it.
- **Milestones are events:** they are history with a reached time, not a separate kind of record. Live milestones and the rebuilt ones are told apart from each other by time (within 5 seconds is the same event), so a rebuild after going live adds no duplicates.

## Known gaps

- Commands run in a thread under a honeypot channel are ignored live, but the backfill counts them: `command_log` has no parent channel.
- Activity while the bot or database is down is not recorded. The backfill can recover messages and public command replies, not voice joins, and cannot see deleted messages or channels.
- A command that catches its own error and replies normally is logged as `ok`, unless it sets `interaction.commandError` (done for `/donationhighscore`, `/pethighscore`, `/commandlog` and `/dbstatus`).
- A member who left and rejoined the Discord server entirely while the bot was down shows as one stay (no leave is recorded).
- A leave noticed by the startup sync is dated when the bot noticed it.
- `lfg-history.jsonl` (one line per finished LFG group, for stats) is append-only and still only a file.
- A state file is not re-read from disk while the bot runs (the table's copy in memory is used), so editing one by hand needs a restart.
- A competition is only saved once it has ended; a player who gained nothing has no result row; the first history run reads at most 120 competitions at a time.
- A donation tier already held at a member's starting total (a `donation_log` row with source `import`) is dated to that row (`data.basis = 'import'`), and a member who was already a Pet Master before their first logged pet change has no milestone date.
- Until accounts are linked to members, `/profile member` can only show the Discord side, donations and pets; use `/profile rsn` for the clan side.
- WOM's history only goes back to when the group started being tracked. An account with only a leave event and no join date has no `first_joined_at`.
- An account's `left_at` is its latest leave event, or when the bot noticed it had gone if WOM has no leave event.
- Name changes are read back 30 days on each automatic sync (WOM lists them by when they were asked for, not approved), so one approved after more than 30 days is only picked up by a fresh full read.

## Operations

- **Backups and restore:** see the README's Database section.
- **Health and alerts:** `/dbstatus` (Owner) shows the connection, migrations, pool and row counts. The health monitor alerts the admin log when the database stays unreachable and when it is back, a failed startup is reported once an hour, and the container has a Docker health check. See the README's Database health alerts.
- **Useful queries:** the command log and member history queries are in the README's Database section.
- **Dropping the old history tables** (`member_names` and `member_stays`, which nothing uses any more). `006` copied their rows into `member_events` and left them in place. Check the copy first; each query must return 0:
  ```sql
  select count(*) from member_names n where not exists (select 1 from member_events e
    where e.member_id = n.discord_id and e.kind = 'display_name_changed' and e.occurred_at = n.changed_at and e.new_value = n.display_name);
  select count(*) from member_stays s where not exists (select 1 from member_events e
    where e.member_id = s.discord_id and e.kind = 'server_joined' and e.occurred_at = s.joined_at);
  select count(*) from member_stays s where s.left_at is not null and not exists (select 1 from member_events e
    where e.member_id = s.discord_id and e.kind = 'server_left' and e.occurred_at = s.left_at);
  ```
  Then, after a backup:
  ```sql
  drop table member_names;
  drop table member_stays;
  ```
  Nothing else changes: a fresh install never creates them, and `006` skips the copy when they are absent.
