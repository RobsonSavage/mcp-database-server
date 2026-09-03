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
    db.dbExec.mockResolvedValue({ messages: [], resultSets: [] });
  });

  afterEach(() => {
    if (savedAllowDdl === undefined) delete process.env.ALLOW_DDL;
    else process.env.ALLOW_DDL = savedAllowDdl;
  });

  it('returns PRINT output collected across GO batches', async () => {
    db.dbExec
      .mockResolvedValueOnce({ messages: ['creating proc'], resultSets: [] })
      .mockResolvedValueOnce({ messages: ['granting exec', 'done'], resultSets: [] });

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

  it('returns result sets produced by the script SELECTs, across batches', async () => {
    db.dbExec
      .mockResolvedValueOnce({ messages: [], resultSets: [[{ count: 3 }]] })
      .mockResolvedValueOnce({ messages: [], resultSets: [[{ ok: 1 }, { ok: 2 }]] });

    const result: any = await executeDdl(
      'BEGIN TRAN\nINSERT INTO dbo.t VALUES (1), (2), (3)\nSELECT COUNT(*) AS count FROM dbo.t\nROLLBACK\nGO\nSELECT 1 AS ok'
    );

    expect(payload(result)).toEqual({
      success: true,
      message: 'DDL executed (2 batches)',
      result_sets: [[{ count: 3 }], [{ ok: 1 }, { ok: 2 }]],
    });
  });

  it('returns messages and result sets from the same batch together', async () => {
    db.dbExec.mockResolvedValue({
      messages: ['step'],
      resultSets: [[{ v: 42 }]],
    });

    const result: any = await executeDdl("PRINT 'step'; SELECT 42 AS v");

    expect(payload(result)).toEqual({
      success: true,
      message: 'DDL executed (1 batch)',
      messages: ['step'],
      result_sets: [[{ v: 42 }]],
    });
  });

  it('flattens result sets across GO N repeats', async () => {
    db.dbExec.mockResolvedValue({ messages: [], resultSets: [[{ i: 1 }]] });

    const result: any = await executeDdl('SELECT 1 AS i\nGO 3');

    expect(payload(result)).toEqual({
      success: true,
      message: 'DDL executed (3 batches)',
      result_sets: [[{ i: 1 }], [{ i: 1 }], [{ i: 1 }]],
    });
  });

  it('reports messages from completed batches when a later batch fails', async () => {
    db.dbExec
      .mockResolvedValueOnce({ messages: ['step 1 ok'], resultSets: [] })
      .mockRejectedValueOnce(new Error('SQL Server batch error: Invalid object name'));

    await expect(executeDdl('PRINT 1\nGO\nSELECT * FROM dbo.missing'))
      .rejects.toThrow(/Messages from completed batches:\nstep 1 ok/);
  });
});
