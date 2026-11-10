// One-off import of the donation and pet Google Sheets into PostgreSQL.
// Run from the Tanglebot folder: node scripts/import-sheets.js
// Reads the sheets only; it never writes to them. Safe to run again.
require('dotenv').config({ quiet: true });
const database = require('../src/utils/database');
const { MAX_TOTAL_GP } = require('../src/utils/highScoresDb');

// Parses the three tabs the same way the commands do.
function parseSheets({ donationRows, highscoreRows, catalogRows }) {
  return {
    donations: donationRows
      .map(r => ({
        discordId: r[0] ? String(r[0]).trim() : '',
        displayName: r[1] ? String(r[1]).trim() : '',
        donated: r[2] ? parseInt(String(r[2]).replace(/,/g, '').trim(), 10) || 0 : 0,
      }))
      .filter(e => e.discordId),
    highscores: highscoreRows
      .map(r => ({
        discordId: r[0] ? String(r[0]).trim() : '',
        displayName: r[1] ? String(r[1]).trim() : '',
        petKeys: r[2] ? String(r[2]).split(',').map(k => k.trim()).filter(Boolean) : [],
      }))
      .filter(e => e.discordId),
    catalog: catalogRows
      .filter(r => r[0])
      .map(r => ({
        key: String(r[0]).trim(),
        name: String(r[1] || '').trim(),
        emojiId: String(r[2] || '').trim(),
      })),
  };
}

// Writes parsed sheet data using one pg client (call it inside a transaction). Returns the
// numbers to compare with the sheets.
async function importData(client, { donations, highscores, catalog }, log = console.log) {
  const names = new Map();
  for (const e of [...donations, ...highscores]) {
    if (e.displayName && !names.has(e.discordId)) names.set(e.discordId, e.displayName);
  }
  for (const e of [...donations, ...highscores]) {
    if (!names.has(e.discordId)) names.set(e.discordId, e.discordId);
  }

  // Catalog, in sheet order.
  for (const [i, pet] of catalog.entries()) {
    await client.query(
      `insert into pets (key, name, emoji_id, sort_order) values ($1, $2, $3, $4)
       on conflict (key) do update set name = excluded.name, emoji_id = excluded.emoji_id, sort_order = excluded.sort_order`,
      [pet.key, pet.name, pet.emojiId || null, i + 1]
    );
  }
  const catalogKeys = new Set(catalog.map(p => p.key));

  // Members already in the database keep their name, which is newer than the sheet's.
  for (const [discordId, displayName] of names) {
    const inserted = await client.query(
      'insert into members (discord_id, display_name) values ($1, $2) on conflict (discord_id) do nothing',
      [discordId, displayName]
    );
    if (inserted.rowCount) {
      await client.query('insert into member_names (discord_id, display_name) values ($1, $2)', [discordId, displayName]);
    }
  }

  const sheetTotals = { members: names.size, gp: 0, pets: 0, catalog: catalog.length };
  const seenDonors = new Set();
  for (const e of donations) {
    if (seenDonors.has(e.discordId)) {
      log(`Warning: ${e.discordId} is on the Donations tab more than once; using the first row.`);
      continue;
    }
    seenDonors.add(e.discordId);
    let total = e.donated;
    if (total < 0) {
      log(`Warning: ${e.discordId} has a negative total (${total}); importing 0.`);
      total = 0;
    }
    if (total > MAX_TOTAL_GP) {
      log(`Warning: ${e.discordId} has a total over ${MAX_TOTAL_GP.toLocaleString('en-US')}; skipped.`);
      continue;
    }
    sheetTotals.gp += total;

    const history = await client.query(
      `select count(*) filter (where source <> 'import') as other,
              (array_agg(total_after order by id desc))[1] as last_total
       from donation_log where discord_id = $1`,
      [e.discordId]
    );
    const { other, last_total: lastTotal } = history.rows[0];
    if (Number(other) > 0) {
      log(`Warning: ${e.discordId} was changed in the database since the first import; their donation total was left alone.`);
      continue;
    }
    await client.query(
      `insert into donations (discord_id, total_gp) values ($1, $2)
       on conflict (discord_id) do update set total_gp = excluded.total_gp`,
      [e.discordId, total]
    );
    // One log row per import; a re-run only adds one when the total changed.
    if (lastTotal === null || lastTotal === undefined || Number(lastTotal) !== total) {
      await client.query(
        `insert into donation_log (discord_id, change_gp, total_after, source) values ($1, $2, $3, 'import')`,
        [e.discordId, total - Number(lastTotal ?? 0), total]
      );
    }
  }

  const seenCollectors = new Set();
  for (const e of highscores) {
    if (seenCollectors.has(e.discordId)) {
      log(`Warning: ${e.discordId} is on the Highscores tab more than once; using the first row.`);
      continue;
    }
    seenCollectors.add(e.discordId);
    for (const key of new Set(e.petKeys)) {
      sheetTotals.pets += 1;
      if (!catalogKeys.has(key)) {
        log(`Warning: pet key "${key}" (${e.discordId}) is not in the Pets catalog; skipped.`);
        continue;
      }
      await client.query(
        'insert into member_pets (discord_id, pet_key) values ($1, $2) on conflict (discord_id, pet_key) do nothing',
        [e.discordId, key]
      );
    }
  }

  const count = async sql => Number((await client.query(sql)).rows[0].n);
  return {
    sheets: sheetTotals,
    database: {
      members: await count('select count(*) as n from (select discord_id from donations union select discord_id from member_pets) x'),
      gp: await count('select coalesce(sum(total_gp), 0) as n from donations'),
      pets: await count('select count(*) as n from member_pets'),
      catalog: await count('select count(*) as n from pets'),
    },
  };
}

function printSummary({ sheets, database: db }, log = console.log) {
  const fmt = n => n.toLocaleString('en-US');
  log('');
  log('                          Sheets      Database');
  log(`Members                   ${fmt(sheets.members).padEnd(11)} ${fmt(db.members)} (with donations or pets)`);
  log(`Total GP donated          ${fmt(sheets.gp).padEnd(11)} ${fmt(db.gp)}`);
  log(`Total pets owned          ${fmt(sheets.pets).padEnd(11)} ${fmt(db.pets)}`);
  log(`Pets in the catalog       ${fmt(sheets.catalog).padEnd(11)} ${fmt(db.catalog)}`);
  log('');
  log('Differences are explained by the warnings above (skipped pet keys or members).');
}

// Compares the parsed sheet data with the database, member by member. Read only.
// Returns { differences, notes }: differences are mismatches; notes are expected gaps (members
// changed since the import, pets added since, pet keys the import skipped).
async function verifyData(client, { donations, highscores, catalog }) {
  const differences = [];
  const notes = [];
  const rows = async sql => (await client.query(sql)).rows;
  const gp = n => n.toLocaleString('en-US');

  // Catalog: same keys, names and emoji IDs, in the sheet's order.
  const dbCatalog = await rows('select key, name, emoji_id from pets order by sort_order, key');
  const dbPet = new Map(dbCatalog.map(p => [p.key, p]));
  const sheetKeys = new Set(catalog.map(p => p.key));
  for (const pet of catalog) {
    const row = dbPet.get(pet.key);
    if (!row) differences.push(`Pet "${pet.key}" is on the Pets tab but not in the database.`);
    else if (row.name !== pet.name || (row.emoji_id || '') !== pet.emojiId) {
      differences.push(`Pet "${pet.key}": sheet has "${pet.name}" / ${pet.emojiId || 'no emoji'}, database has "${row.name}" / ${row.emoji_id || 'no emoji'}.`);
    }
  }
  const dbOrder = dbCatalog.filter(p => sheetKeys.has(p.key)).map(p => p.key);
  const sheetOrder = catalog.map(p => p.key).filter(k => dbPet.has(k));
  if (dbOrder.join() !== sheetOrder.join()) differences.push('The pet catalog is in a different order than the Pets tab.');
  const extra = dbCatalog.filter(p => !sheetKeys.has(p.key)).map(p => p.key);
  if (extra.length) notes.push(`${extra.length} pet(s) only in the database (added since the import): ${extra.join(', ')}.`);

  // Donations. A member with a command or manual log row has changed since the import.
  const dbTotals = new Map((await rows('select discord_id, total_gp from donations')).map(r => [r.discord_id, Number(r.total_gp)]));
  const donationChanged = new Set((await rows("select distinct discord_id from donation_log where source <> 'import'")).map(r => r.discord_id));
  const seenDonors = new Set();
  for (const e of donations) {
    if (seenDonors.has(e.discordId)) continue;
    seenDonors.add(e.discordId);
    const expected = Math.max(e.donated, 0);
    if (expected > MAX_TOTAL_GP) continue;
    const label = `${e.displayName || e.discordId} (${e.discordId})`;
    if (donationChanged.has(e.discordId)) {
      notes.push(`${label}: donations changed in the database since the import, not compared.`);
    } else if (!dbTotals.has(e.discordId)) {
      differences.push(`${label}: sheet has ${gp(expected)} GP donated, the database has no row.`);
    } else if (dbTotals.get(e.discordId) !== expected) {
      differences.push(`${label}: sheet has ${gp(expected)} GP donated, database has ${gp(dbTotals.get(e.discordId))}.`);
    }
  }
  const newDonors = [...dbTotals.keys()].filter(id => !seenDonors.has(id));
  if (newDonors.length) notes.push(`${newDonors.length} donor(s) only in the database (added since the import).`);

  // Pets: each member's set of pets. Keys not in the catalog were skipped by the import.
  const dbPets = new Map();
  for (const r of await rows('select discord_id, pet_key from member_pets')) {
    if (!dbPets.has(r.discord_id)) dbPets.set(r.discord_id, new Set());
    dbPets.get(r.discord_id).add(r.pet_key);
  }
  const petsChanged = new Set((await rows('select distinct discord_id from pet_log')).map(r => r.discord_id));
  const seenCollectors = new Set();
  for (const e of highscores) {
    if (seenCollectors.has(e.discordId)) continue;
    seenCollectors.add(e.discordId);
    const label = `${e.displayName || e.discordId} (${e.discordId})`;
    const unknown = [...new Set(e.petKeys)].filter(k => !sheetKeys.has(k));
    if (unknown.length) notes.push(`${label}: pet key(s) not in the catalog, skipped by the import: ${unknown.join(', ')}.`);
    if (petsChanged.has(e.discordId)) {
      notes.push(`${label}: pets changed in the database since the import, not compared.`);
      continue;
    }
    const expected = new Set(e.petKeys.filter(k => sheetKeys.has(k)));
    const actual = dbPets.get(e.discordId) ?? new Set();
    const missingPets = [...expected].filter(k => !actual.has(k));
    const extraPets = [...actual].filter(k => !expected.has(k));
    if (missingPets.length) differences.push(`${label}: missing from the database: ${missingPets.join(', ')}.`);
    if (extraPets.length) differences.push(`${label}: in the database but not on the sheet: ${extraPets.join(', ')}.`);
  }
  const newCollectors = [...dbPets.keys()].filter(id => !seenCollectors.has(id) && !petsChanged.has(id));
  if (newCollectors.length) differences.push(`${newCollectors.length} member(s) have pets in the database but are not on the Highscores tab.`);

  return { differences, notes };
}

function printVerification({ differences, notes }, log = console.log) {
  log('');
  for (const n of notes) log(`Note: ${n}`);
  if (!differences.length) {
    log('Verified: every donation total, member pet list and the pet catalog match the sheets.');
    return;
  }
  log(`${differences.length} difference(s) found:`);
  for (const d of differences) log(`  - ${d}`);
}

// Thrown to roll back a dry run's transaction.
class DryRunComplete extends Error {
  constructor(result) {
    super('dry run');
    this.result = result;
  }
}

async function readSheets() {
  // Loaded here because googleapis is slow to load and the tests do not need it.
  const { getRows } = require('../src/utils/googleSheets');
  console.log('Reading the sheets (read only)...');
  const [donationRows, highscoreRows, catalogRows] = await Promise.all([
    getRows(process.env.DONATIONS_SHEET_ID, 'Donations!A2:C'),
    getRows(process.env.PET_HIGHSCORES_SHEET_ID, 'Highscores!A2:C'),
    getRows(process.env.PET_HIGHSCORES_SHEET_ID, 'Pets!A2:C'),
  ]);
  return parseSheets({ donationRows, highscoreRows, catalogRows });
}

// Modes: (none) import; --verify compares the sheets with the database; --dry-run imports and
// verifies inside a transaction that is rolled back.
async function main(args = process.argv.slice(2)) {
  const verify = args.includes('--verify');
  const dryRun = args.includes('--dry-run');
  if (verify && dryRun) throw new Error('Use --verify or --dry-run, not both');

  const missing = ['DATABASE_URL', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'DONATIONS_SHEET_ID', 'PET_HIGHSCORES_SHEET_ID']
    .filter(key => !process.env[key]?.trim());
  if (missing.length) throw new Error(`Missing env var(s): ${missing.join(', ')}`);

  const data = await readSheets();

  if (verify) {
    const result = await verifyData(database.getPool(), data);
    printVerification(result);
    if (result.differences.length) process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log('Dry run: nothing will be saved. The migrations must already be applied (start the bot once).');
    try {
      await database.withTransaction(async client => {
        const summary = await importData(client, data);
        throw new DryRunComplete({ summary, verification: await verifyData(client, data) });
      });
    } catch (err) {
      if (!(err instanceof DryRunComplete)) throw err;
      printSummary(err.result.summary);
      printVerification(err.result.verification);
      console.log('Dry run finished and rolled back; the database is unchanged.');
      if (err.result.verification.differences.length) process.exitCode = 1;
    }
    return;
  }

  await database.runMigrations();
  const summary = await database.withTransaction(client => importData(client, data));
  printSummary(summary);
}

if (require.main === module) {
  main()
    .then(() => database.closePool())
    .catch(async err => {
      console.error(`Failed, nothing was written: ${err.message}`);
      await database.closePool().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { parseSheets, importData, verifyData, main };
