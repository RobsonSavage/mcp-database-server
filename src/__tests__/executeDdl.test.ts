import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  dbAll: vi.fn(),
  dbRun: vi.fn(),
  dbExec: vi.fn(),
  isMultiConnectionMode: vi.fn(),
  getResolvedConnection: vi.fn(),
  getDbType: vi.fn(),
}));

vi.mock('../db/index.js', () => db);

import { executeDdl } from '../tools/queryTools.js';

const payload = (res: any) => JSON.parse(res.content[0].text);

describe('executeDdl message reporting', () => {
  const savedAllowDdl = process.env.ALLOW_DDL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ALLOW_DDL = 'true';
    db.getDbType.mockReturnValue('sqlserver');
    db.isMultiConnectionMode.mockReturnValue(false);
    db.dbExec.mockResolvedValue({ messages: [] });
  });

  afterEach(() => {
    if (savedAllowDdl === undefined) delete process.env.ALLOW_DDL;
    else process.env.ALLOW_DDL = savedAllowDdl;
  });

  it('returns PRINT output collected across GO batches', async () => {
    db.dbExec
      .mockResolvedValueOnce({ messages: ['creating proc'] })
      .mockResolvedValueOnce({ messages: ['granting exec', 'done'] });

    const result: any = await executeDdl('CREATE PROC dbo.p AS SELECT 1\nGO\nGRANT EXEC ON dbo.p TO app');

    expect(payload(result)).toEqual({
      success: true,
      message: 'DDL executed (2 batches)',
      messages: ['creating proc', 'granting exec', 'done'],
    });
  });

  it('omits the messages key when the script printed nothing', async () => {
    const result: any = await executeDdl('CREATE TABLE dbo.t (id int)');

    expect(payload(result)).toEqual({ success: true, message: 'DDL executed (1 batch)' });
  });

  it('reports messages from completed batches when a later batch fails', async () => {
    db.dbExec
      .mockResolvedValueOnce({ messages: ['step 1 ok'] })
      .mockRejectedValueOnce(new Error('SQL Server batch error: Invalid object name'));

    await expect(executeDdl('PRINT 1\nGO\nSELECT * FROM dbo.missing'))
      .rejects.toThrow(/Messages from completed batches:\nstep 1 ok/);
  });
});
