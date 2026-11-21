import { CsvError, parse } from 'csv-parse/sync';
import { HttpError, type FieldIssue } from '../http.js';

export const csvByteLimit = 512 * 1024;
const maxRows = 1000;
const columns = ['candidate_reference', 'full_name', 'phone_e164', 'completion_reference'] as const;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const phonePattern = /^\+[1-9][0-9]{1,14}$/;

type Column = (typeof columns)[number];

export interface CandidateRow {
  row: number;
  reference: string;
  fullName: string;
  phoneE164: string;
  completionReference: string;
}

interface ParsedRecord {
  row: number;
  record: string[];
  endLine: number;
}

export function isReference(value: string) {
  return referencePattern.test(value);
}

export function isCandidateName(value: string) {
  return value.length <= 120 && /\p{L}/u.test(value) && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

export function isCandidatePhone(value: string) {
  return phonePattern.test(value);
}

function readRecords(file: Buffer): ParsedRecord[] {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(file);
  } catch {
    throw new HttpError(400, 'INVALID_CSV', 'Save the candidate file as UTF-8 CSV and upload it again.');
  }

  const records: ParsedRecord[] = [];
  let nextRow = 1;
  try {
    parse(content, {
      relax_column_count: true,
      max_record_size: 4096,
      on_record(record, { lines }) {
        const row = nextRow;
        nextRow = lines + 1;
        if (row !== 1 && record.length === 1 && !record[0]?.trim()) return null;
        if (records.length === maxRows + 1) {
          throw new HttpError(413, 'TOO_MANY_ROWS', 'Import at most 1,000 candidates.');
        }
        records.push({ row, record, endLine: lines });
        return null;
      },
    });
    return records;
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    const message = error.code === 'CSV_MAX_RECORD_SIZE'
      ? 'Keep each CSV record under 4,096 characters.'
      : 'Check the commas and double quotes on this line.';
    throw new HttpError(400, 'INVALID_CSV', 'The CSV could not be read.', [
      { row: nextRow, field: 'row', message },
    ]);
  }
}

export function readCandidateCsv(file: Buffer) {
  const records = readRecords(file);
  const header = records[0]?.record;
  if (header?.length !== columns.length || columns.some((column, index) => header[index]?.trim() !== column)) {
    throw new HttpError(422, 'INVALID_IMPORT', 'Use the candidate CSV template.', [
      { row: 1, field: 'header', message: 'Use these columns in order: ' + columns.join(', ') + '.' },
    ]);
  }

  const entries = records.slice(1);
  if (entries.length === 0) throw new HttpError(422, 'EMPTY_IMPORT', 'Include at least one candidate row.');

  const rows: CandidateRow[] = [];
  const issues: FieldIssue[] = [];
  const seenCandidates = new Map<string, number>();
  const seenCompletions = new Map<string, number>();

  for (const { row, record, endLine } of entries) {
    const [reference = '', name = '', phoneE164 = '', completionReference = ''] = record.map((value) => value.trim());
    const fullName = name.normalize('NFC');

    function check(field: Column, value: string, valid: boolean, format: string) {
      if (!value || !valid) issues.push({ row, field, message: value ? format : 'This field is required.' });
    }

    function checkReference(field: 'candidate_reference' | 'completion_reference', value: string, seen: Map<string, number>) {
      const valid = isReference(value);
      check(field, value, valid, 'Use 1–64 letters, digits, periods, underscores, hyphens, or slashes, starting with a letter or digit.');
      if (!valid) return;
      const original = seen.get(value);
      if (original !== undefined) {
        issues.push({ row, field, message: 'This reference duplicates row ' + original + '.' });
      } else {
        seen.set(value, row);
      }
    }

    if (record.length > columns.length) {
      issues.push({ row, field: 'row', message: 'Expected four columns. Put double quotes around fields containing commas.' });
    }
    if (endLine !== row) {
      issues.push({ row, field: 'row', message: 'Keep each candidate on one line.' });
    }
    checkReference('candidate_reference', reference, seenCandidates);
    check('full_name', fullName, isCandidateName(fullName), 'Enter a name with letters, up to 120 characters, on one line.');
    check('phone_e164', phoneE164, isCandidatePhone(phoneE164), 'Enter an international number, such as +12025550100.');
    checkReference('completion_reference', completionReference, seenCompletions);

    rows.push({ row, reference, fullName, phoneE164, completionReference });
  }

  return { rows, issues };
}
