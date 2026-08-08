import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  dbAll: vi.fn(),
  dbRun: vi.fn(),
  dbExec: vi.fn(),
  isMultiConnectionMode: vi.fn(),
  getResolvedConnection: vi.fn(),
  getDbType: vi.fn(),
}));

vi.mock('../db/index.js', () => db);

import { writeQuery } from '../tools/queryTools.js';

describe('writeQuery execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.getDbType.mockReturnValue('sqlserver');
    db.dbRun.mockResolvedValue({ changes: 1, lastID: 0, messages: [] });
  });

  it('executes SQL Server GO batches separately', async () => {
    await writeQuery('UPDATE users SET active=1;\nGO\nDELETE FROM users WHERE inactive=1;');

    expect(db.dbRun).toHaveBeenCalledTimes(2);
    expect(db.dbRun).toHaveBeenNthCalledWith(1, 'UPDATE users SET active=1;', []);
    expect(db.dbRun).toHaveBeenNthCalledWith(2, 'DELETE FROM users WHERE inactive=1;', []);
  });

  it('validates every GO batch before executing any writes', async () => {
    await expect(writeQuery('UPDATE users SET active=1;\nGO\nDROP TABLE users;'))
      .rejects.toThrow('Only INSERT, UPDATE, DELETE, or PRINT');

    expect(db.dbRun).not.toHaveBeenCalled();
  });

  it('honours SQL Server GO repeat counts', async () => {
    await writeQuery('DELETE FROM audit_log WHERE expired=1\nGO 3');

    expect(db.dbRun).toHaveBeenCalledTimes(3);
  });

  it('rejects parameters across GO batches', async () => {
    await expect(writeQuery('UPDATE users SET active=?\nGO\nDELETE FROM users WHERE inactive=?', [true, true]))
      .rejects.toThrow('Parameterized write_query calls cannot contain GO separators');

    expect(db.dbRun).not.toHaveBeenCalled();
  });

  it('executes a batch whose statements are PRINT-annotated', async () => {
    db.dbRun.mockResolvedValue({ changes: 4, lastID: 0, messages: ['archiving', 'done'] });

    const result: any = await writeQuery("PRINT 'archiving'; DELETE FROM users WHERE inactive=1; PRINT 'done'");

    expect(db.dbRun).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toEqual({
      affected_rows: 4,
      messages: ['archiving', 'done'],
    });
  });

  it('returns server messages collected across GO batches', async () => {
    db.dbRun
      .mockResolvedValueOnce({ changes: 2, lastID: 0, messages: ['trigger: archived 2 rows'] })
      .mockResolvedValueOnce({ changes: 1, lastID: 0, messages: ['trigger: archived 1 row'] });

    const result: any = await writeQuery('UPDATE users SET active=1\nGO\nDELETE FROM users WHERE inactive=1');

    expect(JSON.parse(result.content[0].text)).toEqual({
      affected_rows: 3,
      messages: ['trigger: archived 2 rows', 'trigger: archived 1 row'],
    });
  });

  it('omits the messages key when the server printed nothing', async () => {
    const result: any = await writeQuery('UPDATE users SET active=1');

    expect(JSON.parse(result.content[0].text)).toEqual({ affected_rows: 1 });
  });

  it('reports messages from completed batches when a later batch fails', async () => {
    db.dbRun
      .mockResolvedValueOnce({ changes: 1, lastID: 0, messages: ['trigger: first batch ok'] })
      .mockRejectedValueOnce(new Error('SQL Server query error: deadlock victim'));

    await expect(writeQuery('UPDATE users SET active=1\nGO\nDELETE FROM users WHERE inactive=1'))
      .rejects.toThrow(/Messages from completed batches:\ntrigger: first batch ok/);
  });
});
