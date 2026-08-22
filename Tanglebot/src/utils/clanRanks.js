const cron = require('node-cron');
const { readJson, truncate } = require('./db');
const { getRows, updateRow, appendRow, appendRows } = require('./googleSheets');
const { getGroupMemberships, normalizeRsn } = require('./wiseOldMan');
const { ensureNamedRole, syncNamedRoleAppearance, notifyAdminLog } = require('./roleMenu');

// Fixed tab name matching clanranks_template.xlsx — not configurable.
const SHEET_TAB = 'RankLinks';
const DATA_RANGE = `${SHEET_TAB}!A2:D`;
const APPEND_RANGE = `${SHEET_TAB}!A:D`;

const DAY_MS = 24 * 60 * 60 * 1000;

// Sunday at 00:00 UTC — matches the old CLAN_RANKS_SCHEDULE_DAY=0/CLAN_RANKS_SCHEDULE_HOUR=0 default.
const DEFAULT_CRON = '0 0 * * 0';

// Auto-matched names are trusted outright; merely-plausible ones are only suggested for admin
// review — avoids mis-linking on a coincidental name match.
const AUTO_MATCH_THRESHOLD = 0.85;
const SUGGEST_THRESHOLD = 0.6;

function isConfigured() {
  return Boolean(
    process.env.WOM_GROUP_ID &&
    process.env.CLAN_RANKS_SHEET_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON &&
    process.env.CLAN_ID
  );
}

// Sorted ascending by daysRequired for a simple "highest threshold cleared" scan. `static`
// defaults to false.
function loadRankConfig() {
  const data = readJson('clan-ranks.json');
  const ranks = Array.isArray(data.ranks) ? data.ranks : [];
  return { ranks: [...ranks].sort((a, b) => (a.daysRequired ?? 0) - (b.daysRequired ?? 0)) };
}

function ladderRanks(ranks) {
  return ranks.filter((r) => !r.static && !r.ignore);
}

// Guest/trial members are fully outside the rank system while they hold GUEST_ROLE_ID. Unset
// never excludes anyone.
function isGuest(member) {
  const guestRoleId = process.env.GUEST_ROLE_ID;
  return Boolean(guestRoleId && member.roles.cache.has(guestRoleId));
}

// Highest ladder rank whose threshold the tenure clears, or null if none is.
function rankForTenure(days, ladder) {
  let best = null;
  for (const rank of ladder) {
    if (rank.daysRequired <= days && (!best || rank.daysRequired > best.daysRequired)) best = rank;
  }
  return best;
}

// Finds-or-creates every configured rank's role, backfilling color/icon on existing ones. Static
// ranks still get a managed role, just never auto-added/removed from members. Ranks with
// `"ignore": true` (e.g. donation tiers, Gnome Child) are skipped entirely — not created or
// styled here, since something else owns that role.
async function ensureRankRoles(guild) {
  const { ranks } = loadRankConfig();
  const results = { created: [], updated: [], skipped: [], failed: [] };

  for (const rank of ranks) {
    if (rank.ignore) continue;

    const existing = guild.roles.cache.find((r) => r.name === rank.name);
    if (!existing) {
      const role = await ensureNamedRole(guild, {
        name: rank.name,
        color: rank.color,
        emoji: rank.emoji,
        mentionable: false,
        reason: 'Auto-created for the clan rank ladder (clan-ranks.json)',
        logPrefix: 'ClanRanks',
      });
      results[role ? 'created' : 'failed'].push(rank.name);
      continue;
    }

    const outcome = await syncNamedRoleAppearance(guild, existing, rank, 'Clan rank appearance sync (clan-ranks.json)', 'ClanRanks');
    results[outcome].push(rank.name);
  }

  return results;
}

async function loadRsnLinks() {
  const rows = await getRows(process.env.CLAN_RANKS_SHEET_ID, DATA_RANGE);
  return rows
    .map((r, i) => ({
      rowNumber: i + 2, // +2: header row + 1-indexed
      discordId: r[0] ? String(r[0]).trim() : '',
      displayName: r[1] ? String(r[1]).trim() : '',
      rsn: r[2] ? String(r[2]).trim() : '',
      womPlayerId: r[3] ? String(r[3]).trim() : '',
    }))
    .filter((l) => l.discordId);
}

// Upserts a member's RSN link. A changed RSN clears any resolved WomPlayerId so the next sync
// re-resolves it instead of trusting a stale ID.
async function upsertRsnLink(discordId, displayName, rsn) {
  const sheetId = process.env.CLAN_RANKS_SHEET_ID;
  const links = await loadRsnLinks();
  const existing = links.find((l) => l.discordId === discordId);
  const row = [discordId, displayName, rsn, ''];

  if (existing) {
    await updateRow(sheetId, `${SHEET_TAB}!A${existing.rowNumber}:D${existing.rowNumber}`, row);
  } else {
    await appendRow(sheetId, APPEND_RANGE, row);
  }
}

// No row-delete in the Sheets API surface used here, so blank the row — loadRsnLinks already
// filters out empty-DiscordID rows.
async function removeRsnLink(discordId) {
  const sheetId = process.env.CLAN_RANKS_SHEET_ID;
  const links = await loadRsnLinks();
  const existing = links.find((l) => l.discordId === discordId);
  if (!existing) return false;
  await updateRow(sheetId, `${SHEET_TAB}!A${existing.rowNumber}:D${existing.rowNumber}`, ['', '', '', '']);
  return true;
}

// Matches each sheet row to a WOM membership: by WomPlayerId when known (immune to RSN drift),
// else by normalized RSN. Returns sheetUpdates for any row whose RSN changed or whose
// WomPlayerId was just resolved for the first time.
function matchMembershipsToLinks(links, memberships) {
  const byPlayerId = new Map(memberships.map((m) => [String(m.playerId), m]));
  const byUsername = new Map(memberships.map((m) => [normalizeRsn(m.username), m]));
  const byDisplayName = new Map(memberships.map((m) => [normalizeRsn(m.displayName), m]));

  const matched = [];
  const unmatched = [];
  const sheetUpdates = [];

  for (const link of links) {
    let membership = link.womPlayerId ? byPlayerId.get(String(link.womPlayerId)) : null;
    if (!membership && link.rsn) {
      const norm = normalizeRsn(link.rsn);
      membership = byUsername.get(norm) || byDisplayName.get(norm) || null;
    }

    if (!membership) {
      unmatched.push(link);
      continue;
    }

    matched.push({ link, membership });

    const currentRsn = membership.displayName || membership.username;
    const rsnChanged = Boolean(link.rsn) && normalizeRsn(link.rsn) !== normalizeRsn(currentRsn);
    const playerIdMissing = !link.womPlayerId;

    if (rsnChanged || playerIdMissing) {
      sheetUpdates.push({
        rowNumber: link.rowNumber,
        discordId: link.discordId,
        rsn: currentRsn,
        womPlayerId: membership.playerId,
        renamedFrom: rsnChanged ? link.rsn : null,
      });
    }
  }

  return { matched, unmatched, sheetUpdates };
}

function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

// guild.members.fetch() with no filter sends a gateway "Request Guild Members" call, which Discord
// occasionally rate limits (GatewayRateLimitError, retry_after in seconds) — most often right after
// another full-guild fetch. Waits out the cooldown and retries once instead of failing outright.
async function fetchAllMembers(guild) {
  try {
    return await guild.members.fetch();
  } catch (err) {
    const retryAfter = err?.data?.retry_after;
    if (err?.name !== 'GatewayRateLimitError' || !retryAfter) throw err;
    console.warn(`[ClanRanks] Gateway rate limited fetching members — retrying in ${retryAfter}s.`);
    await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
    return guild.members.fetch();
  }
}

// For every linked-and-matched member, compares their current ladder rank vs. what their WOM
// tenure now qualifies for. A member currently holding an ignored rank's role (e.g. Templar,
// Owner — hand-assigned, "ignore": true in clan-ranks.json) is left alone entirely: no ladder
// rank is computed or applied for them, since the hand-assigned role takes precedence. Read-only
// — callers decide whether to apply the result.
async function computePendingChanges(guild) {
  const { ranks } = loadRankConfig();
  const ladder = ladderRanks(ranks);
  const ladderNames = new Set(ladder.map((r) => r.name));
  const ignoredNames = new Set(ranks.filter((r) => r.ignore).map((r) => r.name));

  const links = await loadRsnLinks();
  const memberships = await getGroupMemberships(process.env.WOM_GROUP_ID);
  const { matched, unmatched, sheetUpdates } = matchMembershipsToLinks(links, memberships);

  await fetchAllMembers(guild).catch(() => null);

  const now = Date.now();
  const changes = [];
  const rankStatuses = [];

  for (const { link, membership } of matched) {
    const member = guild.members.cache.get(link.discordId);
    if (!member) continue; // linked in the sheet but no longer in the server
    if (isGuest(member)) continue; // guest role holders are fully ignored by the rank system

    const heldIgnoredName = member.roles.cache.map((r) => r.name).find((name) => ignoredNames.has(name));
    if (heldIgnoredName) {
      rankStatuses.push({ rowNumber: link.rowNumber, currentRank: heldIgnoredName });
      continue;
    }

    const tenureDays = Math.floor((now - membership.joinedAt.getTime()) / DAY_MS);
    const target = rankForTenure(tenureDays, ladder);

    const currentNames = member.roles.cache
      .filter((r) => ladderNames.has(r.name))
      .map((r) => r.name);
    const desiredNames = target ? [target.name] : [];

    rankStatuses.push({ rowNumber: link.rowNumber, currentRank: target ? target.name : 'None' });

    if (!setsEqual(currentNames, desiredNames)) {
      changes.push({
        discordId: link.discordId,
        displayName: member.displayName,
        fromRank: currentNames.length ? currentNames.join(', ') : 'None',
        toRank: target ? target.name : 'None',
        tenureDays,
      });
    }
  }

  const renames = sheetUpdates.filter((u) => u.renamedFrom);

  return { changes, renames, unmatched, sheetUpdates, rankStatuses };
}

async function writeSheetUpdates(sheetUpdates) {
  const sheetId = process.env.CLAN_RANKS_SHEET_ID;
  for (const u of sheetUpdates) {
    try {
      await updateRow(sheetId, `${SHEET_TAB}!C${u.rowNumber}:D${u.rowNumber}`, [u.rsn, String(u.womPlayerId)]);
    } catch (err) {
      console.error(`[ClanRanks] Failed to update sheet row ${u.rowNumber} for ${u.discordId}:`, err.message);
    }
  }
}

// Writes each member's resulting rank name (or the ignored/hand-assigned rank they hold instead)
// into the sheet's CurrentRank column (E) — lets admins see everyone's current rank from the
// sheet directly, without checking Discord.
async function writeRankStatuses(rankStatuses) {
  const sheetId = process.env.CLAN_RANKS_SHEET_ID;
  for (const s of rankStatuses) {
    try {
      await updateRow(sheetId, `${SHEET_TAB}!E${s.rowNumber}`, [s.currentRank]);
    } catch (err) {
      console.error(`[ClanRanks] Failed to update CurrentRank cell for row ${s.rowNumber}:`, err.message);
    }
  }
}

// Applies a computePendingChanges result: strips every ladder role the member holds (self-healing
// if they'd drifted to more than one) and adds the target, then persists sheet corrections.
async function applyChanges(guild, { changes, sheetUpdates, rankStatuses }) {
  const { ranks } = loadRankConfig();
  const ladderNames = new Set(ladderRanks(ranks).map((r) => r.name));
  const results = { updated: [], failed: [] };

  for (const change of changes) {
    const member = await guild.members.fetch(change.discordId).catch(() => null);
    if (!member) {
      results.failed.push(change.displayName);
      continue;
    }

    try {
      const toRemove = member.roles.cache.filter((r) => ladderNames.has(r.name));
      if (toRemove.size) await member.roles.remove(toRemove);

      if (change.toRank !== 'None') {
        const targetRole = guild.roles.cache.find((r) => r.name === change.toRank);
        if (targetRole) {
          await member.roles.add(targetRole);
        } else {
          console.warn(`[ClanRanks] Target role "${change.toRank}" not found in guild — run /clanranks setup first`);
        }
      }
      results.updated.push(change.displayName);
    } catch (err) {
      console.error(`[ClanRanks] Failed to update rank roles for ${change.displayName}:`, err.message);
      results.failed.push(change.displayName);
    }
  }

  if (sheetUpdates?.length) await writeSheetUpdates(sheetUpdates);
  if (rankStatuses?.length) await writeRankStatuses(rankStatuses);

  return results;
}

function buildReportDescription({ changes, renames, unmatched }) {
  const lines = [];

  if (changes.length === 0) {
    lines.push('No rank changes this week.');
  } else {
    lines.push(`**${changes.length} rank change(s):**`);
    for (const c of changes) {
      lines.push(`<@${c.discordId}> — ${c.fromRank} → **${c.toRank}** (${c.tenureDays}d tenure)`);
    }
  }

  if (renames.length) {
    lines.push('', `**${renames.length} RSN update(s) detected (WOM name change):**`);
    for (const r of renames) {
      lines.push(`<@${r.discordId}> — \`${r.renamedFrom}\` → \`${r.rsn}\``);
    }
  }

  if (unmatched.length) {
    lines.push('', `**${unmatched.length} unmatched link(s)** (not found in the WOM group — check for a typo):`);
    for (const u of unmatched) {
      lines.push(`<@${u.discordId}> — RSN on file: \`${u.rsn || '(blank)'}\``);
    }
  }

  return truncate(lines.join('\n'), 3900);
}

// Full cycle: ensure roles exist -> compute changes -> report to admin log -> apply. Ranks only
// change here or via a manual /clanranks sync.
async function runWeeklyRankSync(client) {
  if (!isConfigured()) return;

  try {
    const guild = await client.guilds.fetch(process.env.CLAN_ID);
    await ensureRankRoles(guild);
    const result = await computePendingChanges(guild);

    await notifyAdminLog(client, '🏅 Weekly Clan Rank Sync', buildReportDescription(result), [], 0x57f287);

    await applyChanges(guild, result);
  } catch (err) {
    console.error('[ClanRanks] Weekly rank sync failed:', err);
  }
}

// Standard 5-field cron format, evaluated in UTC. Falls back to DEFAULT_CRON if CLAN_RANKS_CRON
// is unset or invalid, rather than leaving the sync unscheduled.
function resolveCronExpression() {
  const configured = process.env.CLAN_RANKS_CRON;
  if (!configured) return DEFAULT_CRON;
  if (!cron.validate(configured)) {
    console.warn(`[ClanRanks] Invalid CLAN_RANKS_CRON "${configured}" — falling back to default "${DEFAULT_CRON}".`);
    return DEFAULT_CRON;
  }
  return configured;
}

// Schedules the rank sync on the configured cron expression. Returns a stop function, mirroring
// lfgDeliveryWorker's shape for ClientDestroy.
function scheduleWeeklyRankSync(client) {
  if (!isConfigured()) {
    console.log('[ClanRanks] Weekly rank sync disabled: WOM_GROUP_ID, CLAN_RANKS_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON, or CLAN_ID is missing.');
    return () => {};
  }

  const expression = resolveCronExpression();
  console.log(`[ClanRanks] Rank sync scheduled on cron "${expression}" (UTC).`);

  const task = cron.schedule(expression, () => runWeeklyRankSync(client), { timezone: 'UTC' });

  return () => task.stop();
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1]);
      prevDiag = temp;
    }
  }
  return dp[n];
}

// 1.0 = identical (after normalization), 0.0 = completely different.
function levenshteinSimilarity(a, b) {
  const na = normalizeRsn(a);
  const nb = normalizeRsn(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return 1 - levenshteinDistance(na, nb) / Math.max(na.length, nb.length);
}

// Pulls likely-RSN substrings out of a Discord name, e.g. "Name (Zezima)" -> also tries "Zezima".
function extractNameCandidates(...names) {
  const candidates = new Set();
  for (const raw of names) {
    if (!raw) continue;
    candidates.add(raw);

    const parenMatch = raw.match(/\(([^)]+)\)/);
    if (parenMatch) candidates.add(parenMatch[1]);

    const stripped = raw.replace(/\([^)]*\)/g, '').trim();
    if (stripped) candidates.add(stripped);

    for (const part of raw.split(/[|/\\]/)) {
      const trimmed = part.trim();
      if (trimmed) candidates.add(trimmed);
    }
  }
  return [...candidates];
}

// Seeds RankLinks from the WOM group's membership list — the source of truth is who's actually in
// the clan, not who's in the Discord server. For each WOM member, finds the best-matching Discord
// candidate (not already linked, not a bot or guest) and adds a row for them; a candidate used for
// one match is removed from the pool so two WOM members can't both claim the same Discord account.
// A WOM member with no plausible Discord match at all is reported but not added — there's no
// Discord ID to key a row on.
async function bootstrapLinksFromGuild(guild) {
  await fetchAllMembers(guild);
  const existingLinks = await loadRsnLinks();
  const existingIds = new Set(existingLinks.map((l) => l.discordId));
  const memberships = await getGroupMemberships(process.env.WOM_GROUP_ID);

  const available = [...guild.members.cache.values()].filter(
    (m) => !m.user.bot && !existingIds.has(m.id) && !isGuest(m)
  );

  const newRows = [];
  let autoMatched = 0;
  const needsReview = [];
  const unmatchedWom = [];

  for (const membership of memberships) {
    let best = null;
    for (const member of available) {
      const candidates = extractNameCandidates(member.nickname, member.user.username, member.user.globalName);
      for (const candidate of candidates) {
        const score = Math.max(levenshteinSimilarity(candidate, membership.username), levenshteinSimilarity(candidate, membership.displayName));
        if (!best || score > best.score) best = { score, member };
      }
    }

    const rsn = membership.displayName || membership.username;

    if (!best || best.score < SUGGEST_THRESHOLD) {
      unmatchedWom.push({ rsn, womPlayerId: membership.playerId });
      continue;
    }

    available.splice(available.indexOf(best.member), 1);

    if (best.score >= AUTO_MATCH_THRESHOLD) {
      newRows.push([best.member.id, best.member.displayName, rsn, String(membership.playerId)]);
      autoMatched++;
    } else {
      newRows.push([best.member.id, best.member.displayName, '', '']);
      needsReview.push({
        discordId: best.member.id,
        displayName: best.member.displayName,
        suggestedRsn: rsn,
        score: Math.round(best.score * 100),
      });
    }
  }

  if (newRows.length) await appendRows(process.env.CLAN_RANKS_SHEET_ID, APPEND_RANGE, newRows);

  return { added: newRows.length, autoMatched, needsReview, unmatchedWom };
}

module.exports = {
  isConfigured,
  loadRankConfig,
  ensureRankRoles,
  loadRsnLinks,
  upsertRsnLink,
  removeRsnLink,
  computePendingChanges,
  applyChanges,
  runWeeklyRankSync,
  scheduleWeeklyRankSync,
  bootstrapLinksFromGuild,
};
