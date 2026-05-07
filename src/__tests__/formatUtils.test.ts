import { describe, it, expect } from 'vitest';
import { decode as toonDecode } from '@toon-format/toon';
import {
  convertToCSV,
  convertToToon,
  formatErrorResponse,
  formatSuccessResponse,
  formatToonResponse,
} from '../utils/formatUtils.js';

describe('convertToCSV', () => {
  it('returns empty string for empty array', () => {
    expect(convertToCSV([])).toBe('');
  });

  // I15 fix: null/non-object first element
  it('returns empty string when first element is null', () => {
    expect(convertToCSV([null as any])).toBe('');
  });

  it('returns empty string when first element is a primitive', () => {
    expect(convertToCSV([42 as any])).toBe('');
  });

  it('returns empty string when first element is undefined', () => {
    expect(convertToCSV([undefined as any])).toBe('');
  });

  it('converts simple objects to CSV', () => {
    const data = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ];
    const csv = convertToCSV(data);
    expect(csv).toBe('name,age\n"Alice",30\n"Bob",25\n');
  });

  it('handles strings with commas', () => {
    const data = [{ value: 'hello, world' }];
    const csv = convertToCSV(data);
    expect(csv).toBe('value\n"hello, world"\n');
  });

  it('handles strings with double quotes', () => {
    const data = [{ value: 'say "hello"' }];
    const csv = convertToCSV(data);
    expect(csv).toBe('value\n"say ""hello"""\n');
  });

  it('handles null and undefined values', () => {
    const data = [{ a: null, b: undefined, c: 'ok' }];
    const csv = convertToCSV(data);
    expect(csv).toBe('a,b,c\n,,"ok"\n');
  });

  it('handles single row', () => {
    const data = [{ id: 1 }];
    const csv = convertToCSV(data);
    expect(csv).toBe('id\n1\n');
  });
});

describe('formatErrorResponse', () => {
  it('formats Error object', () => {
    const result = formatErrorResponse(new Error('test error'));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('test error');
  });

  it('formats string error', () => {
    const result = formatErrorResponse('string error');
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('string error');
  });
});

describe('formatSuccessResponse', () => {
  it('formats data as JSON', () => {
    const data = { foo: 'bar' };
    const result = formatSuccessResponse(data);
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(data);
  });

  it('formats arrays', () => {
    const data = [1, 2, 3];
    const result = formatSuccessResponse(data);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([1, 2, 3]);
  });
});

describe('convertToToon', () => {
  it('round-trips uniform row arrays', () => {
    const rows = [
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false },
    ];
    const toon = convertToToon(rows);
    expect(toonDecode(toon)).toEqual(rows);
  });

  it('emits a tabular block for uniform arrays of objects', () => {
    const toon = convertToToon([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
    // Tabular header: [N]{cols}: ... rows ...
    expect(toon).toMatch(/\[2\]\{id,name\}:/);
  });

  it('saves tokens vs JSON.stringify(..., null, 2) on uniform rows', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      name: `Row ${i + 1}`,
      score: i * 1.5,
    }));
    const json = JSON.stringify(rows, null, 2);
    const toon = convertToToon(rows);
    expect(toon.length).toBeLessThan(json.length);
  });

  it('coerces Date to ISO string', () => {
    const d = new Date('2026-01-15T10:30:00.000Z');
    const toon = convertToToon([{ when: d }]);
    expect(toonDecode(toon)).toEqual([{ when: '2026-01-15T10:30:00.000Z' }]);
  });

  it('coerces bigint to string', () => {
    const toon = convertToToon([{ big: 12345678901234567890n }]);
    expect(toonDecode(toon)).toEqual([{ big: '12345678901234567890' }]);
  });

  it('coerces Buffer to base64 string', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    const toon = convertToToon([{ blob: buf }]);
    expect(toonDecode(toon)).toEqual([{ blob: 'AQID/w==' }]);
  });

  it('coerces undefined to null', () => {
    const toon = convertToToon([{ a: 1, b: undefined }]);
    expect(toonDecode(toon)).toEqual([{ a: 1, b: null }]);
  });

  it('breaks reference cycles without throwing', () => {
    const cyclic: any = { name: 'parent' };
    cyclic.self = cyclic;
    expect(() => convertToToon(cyclic)).not.toThrow();
  });
});

describe('formatToonResponse', () => {
  it('returns a non-error MCP content envelope', () => {
    const result = formatToonResponse([{ id: 1 }]);
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(toonDecode(result.content[0].text)).toEqual([{ id: 1 }]);
  });
});
