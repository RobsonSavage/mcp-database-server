import { describe, it, expect } from 'vitest';
import { convertToCSV, formatErrorResponse, formatSuccessResponse } from '../utils/formatUtils.js';

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
