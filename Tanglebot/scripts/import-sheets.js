// One-off import of the donation and pet Google Sheets into PostgreSQL, from the command line.
// Run from the Tanglebot folder: node scripts/import-sheets.js [--verify | --dry-run]
// (The same import is available in Discord as /migration.) Reads the sheets only; never writes to
// them. Safe to run again.
require('dotenv').config({ quiet: true });
const database = require('../src/utils/database');
const tools = require('../src/utils/migrationTools');

async function main(args = process.argv.slice(2)) {
  const verify = args.includes('--verify');
  const dryRun = args.includes('--dry-run');
  if (verify && dryRun) throw new Error('Use --verify or --dry-run, not both');

  const missing = ['DATABASE_URL', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'DONATIONS_SHEET_ID', 'PET_HIGHSCORES_SHEET_ID']
    .filter(key => !process.env[key]?.trim());
  if (missing.length) throw new Error(`Missing env var(s): ${missing.join(', ')}`);

  if (verify) {
    const verification = await tools.runVerify();
    tools.printVerification(verification);
    if (verification.differences.length) process.exitCode = 1;
    return;
  }

  if (dryRun) console.log('Dry run: nothing will be saved. The migrations must already be applied.');
  const { summary, verification } = await tools.runImport({ dryRun });
  tools.printSummary(summary);
  tools.printVerification(verification);
  if (dryRun) console.log('Dry run finished and rolled back; the database is unchanged.');
  if (verification.differences.length) process.exitCode = 1;
}

main()
  .then(() => database.closePool())
  .catch(async err => {
    console.error(`Failed, nothing was written: ${err.message}`);
    await database.closePool().catch(() => {});
    process.exitCode = 1;
  });
