# What was done today (2026-11-13)

- Added the admin commands post: `ADMIN_COMMANDS_CHANNEL_ID` names a staff channel where the bot keeps one set of messages listing every loaded staff command (example, short description, short option text), grouped by Owner, Templar, Coordinator and server admins, with the role mention and colour in each header. It is edited on startup only when the content changed (`admin-commands-post.json`, mirrored in `bot_state`).
- Added an optional `help` export to every staff command (`category`, `access`, `examples`, `options`), `src/utils/commandDocs.js`, the generic `src/utils/staticMessages.js` (reusable for a later public Start Here page) and `src/utils/adminCommandsPost.js`.
- Tests in `tests/adminCommands.test.mjs` check that help can't drift from the commands, the role grouping, the embed size limits and the message syncing.
