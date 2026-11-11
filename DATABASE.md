# Database

How TangleBot stores its information in PostgreSQL, the rules for changing it, and the plan for what is added next. **Read this before changing the schema, and update it in the same pull request when you do.** Anyone adding to the database, people or AI assistants, should be able to work from this file alone.

- Status words: **built** is in the schema today; **planned** is agreed but not built yet.
- The README has the setup, the commands and the operations (backups, the sheets move). This file is about the data.

## Overview

- PostgreSQL 17 (the `postgres:17-alpine` container `tanglebot-db`), one database, one shared connection pool. No ORM: plain SQL through the `pg` package.
- The bot uses the database when `DATABASE_URL` is set. Unset, the three high score commands fall back to the old Google Sheets and the command log goes to a file.
- Schema changes are SQL files in `Tanglebot/migrations/`, applied automatically on startup. Data is never moved by a migration: the sheets import is the Owner-only `/migration` command.

| Code | What it does |
|---|---|
| `src/utils/database.js` | The pool, `withTransaction`, and the migration runner |
| `src/utils/highScoresDb.js` | Donations, pets and member storage; the only place those tables are written |
| `src/utils/memberHistory.js` | Records Discord joins, leaves and name changes; the startup roster sync |
| `src/utils/commandLog.js` | Writes, reads and prunes the command log |
| `src/utils/milestones.js` | Finds and rebuilds milestones (donation tier changes, Pet Master) from the logs |
| `src/utils/competitionSync.js` | Reads finished WOM competitions and saves them and their results |
| `src/utils/honeypotLog.js` | Records honeypot incidents (never throws, does nothing without the database) |
| `src/utils/profile.js` | Reads one person or one account (read only) and builds the `/profile` embeds |
| `src/utils/memberSync.js` | Reads the Wise Old Man group and saves `accounts` and clan events (used by `/memberdata` and a timer) |
| `src/utils/migrationTools.js` | The sheets import and its checks (used only by `/migration`; retired with the sheets) |

## Core concepts

- **Member:** a person on Discord, keyed by their Discord ID. Donations, pets and Discord names belong to a member.
- **Account:** an OSRS account, keyed by its Wise Old Man (WOM) player ID. A clan rank, a WOM join date and an RSN change belong to an account. A member can have several accounts (alts), and an account can exist before anyone has linked it to a member.
- **Event:** one row in an append-only history. New kinds of history are new event kinds, not new tables.
- **Source of truth:** Discord for members and their names, WOM for accounts and clan history, the bot's own commands for donations and pets. The Google Sheets are only the old source, kept read-only for a month after the move.

## Tables

### Built

| Table | One row is | Columns that matter | Written by |
|---|---|---|---|
| `members` | A Discord person | `discord_id` (text, **primary key**), `display_name`, `updated_at` | Commands, the leaderboard name refresh, the startup roster sync, join and name events |
| `donations` | A member's running total | `discord_id` (PK, FK), `total_gp` (bigint, never negative) | `/donationhighscore`, the import |
| `donation_log` | A change to a total | `change_gp` (can be negative), `total_after`, `by_discord_id`, `source` (`command`, `import`, `manual`), `created_at` | Same as above, append-only |
| `pets` | A pet in the catalog | `key` (PK), `name`, `emoji_id`, `sort_order` (display order) | `/pethighscore new`, the import |
| `member_pets` | A pet a member owns | `(discord_id, pet_key)` (PK), `added_by`, `added_at` | `/pethighscore`, the import |
| `pet_log` | A pet added or removed | `discord_id`, `pet_key`, `action` (`add`, `remove`), `by_discord_id`, `created_at` | `/pethighscore`, append-only |
| `command_log` | A slash command run | `discord_id` (no foreign key), `discord_name`, `command`, `options` (jsonb), `status` (`ok`, `error`, `denied`), `error`, `duration_ms`, `channel_id`, `created_at` | Every command, from `runCommand` in `eventHandler.js`; pruned daily |
| `accounts` | An OSRS account, from WOM | `wom_player_id` (unique), `username` (WOM's lower-case form), `rsn`, `member_id` (empty until accounts are linked to people), `is_main` (reserved), `wom_role`, `status` (`active`, `left`), `wom_joined_at`, `client_joined_at`, `first_joined_at`, `left_at`, `wom_data` (jsonb copy of WOM's last payload), `synced_at` | `memberSync.js` (`/memberdata`, hourly timer) |
| `member_events` | One change in someone's history | `member_id` **or** `account_id` (exactly one), `kind`, `old_value`, `new_value`, `data` (jsonb), `source` (`wom`, `discord`, `import`, `bot`), `occurred_at`, `recorded_at`. Account events from WOM: `joined`, `left`, `rank_changed`, `name_changed`. Person events from Discord: `display_name_changed`, `server_joined`, `server_left` | `memberSync.js` (accounts), `highScoresDb.js`, `memberHistory.js` and `milestones.js` (people); append-only, a unique key stops duplicates |
| `member_overview` (a view) | One row per person | `discord_id`, `display_name`, `donated_gp`, `pets`, `in_server`, `first_joined_server_at`, `accounts`, `main_rsn`, `main_role` | Read only |
| `competitions` | A finished WOM competition | `wom_competition_id` (PK), `title`, `metric`, `metrics`, `starts_at`, `ends_at`, `participant_count`, `total_gained` | `competitionSync.js` (`/memberdata competitions`, then the automatic sync) |
| `competition_results` | One player's result in a competition | `(wom_competition_id, wom_player_id)` (PK), `account_id` (empty if the account was not saved yet), `rsn`, `rank`, `gained`. Only players who gained | `competitionSync.js` |
| `honeypot_incidents` | One honeypot event | `discord_id` and `discord_name` (no foreign key), `action` (`timeout`, `ban`, `false_positive`), `outcome` (`done`, `failed`, `skipped`, `test`), `test_mode`, `channel_id`, `by_discord_id`, `by_discord_name`, `details` (jsonb, never message content), `created_at` | `honeypot.js`, through `honeypotLog.js`; append-only |
| `schema_migrations` | An applied migration file | `name` (PK), `applied_at` | The migration runner |

How they connect: `accounts.member_id` (empty for now) points at `members`, `member_events` points at an account or a member, and `competition_results` points at `competitions` and (when known) an account. `donations`, `donation_log`, `member_pets` and `pet_log` all point at `members.discord_id`. `member_pets` and `pet_log` also point at `pets.key`. `command_log` and `honeypot_incidents` deliberately point at nothing: anyone who runs a command or trips the trap is logged, member or not.

### Planned

| Table | Purpose | Notes |
|---|---|---|
| `bot_state` | Small key and JSON values, replacing the `data/*.json` files | Staged: simple files first, LFG and weekly announcements last |

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
- A migration creates structure only. Moving data between systems is a command a person runs and checks (see `/migration`).

### Checklist for a change

1. The migration file, and a check that it applies cleanly on top of the existing ones.
2. The store function (in `highScoresDb.js`, or a new module for a new area), using parameters, never string-built SQL.
3. Offline tests with the mocked client (`tests/helpers/mockPg.mjs`). Also run the migration and queries on a real PostgreSQL engine, for example with PGlite in a scratch folder outside the repo, since the mocks do not check SQL.
4. The README (commands and operations), this file (tables, conventions, roadmap), `.env.example` for any new setting, and a line in today's `What-was-done` file.
5. No secrets in the repo; `.env` stays ignored.
6. Re-read the diff for names and code that are no longer used.

## Roadmap

| Step | Contents | Status |
|---|---|---|
| Sheets to PostgreSQL | High scores, member history, `/migration` | Built |
| A. Command log | `discord_name`, `denied`, `/commandlog`, daily prune, this file, backup example | Built |
| B. Member data, WOM side | `accounts`, `member_events`, `/memberdata` (Owner only: `status`, `preview`, `sync`, `verify`), automatic sync every `MEMBER_SYNC_INTERVAL_MINUTES` after the first manual one | Built |
| B2. Discord history in events | Server joins, leaves and name changes are person events; `006` copies the old history into `member_events` and adds `member_overview`; `002` no longer creates the old tables | Built. The old tables stay until you drop them |
| C. `/profile` | By member or by RSN, for Coordinator and above | Built |
| D. Milestones | Donation tier and Pet Master as events, recorded as they happen and rebuilt from the logs by `/memberdata milestones` | Built |
| E. Competition results | `competitions` and `competition_results`: every finished clan competition, read from WOM by `/memberdata competitions` and then the automatic sync | Built |
| F. Honeypot incidents | `honeypot_incidents`: the automatic timeout and the admin buttons, metadata only | Built |
| G. State files | `bot_state`, moving the `data/*.json` files, simple ones first | Planned |
| Link | Joining accounts to members. Not decided; `/link` does nothing today. `accounts.member_id` is reserved for it | Parked |
| Retire the sheets | After the one-month fallback: remove the Sheets code paths and `/migration` | Planned |

## Decisions

- **Two entities, not one table:** a person (Discord) and an account (OSRS) are different things. WOM tracks accounts and the clan has alts, so one row per person cannot hold ranks per account, and one row per account cannot be the target of donations and pets. Keeping `members` as the person table also meant the six tables pointing at it did not change.
- **History as events:** a new kind of history is a new event kind, with no schema change. A unique key on events keeps a re-sync from duplicating them.
- **Manual first:** data moves (the sheets, the WOM sync) are Owner commands with a preview and a verify step, run by hand the first time. Nothing imports on startup, and the timer does nothing until the first manual WOM sync has happened.
- **`command_log` has no foreign key:** staff attempts by people not in `members` should still be logged.
- **Donation total cap:** 10 trillion GP per member, as a typo guard and to stay inside safe Number range.
- **Competitions are saved by the sync, not when `/weeklyannounce` sends:** that covers every competition, announced or not, and needs no hook into the announcement code.
- **Milestones are events:** they are history with a reached time, not a separate kind of record. Live milestones and the rebuilt ones are told apart from each other by time (within 5 seconds is the same event), so a rebuild after going live adds no duplicates.

## Known gaps

- A command that catches its own error and replies normally is logged as `ok`, unless it sets `interaction.commandError` (done for `/donationhighscore`, `/pethighscore`, `/migration` and `/commandlog`).
- A member who left and rejoined the Discord server entirely while the bot was down shows as one stay (no leave is recorded).
- A leave noticed by the startup sync is dated when the bot noticed it.
- A competition is only saved once it has ended; a player who gained nothing has no result row; the first history run reads at most 120 competitions at a time.
- A donation tier already held at the sheets import is dated to the import (`data.basis = 'import'`), and a member who was already a Pet Master before their first logged pet change has no milestone date.
- Until accounts are linked to members, `/profile member` can only show the Discord side, donations and pets; use `/profile rsn` for the clan side.
- WOM's history only goes back to when the group started being tracked. An account with only a leave event and no join date has no `first_joined_at`.
- An account's `left_at` is its latest leave event, or when the bot noticed it had gone if WOM has no leave event.
- Name changes are read back 30 days on each automatic sync (WOM lists them by when they were asked for, not approved), so one approved after more than 30 days is only picked up by a fresh full read.

## Operations

- **Backups and restore:** see the README's Database section.
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
