import { describe, expect, it } from 'vitest';
import { formatPattern } from '../../packages/profiler/src/id-agent.js';

describe('ID agent value formats (decision 47)', () => {
  it('sorts identifier values into coarse formats so only like-shaped fields are compared', () => {
    expect(formatPattern(['1', '22', '-3'])).toBe('integer');
    expect(formatPattern(['MRN-000123', 'MRN-000124'])).toBe('letters_digits_code');
    expect(formatPattern(['6f1c2a3e-1b2c-4d5e-8f90-123456789abc'])).toBe('uuid');
    expect(formatPattern(['A1', 'free text'])).toBe('text');
    expect(formatPattern([])).toBe('empty');
  });
});
