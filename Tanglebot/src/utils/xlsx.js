const zlib = require('zlib');

// A minimal .xlsx writer: one tab per sheet, holding text and numbers, with optional column widths
// and bold rows. Text is stored as plain strings, so a spreadsheet never runs it as a formula.

// { name: text } -> a zip archive, each file deflated.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    // Version 2.0, UTF-8 names, deflate, a fixed 1980-01-01 timestamp, then the CRC and sizes.
    const fields = header => {
      header.writeUInt16LE(20, 0);
      header.writeUInt16LE(0x0800, 2);
      header.writeUInt16LE(8, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(0x21, 8);
      header.writeUInt32LE(crc, 10);
      header.writeUInt32LE(packed.length, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt16LE(nameBytes.length, 22);
      return header;
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    fields(local.subarray(4)).writeUInt16LE(0, 24);
    locals.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    fields(central.subarray(6));
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Escapes XML and drops the control characters XML can't hold.
function xmlText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 0 -> "A", 26 -> "AA".
function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function sheetXml({ rows, widths = [], boldRows = [] }) {
  const bold = new Set(boldRows);
  const cols = widths.length
    ? `<cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const rowsXml = rows.map((cells, r) => {
    const style = bold.has(r) ? ' s="1"' : '';
    const cellsXml = cells.map((value, c) => {
      if (value === null || value === undefined || value === '') return '';
      const ref = `${columnName(c)}${r + 1}`;
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cellsXml}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rowsXml}</sheetData></worksheet>`;
}

// Style 0 is plain, style 1 bold.
const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '</styleSheet>';

// Tab names: at most 31 characters, none of []:*?/\ and not starting or ending with '.
function sheetName(name) {
  return String(name).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).replace(/^'+|'+$/g, '').trim() || 'Sheet';
}

// [{ name, rows, widths?, boldRows? }] -> the .xlsx file. `rows` are arrays of text or numbers
// (empty cells as '' or null), `widths` are column widths in characters, and `boldRows` are row
// indexes.
function buildXlsx(sheets) {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const types = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files = {
    '[Content_Types].xml': `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${types}.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="${types}.styles+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${types}.worksheet+xml"/>`).join('') +
      '</Types>',
    '_rels/.rels': `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${rels}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${xml}<workbook xmlns="${main}" xmlns:r="${rels}"><sheets>` +
      sheets.map((sheet, i) => `<sheet name="${xmlText(sheetName(sheet.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rels}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="${rels}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES_XML,
  };
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sheet); });
  return zip(files);
}

module.exports = { buildXlsx };
