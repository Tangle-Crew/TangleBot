# What Was Done Today - 2026-06-19

- Added a new `/channelmap` admin command that generates a ready-to-copy `DISCORD_SUBMISSION_CHANNEL_EVENT_MAP` JSON pair and full env var example from the current or selected channel.
- Added automatic 30-minute expiration for active `/kc start` and `/kc end` sessions, including background cleanup for stale session records.
- Updated `/kc` command copy and README documentation to describe the new session timeout behavior and the channel mapping helper command.
