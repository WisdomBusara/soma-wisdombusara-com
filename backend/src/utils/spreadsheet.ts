import { deflateRawSync } from 'zlib';

/**
 * Dependency-free CSV and XLSX writers for tabular exports.
 *
 * XLSX is a zip of a handful of XML parts. Writing the minimal set by hand
 * (inline strings, one sheet, one stylesheet) is ~150 lines — cheaper than
 * pulling a spreadsheet library and its transitive tree into a backend that
 * otherwise has no need for one.
 *
 * Both writers treat every string as untrusted: the data is scraped from the
 * open web, so CSV cells are neutralised against formula injection and XLSX
 * text is stripped of characters that would make the XML invalid.
 */

export interface SheetColumn {
  header: string;
  /** Excel column width in characters */
  width?: number;
  /** Render http(s) values as clickable hyperlinks (XLSX only) */
  link?: boolean;
}

export type SheetValue = string | number | Date | null | undefined;

// ── CSV ─────────────────────────────────────────────────────────────────────

// A cell starting with one of these is evaluated as a formula by Excel,
// LibreOffice and Google Sheets (OWASP "CSV injection").
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function csvCell(v: SheetValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = FORMULA_TRIGGER.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel detects the encoding. */
export function writeCsv(columns: SheetColumn[], rows: SheetValue[][]): Buffer {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

// ── XLSX ────────────────────────────────────────────────────────────────────

const EXCEL_CELL_MAX = 32_767;
// Excel refuses hyperlink targets much beyond this
const EXCEL_URL_MAX = 2_000;
// Days between the Excel epoch (1899-12-30) and the Unix epoch
const EXCEL_EPOCH_OFFSET = 25_569;

const STYLE = { default: 0, header: 1, date: 2, link: 3 } as const;

function xmlText(s: string): string {
  return s
    // Control characters and lone surrogates are illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function inlineString(ref: string, text: string, style: number): string {
  const t = xmlText(text.length > EXCEL_CELL_MAX ? text.slice(0, EXCEL_CELL_MAX) : text);
  const s = style ? ` s="${style}"` : '';
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${t}</t></is></c>`;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">`
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>'
  + '<fonts count="3">'
  + '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/></font>'
  + '</fonts>'
  + '<fills count="3">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** Single-sheet XLSX: bold frozen header row, autofilter, dates, hyperlinks. */
export function writeXlsx(sheetName: string, columns: SheetColumn[], rows: SheetValue[][]): Buffer {
  const lastCol = columnName(Math.max(columns.length, 1) - 1);
  const range = `A1:${lastCol}${rows.length + 1}`;
  const links: { ref: string; url: string }[] = [];

  const sheetRows: string[] = [];
  sheetRows.push(`<row r="1">${columns.map((c, i) => inlineString(`${columnName(i)}1`, c.header, STYLE.header)).join('')}</row>`);

  rows.forEach((row, r) => {
    const rowNum = r + 2;
    const cells: string[] = [];
    columns.forEach((col, i) => {
      const v = row[i];
      const ref = `${columnName(i)}${rowNum}`;
      if (v === null || v === undefined || v === '') return;
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return;
        // Whole UTC days, matching how deadlines render elsewhere in the app
        const serial = Math.floor(v.getTime() / 86_400_000) + EXCEL_EPOCH_OFFSET;
        cells.push(`<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`);
      } else if (typeof v === 'number') {
        if (Number.isFinite(v)) cells.push(`<c r="${ref}"><v>${v}</v></c>`);
      } else if (col.link && /^https?:\/\//i.test(v) && v.length <= EXCEL_URL_MAX) {
        links.push({ ref, url: v });
        cells.push(inlineString(ref, v, STYLE.link));
      } else {
        cells.push(inlineString(ref, v, STYLE.default));
      }
    });
    sheetRows.push(`<row r="${rowNum}">${cells.join('')}</row>`);
  });

  const cols = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 14}" customWidth="1"/>`)
    .join('');

  const sheetXml = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + '<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${cols}</cols>`
    + `<sheetData>${sheetRows.join('')}</sheetData>`
    + `<autoFilter ref="${range}"/>`
    + (links.length > 0
      ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>`
      : '')
    + '</worksheet>';

  const sheetRelsXml = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">`
    + links.map((l, i) =>
      `<Relationship Id="rId${i + 1}" Type="${NS_REL}/hyperlink" Target="${xmlText(l.url)}" TargetMode="External"/>`
    ).join('')
    + '</Relationships>';

  const quotedName = `'${sheetName.replace(/'/g, "''")}'`;
  const absRange = range.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
  const workbookXml = `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + `<sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`
    + `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xmlText(`${quotedName}!${absRange}`)}</definedName></definedNames>`
    + '</workbook>';

  const parts: [string, string][] = [
    ['[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>'],
    ['_rels/.rels', `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">`
      + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
      + '</Relationships>'],
    ['xl/workbook.xml', workbookXml],
    ['xl/_rels/workbook.xml.rels', `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">`
      + `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>`
      + '</Relationships>'],
    ['xl/styles.xml', STYLES_XML],
    ['xl/worksheets/sheet1.xml', sheetXml],
    ['xl/worksheets/_rels/sheet1.xml.rels', sheetRelsXml]
  ];

  return zip(parts.map(([name, content]) => ({ name, data: Buffer.from(content, 'utf8') })));
}

// ── Zip container ───────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal deflate zip writer — no zip64, so each archive must stay under 4 GB. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk start, internal/external attrs all zero
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDir, end]);
}
