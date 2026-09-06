const { google } = require('googleapis');

let cachedAuth = null;

// Reads the full service-account JSON key (as downloaded from Google Cloud
// Console, minified to one line) out of GOOGLE_SERVICE_ACCOUNT_JSON.
function getAuth() {
  if (cachedAuth) return cachedAuth;

  console.log('Initializing Google Sheets auth from service account credentials');
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
  console.log(`Reading sheet rows: ${range}`);
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return res.data.values || [];
}

async function updateRow(sheetId, range, values) {
  console.log(`Updating sheet row: ${range}`);
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  });
}

async function appendRow(sheetId, range, values) {
  console.log(`Appending sheet row: ${range}`);
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

module.exports = { getRows, updateRow, appendRow };
