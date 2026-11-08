# Known Issues

Open issues from the September 2026 audit, each with a possible fix. Submission intake issues are tracked separately and not listed here.

## Bugs

None open.

## Limitations

This is known and left as it is for now.

### 1. LFG groups rebuilt from their posts lose a little

**Issue:** Open groups are restored on startup from `data/lfg-groups.json`. Groups missing from that file are rebuilt from their forum posts ([lfgPost.js](Tanglebot/src/utils/lfgPost.js), `recoverFromPost`). A post doesn't hold players hidden by "…and N more", which only happens past about 70 people in one group.

The admin log lists the groups affected. On the permanent deployment `data/` is kept, so this mainly affects groups open during the first deploy of the version that added the save file, before the file exists.

**Possible fix:** None needed in normal use. Deploying while no groups are open avoids the issue entirely.
