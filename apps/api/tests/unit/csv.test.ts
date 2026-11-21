import { describe, expect, it } from 'vitest';
import { readCandidateCsv } from '../../src/batches/csv.js';

const header = 'candidate_reference,full_name,phone_e164,completion_reference';

describe('candidate CSV parsing', () => {
  it('reads UTF-8 BOM, CRLF, and quoted commas', () => {
    const file = Buffer.from('\uFEFF' + header + '\r\nX-1,"Asha Rao, Jr.",+12025550100,C-1\r\n');
    const result = readCandidateCsv(file);
    expect(result).toEqual({
      issues: [],
      rows: [{ row: 2, reference: 'X-1', fullName: 'Asha Rao, Jr.', phoneE164: '+12025550100', completionReference: 'C-1' }],
    });
  });

  it('reports physical row numbers after blank and multiline records', () => {
    const file = Buffer.from(header + '\nX-1,"Asha\nRao",+12025550100,C-1\n\nX-2,Sameer Iyer,missing,C-2\n');
    const result = readCandidateCsv(file);
    expect(result.issues).toEqual([
      expect.objectContaining({ row: 2, field: 'row' }),
      expect.objectContaining({ row: 2, field: 'full_name' }),
      expect.objectContaining({ row: 5, field: 'phone_e164' }),
    ]);
    expect(result.rows.map(({ row }) => row)).toEqual([2, 5]);
  });

  it('keeps finding field errors on rows with missing or extra columns', () => {
    const result = readCandidateCsv(Buffer.from(header + '\nX-1,Bad Name\nX-2,Well Named,+12025550100,C-2,extra'));
    expect(result.issues.map(({ row, field }) => [row, field])).toEqual([
      [2, 'phone_e164'], [2, 'completion_reference'], [3, 'row'],
    ]);
  });

  it('bounds rows and rejects non-UTF-8 input', () => {
    const large = Buffer.from([header, ...Array<string>(1001).fill('X-1,Asha Rao,+12025550100,C-1')].join('\n'));
    expect(() => readCandidateCsv(large)).toThrow(expect.objectContaining({ code: 'TOO_MANY_ROWS', status: 413 }));
    expect(() => readCandidateCsv(Buffer.from([0xC3, 0x28]))).toThrow(expect.objectContaining({ code: 'INVALID_CSV', status: 400 }));
  });
});
