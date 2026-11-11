# TangleBot

A Discord bot for an OSRS clan. The app is in `Tanglebot/` (Node.js, discord.js). The README is the user documentation.

## Before you touch the database

Read [DATABASE.md](DATABASE.md). It explains how the data is stored, the migration rules (applied migrations are never edited, with one documented exception), the conventions, the checklist for a change, and the roadmap. Update it in the same change.

## Working here

- Tests: `cd Tanglebot && npm test`. They are offline (mocked Discord, Wise Old Man and PostgreSQL), so they never touch a live database or Discord. The mocks do not check SQL, so also run new migrations and queries on a real PostgreSQL engine before relying on them.
- Keep a change limited to what was asked. Do not touch unrelated commands.
- Code comments are short and say only what the code does.
- No secrets in the repo. `Tanglebot/.env` is ignored; document new settings in `Tanglebot/.env.example` and the README.
- Each day's work gets a line in `What-was-done/WHAT-WAS-DONE-TODAY-<date>.md`.
- New staff commands are hidden by default (`setDefaultMemberPermissions(0)`) and check the role when they run; the README's Command visibility section lists the Discord overrides to add.
