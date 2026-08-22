# What Was Done Today - 2026-06-18

- Implemented a new `/kc` slash command with `/kc start` and `/kc end` to gate proof intake behind an explicit user action.
- Added a persisted active-session store so proof intake is tracked per Discord user and survives bot restarts.
- Updated proof message handling so only the active user's next valid KC or drop proof in the same mapped channel is processed.
- Changed the KC session lifecycle so `/kc start` stays open across valid starting submissions and `/kc end` switches into a one-shot ending-KC submission that closes the session afterward.
- Kept `/submission format` and `/submission last` unchanged.
- Updated the project README to document the new `/kc` workflow and the revised proof intake behavior.
