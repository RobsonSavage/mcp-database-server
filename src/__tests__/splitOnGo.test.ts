import { describe, it, expect } from 'vitest';
import { splitOnGo } from '../tools/queryTools.js';

/**
 * Tests for the SQL Server GO batch splitter. The splitter must be comment- and
 * string-aware: a `GO` on its own line inside a block comment, line comment, or
 * multi-line string literal is NOT a batch separator.
 */

const sqls = (q: string) => splitOnGo(q).map(b => b.sql);

describe('splitOnGo', () => {
  it('splits two batches on a bare GO', () => {
    expect(sqls('CREATE TABLE a (id int)\nGO\nCREATE TABLE b (id int)'))
      .toEqual(['CREATE TABLE a (id int)', 'CREATE TABLE b (id int)']);
  });

  it('drops empty batches', () => {
    expect(splitOnGo('GO\nGO\nSELECT 1\nGO')).toEqual([{ sql: 'SELECT 1', repeat: 1 }]);
  });

  it('parses a GO repeat count', () => {
    expect(splitOnGo('INSERT INTO t DEFAULT VALUES\nGO 5'))
      .toEqual([{ sql: 'INSERT INTO t DEFAULT VALUES', repeat: 5 }]);
  });

  it('allows a trailing line comment after GO', () => {
    expect(sqls('SELECT 1\nGO -- next batch\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  // The reported bug: GO inside a /* ... */ block (e.g. a rollback block).
  it('does NOT split on GO inside a block comment', () => {
    const q = 'CREATE TABLE a (id int)\n/* rollback:\nGO\nDROP TABLE a\n*/';
    expect(splitOnGo(q)).toHaveLength(1);
  });

  it('still splits on a real GO that follows a block comment containing GO', () => {
    const q = 'CREATE TABLE a (id int)\n/*\nGO\n*/\nGO\nCREATE TABLE b (id int)';
    expect(sqls(q)).toEqual([
      'CREATE TABLE a (id int)\n/*\nGO\n*/',
      'CREATE TABLE b (id int)',
    ]);
  });

  it('handles nested block comments (T-SQL allows nesting)', () => {
    const q = 'SELECT 1\n/* outer /* inner\nGO\n*/ still in outer\nGO\n*/\nGO\nSELECT 2';
    expect(sqls(q)).toEqual([
      'SELECT 1\n/* outer /* inner\nGO\n*/ still in outer\nGO\n*/',
      'SELECT 2',
    ]);
  });

  it('does NOT split on GO inside a multi-line string literal', () => {
    const q = "INSERT INTO log VALUES ('line1\nGO\nline2')";
    expect(splitOnGo(q)).toHaveLength(1);
  });

  it('does NOT split on GO inside a line comment that spans to EOL only', () => {
    // -- comment ends at newline; the following GO IS a real separator
    const q = 'SELECT 1 -- trailing GO here\nGO\nSELECT 2';
    expect(sqls(q)).toEqual(['SELECT 1 -- trailing GO here', 'SELECT 2']);
  });
});
