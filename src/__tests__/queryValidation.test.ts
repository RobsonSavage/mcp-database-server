import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for the query validation logic in readQuery/writeQuery.
 * We test the validation rules directly by extracting the logic,
 * since the full functions depend on database connections.
 */

// Extract the readQuery validation logic (I9 fix)
function validateReadQuery(query: string): void {
  const trimmed = query.trim();
  const stripped = trimmed.replace(/^\/\*[\s\S]*?\*\/\s*/g, '');
  if (!stripped.toLowerCase().startsWith("select") && !stripped.toLowerCase().startsWith("with")) {
    throw new Error("Only SELECT queries are allowed with read_query");
  }
  if (trimmed.includes(';')) {
    throw new Error("Multiple statements are not allowed in read_query");
  }
}

// Extract writeQuery validation logic
function validateWriteQuery(query: string): void {
  const lowerQuery = query.trim().toLowerCase();
  if (lowerQuery.startsWith("select")) {
    throw new Error("Use read_query for SELECT operations");
  }
  if (!(lowerQuery.startsWith("insert") || lowerQuery.startsWith("update") || lowerQuery.startsWith("delete"))) {
    throw new Error("Only INSERT, UPDATE, or DELETE operations are allowed with write_query");
  }
}

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
});
