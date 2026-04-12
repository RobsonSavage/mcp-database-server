import { describe, it, expect } from 'vitest';
import { assertSafeIdentifier } from '../db/adapter.js';

describe('assertSafeIdentifier', () => {
  // Valid simple identifiers
  it.each([
    'Users',
    'table_name',
    '_private',
    'A',
    'a1b2c3',
    'UPPER_CASE_123',
  ])('accepts valid simple identifier: %s', (name) => {
    expect(assertSafeIdentifier(name)).toBe(name);
  });

  // Valid schema-qualified identifiers (C7 fix)
  it.each([
    'dbo.Users',
    'schema.table_name',
    '_sys._internal',
    'HumanResources.Employee',
  ])('accepts valid schema-qualified identifier: %s', (name) => {
    expect(assertSafeIdentifier(name)).toBe(name);
  });

  // Invalid: injection characters
  it.each([
    "Robert'; DROP TABLE Students;--",
    'table"name',
    'table`name',
    'table[name]',
    'table name',
    'table\tname',
    '',
    '123starts_with_number',
    '.leadingdot',
    'trailing.',
    'a.b.c',        // more than one dot
    'a..b',         // consecutive dots
    '-hyphenated',
    'name-with-dash',
  ])('rejects invalid identifier: %s', (name) => {
    expect(() => assertSafeIdentifier(name, 'test')).toThrow('Invalid test');
  });

  // Non-string inputs
  it('rejects null', () => {
    expect(() => assertSafeIdentifier(null as any)).toThrow();
  });

  it('rejects undefined', () => {
    expect(() => assertSafeIdentifier(undefined as any)).toThrow();
  });

  it('rejects number', () => {
    expect(() => assertSafeIdentifier(42 as any)).toThrow();
  });

  // Custom label in error message
  it('uses custom label in error message', () => {
    expect(() => assertSafeIdentifier('bad;name', 'table name')).toThrow('Invalid table name');
  });

  // Default label
  it('uses default label when none provided', () => {
    expect(() => assertSafeIdentifier('bad;name')).toThrow('Invalid identifier');
  });
});
