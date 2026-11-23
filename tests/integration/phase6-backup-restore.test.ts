import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { runBackupDrill } from '../../scripts/backup-drill.js';

config({path:'.env'});
describe('Phase 6 encrypted recovery drill', () => {
  let volumePath='';
  afterAll(async()=>{if(volumePath)await rm(volumePath,{recursive:true,force:true});});
  it('c5_backup_restore_drill_meets_recovery_objectives', async () => {
    volumePath=await mkdtemp(join(tmpdir(),'si-backup-contract-'));
    const adminUrl=process.env.DATABASE_URL_ADMIN??`postgresql://${process.env.USER??process.env.LOGNAME}@127.0.0.1:5432/postgres`;
    const result=await runBackupDrill({encryptionKey:randomBytes(32).toString('base64'),volumePath,adminUrl});
    expect(result.rows).toBe(3);
    expect(result.rpoSeconds).toBeLessThanOrEqual(900);
    expect(result.rtoSeconds).toBeLessThan(14_400);
  });
});
