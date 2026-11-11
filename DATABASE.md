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
| `src/utils/migrationTools.js` | The sheets import and its checks (used only by `/migration`; retired with the sheets) |

## Core concepts

- **Member:** a person on Discord, keyed by their Discord ID. Donations, pets and Discord names belong to a member.
- **Account** (planned): an OSRS account, keyed by its Wise Old Man (WOM) player ID. A clan rank, a WOM join date and an RSN change belong to an account. A member can have several accounts (alts), and an account can exist before anyone has linked it to a member.
- **Event** (planned): one row in an append-only history. New kinds of history are new event kinds, not new tables.
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
| `member_names` | A display name a member has had | `discord_id`, `display_name`, `changed_at` | Whenever a name differs from the last one logged. Planned to move into events |
| `member_stays` | A time a member was in the Discord server | `discord_id`, `joined_at`, `left_at` (empty while still in) | Join and leave events, the roster sync. At most one open stay per member. Planned to move into events |
| `command_log` | A slash command run | `discord_id` (no foreign key), `discord_name`, `command`, `options` (jsonb), `status` (`ok`, `error`, `denied`), `error`, `duration_ms`, `channel_id`, `created_at` | Every command, from `runCommand` in `eventHandler.js`; pruned daily |
| `schema_migrations` | An applied migration file | `name` (PK), `applied_at` | The migration runner |

How they connect: `donations`, `donation_log`, `member_pets`, `pet_log`, `member_names` and `member_stays` all point at `members.discord_id`. `member_pets` and `pet_log` also point at `pets.key`. `command_log` deliberately points at nothing: anyone who runs a command is logged, member or not.

### Planned

| Table | Purpose | Notes |
|---|---|---|
| `accounts` | One OSRS account per row, filled from WOM | `wom_player_id` (unique), `rsn`, `member_id` (empty until accounts are linked to people), WOM rank, clan status, WOM join dates and left date, a `wom_data` jsonb copy of WOM's last payload |
| `member_events` | Append-only history for people and accounts | Belongs to a member **or** an account, never both. Kinds such as `name_changed`, `rank_changed`, `joined`, `left`, `rejoined`, and milestones. Has `old_value`, `new_value`, a jsonb `data`, `source` (`wom`, `discord`, `import`), `occurred_at` and `recorded_at` |
| `member_overview` (a view) | One place to read "all member data" | Joins the member, their main account, rank, donations and pet count |
| `competition_results` | Weekly competition standings | Per account, saved when `/weeklyannounce` sends, and back-filled from WOM |
| `honeypot_incidents` | Honeypot timeouts and bans | Metadata only, never message content. No foreign key, like `command_log` |
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
- **jsonb** is for data you will not join or filter on (options, copies of WOM payloads). If you filter on it, make it a column.
- **Primary keys:** `members` uses the Discord ID. New tables use `bigint generated always as identity`.
- **Naming:** lowercase snake_case, plural table names, `<table>_<column>_idx` for indexes.
- **All writes go through the store modules**, inside a transaction when more than one table changes. No SQL in command files.

## Adding to the database

### Migration rules

- Files are `Tanglebot/migrations/NNN_name.sql`, three digits, in order. They run in name order, each in its own transaction, once, on startup. A failed migration stops the bot starting.
- **Applied migrations are not changed.** The runner records the file name only and never compares contents, so an edit changes fresh installs but not the live database. If the live database needs a change, it is a new numbered file.
- **One planned exception:** when the member data PR stops using `member_names` and `member_stays`, they are removed from `002_member_history.sql` so fresh installs never create them. The live database keeps them until the Owner drops them by hand. The rule: edit an old migration only to remove or reshape something the live database already has and someone will handle by hand. Anything the live database needs applied is a new file.
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
| B. Member data | `accounts`, `member_events`, `member_overview`, `/memberdata` (Owner only: `status`, `preview`, `sync`, `verify`), copy the old history into events, optional hourly sync (`MEMBER_SYNC_INTERVAL_MINUTES`) | Planned |
| C. `/profile` | By member or by RSN, for Coordinator and above | Planned |
| D. Milestones | Donation tier and Pet Master as events, back-filled from the logs | Planned |
| E. Competition results | `competition_results`, saved on announce, back-filled from WOM | Planned |
| F. Honeypot incidents | `honeypot_incidents` | Planned |
| G. State files | `bot_state`, moving the `data/*.json` files, simple ones first | Planned |
| Link | Joining accounts to members. Not decided; `/link` does nothing today. `accounts.member_id` is reserved for it | Parked |
| Retire the sheets | After the one-month fallback: remove the Sheets code paths and `/migration` | Planned |

## Decisions

- **Two entities, not one table:** a person (Discord) and an account (OSRS) are different things. WOM tracks accounts and the clan has alts, so one row per person cannot hold ranks per account, and one row per account cannot be the target of donations and pets. Keeping `members` as the person table also meant the six tables pointing at it did not change.
- **History as events:** a new kind of history is a new event kind, with no schema change. A unique key on events keeps a re-sync from duplicating them.
- **Manual first:** data moves (the sheets, the WOM sync) are Owner commands with a preview and a verify step, run by hand the first time. Nothing imports on startup.
- **`command_log` has no foreign key:** staff attempts by people not in `members` should still be logged.
- **Donation total cap:** 10 trillion GP per member, as a typo guard and to stay inside safe Number range.
- **Milestones are events:** they are history with a reached time, not a separate kind of record.

## Known gaps

- A command that catches its own error and replies normally is logged as `ok`, unless it sets `interaction.commandError` (done for `/donationhighscore`, `/pethighscore`, `/migration` and `/commandlog`).
- A member who left and rejoined the Discord server entirely while the bot was down shows as one stay.
- A leave noticed by the startup sync is dated when the bot noticed it.
- Until accounts are linked to members, `/profile @member` can only show the Discord side.

## Operations

- **Backups and restore:** see the README's Database section.
- **Useful queries:** the command log and member history queries are in the README's Database section.
- **Dropping the old history tables** (after the member data PR, once the copied counts match):
  ```sql
  select (select count(*) from member_names) as old_names,
         (select count(*) from member_events where kind = 'name_changed' and source = 'discord') as copied_names;
  -- when they match, and after a backup:
  drop table member_names;
  drop table member_stays;
  ```
