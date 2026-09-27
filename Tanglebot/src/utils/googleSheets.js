const { google } = require('googleapis');

let cachedAuth = null;

// Auth from the service account key in GOOGLE_SERVICE_ACCOUNT_JSON.
function getAuth() {
  if (cachedAuth) return cachedAuth;

  console.log('[Sheets] Initializing Google Sheets auth from service account credentials');
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set in .env');

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON — paste the whole service account key file contents as one line.');
  }

  cachedAuth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return cachedAuth;
}

async function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

async function getRows(sheetId, range) {
  console.log(`[Sheets] Reading sheet rows: ${range}`);
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return res.data.values || [];
}

async function updateRow(sheetId, range, values) {
  console.log(`[Sheets] Updating sheet row: ${range}`);
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  });
}

async function appendRow(sheetId, range, values) {
  console.log(`[Sheets] Appending sheet row: ${range}`);
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
  return res.data;
}

// The row number from an append's updatedRange, e.g. "Sheet!A15:C15" -> 15, or null.
function parseAppendedRowNumber(updatedRange) {
  const match = /![A-Z]+(\d+):/.exec(updatedRange || '');
  if (!match) console.warn(`[Sheets] Could not parse a row number out of updatedRange: "${updatedRange}"`);
  return match ? parseInt(match[1], 10) : null;
}

module.exports = { getRows, updateRow, appendRow, parseAppendedRowNumber };
