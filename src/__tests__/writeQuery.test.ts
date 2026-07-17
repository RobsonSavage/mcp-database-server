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
    db.dbRun.mockResolvedValue({ changes: 1 });
  });

  it('executes SQL Server GO batches separately', async () => {
    await writeQuery('UPDATE users SET active=1;\nGO\nDELETE FROM users WHERE inactive=1;');

    expect(db.dbRun).toHaveBeenCalledTimes(2);
    expect(db.dbRun).toHaveBeenNthCalledWith(1, 'UPDATE users SET active=1;', []);
    expect(db.dbRun).toHaveBeenNthCalledWith(2, 'DELETE FROM users WHERE inactive=1;', []);
  });

  it('validates every GO batch before executing any writes', async () => {
    await expect(writeQuery('UPDATE users SET active=1;\nGO\nDROP TABLE users;'))
      .rejects.toThrow('Only INSERT, UPDATE, or DELETE');

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
});
