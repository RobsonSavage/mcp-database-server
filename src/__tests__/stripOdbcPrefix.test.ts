import { describe, expect, it } from 'vitest';
import { stripOdbcPrefix } from '../db/sqlserver-adapter.js';

describe('stripOdbcPrefix', () => {
  it('strips the msnodesqlv8 ODBC diagnostic prefix', () => {
    expect(stripOdbcPrefix('[Microsoft][ODBC Driver 18 for SQL Server][SQL Server]hello from batch 1'))
      .toBe('hello from batch 1');
  });

  it('strips the legacy Native Client prefix', () => {
    expect(stripOdbcPrefix('[Microsoft][SQL Server Native Client 11.0][SQL Server]done'))
      .toBe('done');
  });

  it('leaves a Tedious message untouched', () => {
    expect(stripOdbcPrefix('hello from batch 1')).toBe('hello from batch 1');
  });

  it('keeps brackets that belong to the printed text', () => {
    expect(stripOdbcPrefix('[step 1] migrating')).toBe('[step 1] migrating');
    expect(stripOdbcPrefix('[Microsoft][ODBC Driver 18 for SQL Server][SQL Server][step 1] migrating'))
      .toBe('[step 1] migrating');
  });
});
