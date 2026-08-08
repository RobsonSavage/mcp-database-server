import { describe, it, expect } from 'vitest';
import { validateReadQuery, validateWriteQuery } from '../tools/queryTools.js';

/**
 * Tests for the shared query validation logic exercised by
 * read_query / write_query / export_query. Imports the real validators so the
 * tests can't drift from the implementation.
 */

describe('readQuery validation', () => {
  it('accepts simple SELECT', () => {
    expect(() => validateReadQuery('SELECT * FROM users')).not.toThrow();
  });

  it('accepts SELECT with leading whitespace', () => {
    expect(() => validateReadQuery('  SELECT 1')).not.toThrow();
  });

  it('accepts CTE queries (WITH)', () => {
    expect(() => validateReadQuery('WITH cte AS (SELECT 1) SELECT * FROM cte')).not.toThrow();
  });

  it('accepts SELECT with leading block comment', () => {
    expect(() => validateReadQuery('/* comment */ SELECT 1')).not.toThrow();
  });

  it('accepts SELECT with a single trailing semicolon', () => {
    expect(() => validateReadQuery('SELECT * FROM users;')).not.toThrow();
  });

  it('rejects non-SELECT queries', () => {
    expect(() => validateReadQuery('DELETE FROM users')).toThrow('Only SELECT');
  });

  it('rejects INSERT', () => {
    expect(() => validateReadQuery('INSERT INTO users VALUES (1)')).toThrow('Only SELECT');
  });

  // I9 fix: reject multiple statements (semicolon injection)
  it('rejects queries with semicolons', () => {
    expect(() => validateReadQuery('SELECT 1; DROP TABLE users')).toThrow('Multiple statements');
  });

  it('rejects SELECT followed by semicolon and DROP', () => {
    expect(() => validateReadQuery('SELECT 1; DELETE FROM users')).toThrow('Multiple statements');
  });

  it('rejects piggyback even with a trailing semicolon', () => {
    expect(() => validateReadQuery('SELECT 1; DROP TABLE users;')).toThrow('Multiple statements');
  });

  // Edge case: block comment hiding malicious query
  it('rejects comment-hidden DELETE', () => {
    expect(() => validateReadQuery('/* SELECT */ DELETE FROM users')).toThrow('Only SELECT');
  });
});

describe('writeQuery validation', () => {
  it('accepts INSERT', () => {
    expect(() => validateWriteQuery('INSERT INTO users VALUES (1)')).not.toThrow();
  });

  it('accepts UPDATE', () => {
    expect(() => validateWriteQuery('UPDATE users SET name = \'x\'')).not.toThrow();
  });

  it('accepts DELETE', () => {
    expect(() => validateWriteQuery('DELETE FROM users WHERE id = 1')).not.toThrow();
  });

  it('rejects SELECT', () => {
    expect(() => validateWriteQuery('SELECT * FROM users')).toThrow('read_query');
  });

  it('rejects CREATE TABLE', () => {
    expect(() => validateWriteQuery('CREATE TABLE foo (id INT)')).toThrow('Only INSERT');
  });

  it('rejects DROP TABLE', () => {
    expect(() => validateWriteQuery('DROP TABLE users')).toThrow('Only INSERT');
  });

  it('accepts semicolon-separated DML statements', () => {
    expect(() => validateWriteQuery('UPDATE users SET x=1; DELETE FROM users WHERE inactive=1;')).not.toThrow();
  });

  it('does not split semicolons inside strings or comments', () => {
    expect(() => validateWriteQuery("UPDATE users SET name='a;b'; /* keep ; */ DELETE FROM users WHERE inactive=1;"))
      .not.toThrow();
  });

  it('rejects DDL piggyback in a multi-statement batch', () => {
    expect(() => validateWriteQuery('UPDATE users SET x=1; DROP TABLE users')).toThrow('Only INSERT');
  });

  it('accepts UPDATE with a single trailing semicolon', () => {
    expect(() => validateWriteQuery('UPDATE users SET name = \'x\';')).not.toThrow();
  });

  it('accepts PRINT interleaved with DML', () => {
    expect(() => validateWriteQuery("PRINT 'archiving'; DELETE FROM users WHERE inactive=1; PRINT 'done';"))
      .not.toThrow();
  });

  it('still rejects DDL piggybacked behind a PRINT', () => {
    expect(() => validateWriteQuery("PRINT 'x'; DROP TABLE users")).toThrow('Only INSERT');
  });
});
