import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'zlib';
import { writeCsv, writeXlsx } from '../../utils/spreadsheet';
import {
  EXPORT_COLUMNS, buildScholarshipFilter, renderScholarshipExport, sortForApplying,
  type ExportSource
} from './export';

/**
 * Export tests.
 *
 * The data behind these files is scraped from arbitrary web pages, so the
 * properties worth pinning down are the hostile-input ones: a title starting
 * with "=" must not become a live formula in CSV, and a stray control
 * character must not corrupt the XLSX XML. The zip reader below also checks
 * every CRC, which is what Excel does before it offers to "repair" a file.
 */

// Minimal zip reader — walks the central directory and inflates each entry.
function unzip(buf: Buffer): Map<string, string> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const data = inflateRawSync(buf.subarray(start, start + csize));
    expect(data.length).toBe(usize);
    files.set(name, data.toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const fixture = (over: Partial<ExportSource> = {}): ExportSource => ({
  _id: '64b000000000000000000001',
  title: 'Global Excellence Scholarship',
  universityName: 'University of Nairobi',
  country: 'Kenya',
  degreeLevels: ['MASTERS', 'PHD'],
  studyMode: ['UNKNOWN'],
  status: 'OPEN',
  reviewStatus: 'APPROVED',
  confidence: 0.874,
  sourceUrl: 'https://uonbi.ac.ke/scholarships/global',
  applicationUrl: { value: 'https://uonbi.ac.ke/apply?x=1&y=2' },
  deadline: { date: new Date('2027-01-15T23:59:00Z'), kind: 'FIXED', originalText: 'Closes 15 January 2027' },
  funding: {
    primaryType: 'FULLY_FUNDED',
    tuitionCovered: { value: true },
    livingStipend: { value: true },
    healthInsurance: { value: null },
    travelCovered: { value: false },
    stipendAmount: { amount: 1200, currency: 'GBP', period: 'per month' }
  },
  eligibility: { scope: 'SPECIFIC_COUNTRIES', countries: ['KE', 'UG'], womenOnly: { value: null } },
  requirements: {
    english: { ielts: { required: true, minScore: 6.5, detail: 'no band below 6.0' }, toefl: { required: null } },
    documents: [{ label: 'CV' }, { label: 'Reference letter', count: 2 }],
    workExperienceRequired: { value: null }
  },
  ...over
});

const column = (header: string) => {
  const i = EXPORT_COLUMNS.findIndex((c) => c.header === header);
  expect(i).toBeGreaterThanOrEqual(0);
  return (s: ExportSource) => EXPORT_COLUMNS[i].value(s);
};

describe('writeCsv', () => {
  it('writes a BOM, quotes special characters and neutralises formulas', () => {
    const csv = writeCsv(
      [{ header: 'A' }, { header: 'B' }, { header: 'C' }, { header: 'D' }],
      [
        ['=HYPERLINK("http://evil")', 'say "hi", ok', 'line1\nline2', 42],
        ['+1', '-x', '@SUM(A1)', new Date('2027-01-15T23:59:00Z')],
        [null, undefined, '', 'plain']
      ]
    ).toString('utf8');

    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('A,B,C,D');
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil"")","say ""hi"", ok","line1\nline2",42`);
    expect(csv).toContain("'+1,'-x,'@SUM(A1),2027-01-15");
    expect(csv).toContain(',,,plain');
  });
});

describe('writeXlsx', () => {
  it('produces a valid zip with the expected parts and intact CRCs', () => {
    const files = unzip(writeXlsx('Scholarships', [{ header: 'A' }], [['x']]));
    expect([...files.keys()]).toEqual(expect.arrayContaining([
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
      'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/_rels/sheet1.xml.rels'
    ]));
  });

  it('escapes XML, strips control characters, types dates and links http(s) only', () => {
    const files = unzip(writeXlsx(
      'Scholarships',
      [{ header: 'Text' }, { header: 'When' }, { header: 'Link', link: true }, { header: 'N' }],
      [
        ['A & B <i>\u0007</i>', new Date('2027-01-15T23:59:00Z'), 'https://a.example/?x=1&y=2', 3],
        ['=1+1', null, 'javascript:alert(1)', null]
      ]
    ));
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    const rels = files.get('xl/worksheets/_rels/sheet1.xml.rels')!;

    expect(sheet).toContain('A &amp; B &lt;i&gt;&lt;/i&gt;');
    expect(sheet).not.toContain('\u0007');
    // 2027-01-15 is Excel serial 46402
    expect(sheet).toContain('<c r="B2" s="2"><v>46402</v></c>');
    expect(sheet).toContain('<c r="D2"><v>3</v></c>');
    // Strings are always inline text, never formulas
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('<hyperlink ref="C2" r:id="rId1"/>');
    expect(sheet).not.toContain('ref="C3"');
    expect(rels).toContain('Target="https://a.example/?x=1&amp;y=2" TargetMode="External"');
    expect(rels).not.toContain('javascript');
    expect(sheet).toContain('<autoFilter ref="A1:D3"/>');
    expect(files.get('xl/workbook.xml')).toContain("'Scholarships'!$A$1:$D$3");
  });
});

describe('scholarship export columns', () => {
  it('maps funding, eligibility and requirements into applicant-facing text', () => {
    const s = fixture();
    expect(column('Degree level')(s)).toBe("Master's, PhD");
    expect(column('Funding')(s)).toBe('Fully funded');
    expect(column('Covers')(s)).toBe('Tuition, Living stipend');
    expect(column('Stipend')(s)).toBe('GBP 1,200 per month');
    expect(column('Open to')(s)).toBe('Specific countries; Countries: KE, UG');
    expect(column('English test')(s)).toBe('IELTS 6.5 (no band below 6.0)');
    expect(column('Documents')(s)).toBe('CV; Reference letter (2)');
    expect(column('Application link')(s)).toBe('https://uonbi.ac.ke/apply?x=1&y=2');
    expect(column('Confidence %')(s)).toBe(87);
  });

  it('leaves "not stated" blank rather than implying "No" (§56)', () => {
    const s = fixture({ funding: { primaryType: 'UNKNOWN' }, eligibility: {}, requirements: {}, studyMode: ['UNKNOWN'] });
    expect(column('Funding')(s)).toBe('');
    expect(column('Covers')(s)).toBe('');
    expect(column('Work experience')(s)).toBe('');
    expect(column('Other eligibility')(s)).toBe('');
    expect(column('Study mode')(s)).toBe('');
  });

  it('renders both formats with one row per scholarship', () => {
    const rows = [fixture(), fixture({ _id: '64b000000000000000000002', title: 'Second' })];
    const csv = renderScholarshipExport(rows, 'csv').toString('utf8').trimEnd().split('\r\n');
    expect(csv).toHaveLength(3);
    const sheet = unzip(renderScholarshipExport(rows, 'xlsx')).get('xl/worksheets/sheet1.xml')!;
    expect(sheet.match(/<row /g)).toHaveLength(3);
  });
});

describe('sortForApplying', () => {
  it('puts the soonest deadline first and undated scholarships last', () => {
    const rolling = fixture({ title: 'Rolling', deadline: { kind: 'ROLLING', date: null } });
    const late = fixture({ title: 'Late', deadline: { date: new Date('2027-06-01') } });
    const soon = fixture({ title: 'Soon', deadline: { date: new Date('2026-11-01') } });
    expect(sortForApplying([rolling, late, soon]).map((s) => s.title)).toEqual(['Soon', 'Late', 'Rolling']);
  });
});

describe('buildScholarshipFilter', () => {
  it('turns comma lists into $in filters and ignores invalid university ids', () => {
    expect(buildScholarshipFilter({
      status: 'OPEN,CLOSING_SOON', country: 'ke,gb', degree: 'masters', university: 'not-an-id'
    })).toEqual({
      status: { $in: ['OPEN', 'CLOSING_SOON'] },
      countryCode: { $in: ['KE', 'GB'] },
      degreeLevels: { $in: ['MASTERS'] }
    });
  });
});
