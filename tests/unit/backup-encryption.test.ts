import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup } from '../../scripts/backup-drill.js';

describe('encrypted backup envelope', () => {
  it('round trips authenticated encrypted bytes', () => {
    const key=Buffer.alloc(32,7);const plain=Buffer.from('synthetic-only-database-dump');
    expect(decryptBackup(encryptBackup(plain,key),key)).toEqual(plain);
  });

  it('rejects tampering and the wrong key', () => {
    const key=Buffer.alloc(32,7);const blob=encryptBackup(Buffer.from('synthetic'),key);blob[blob.length-1]^=1;
    expect(()=>decryptBackup(blob,key)).toThrow('backup_authentication_failed');
    expect(()=>decryptBackup(encryptBackup(Buffer.from('synthetic'),key),Buffer.alloc(32,8))).toThrow('backup_authentication_failed');
  });
});
