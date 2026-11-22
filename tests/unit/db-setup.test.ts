import { describe, expect, it } from 'vitest';
import { buildDatabaseUrl, quoteIdentifier, quoteLiteral } from '../../scripts/db-setup.js';

describe('native PostgreSQL setup SQL helpers', () => {
  it('quotes role identifiers as SQL identifiers', () => {
    expect(quoteIdentifier('si_app')).toBe('"si_app"');
    expect(quoteIdentifier('bad"role')).toBe('"bad""role"');
  });

  it('quotes generated passwords as SQL literals', () => {
    expect(quoteLiteral("local'pword")).toBe("'local''pword'");
  });

  it('builds a role URL without exposing special password characters', () => {
    expect(buildDatabaseUrl('si_app', 'secret:@/word', 'scale_insyght', 5432)).toBe(
      'postgresql://si_app:secret%3A%40%2Fword@127.0.0.1:5432/scale_insyght',
    );
  });
});
