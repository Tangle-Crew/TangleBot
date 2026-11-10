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

async function main() {
  const missing = ['DATABASE_URL', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'DONATIONS_SHEET_ID', 'PET_HIGHSCORES_SHEET_ID']
    .filter(key => !process.env[key]?.trim());
  if (missing.length) throw new Error(`Missing env var(s): ${missing.join(', ')}`);

  // Loaded here because googleapis is slow to load and the tests do not need it.
  const { getRows } = require('../src/utils/googleSheets');
  console.log('Reading the sheets (read only)...');
  const [donationRows, highscoreRows, catalogRows] = await Promise.all([
    getRows(process.env.DONATIONS_SHEET_ID, 'Donations!A2:C'),
    getRows(process.env.PET_HIGHSCORES_SHEET_ID, 'Highscores!A2:C'),
    getRows(process.env.PET_HIGHSCORES_SHEET_ID, 'Pets!A2:C'),
  ]);
  const data = parseSheets({ donationRows, highscoreRows, catalogRows });

  await database.runMigrations();
  const summary = await database.withTransaction(client => importData(client, data));
  printSummary(summary);
}

if (require.main === module) {
  main()
    .then(() => database.closePool())
    .catch(async err => {
      console.error(`Import failed, nothing was written: ${err.message}`);
      await database.closePool().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { parseSheets, importData };
