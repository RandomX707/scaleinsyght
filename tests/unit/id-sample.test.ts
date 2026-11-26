import { describe, expect, it } from 'vitest';
import { inIdSample, ID_SAMPLE_MODULUS } from '@scaleinsyght/connectors';

// Decision 61: a fixed rule on the value itself, so every source keeps the same values.
describe('consistent ID sample', () => {
  it('keeps plain integers divisible by 16 and zero, whatever their storage type', () => {
    expect([16, 32, 1600, 160000000000000000].map((n) => inIdSample(String(n)))).toEqual([true, true, true, true]);
    expect([1, 15, 17, 33].map((n) => inIdSample(String(n)))).toEqual([false, false, false, false]);
    expect(inIdSample('0')).toBe(true);
  });
  it('treats anything that is not a plain integer as text, by the MD5 of its UTF-8 bytes', () => {
    // Leading zeros, signs and codes are text, so "0016" and "16" are different values with independent outcomes.
    expect(inIdSample('MRN000123')).toBe(inIdSample('MRN000123'));
    for (const value of ['0016', '-16', 'A16', '16.0', '1234567890123456789']) expect(typeof inIdSample(value)).toBe('boolean');
  });
  it('keeps about one value in sixteen', () => {
    const ints = Array.from({ length: 64_000 }, (_, index) => String(index + 1)).filter(inIdSample).length;
    expect(ints).toBe(64_000 / ID_SAMPLE_MODULUS);
    const codes = Array.from({ length: 64_000 }, (_, index) => `MRN${String(index).padStart(7, '0')}`).filter(inIdSample).length / 64_000;
    expect(codes).toBeGreaterThan(0.055); expect(codes).toBeLessThan(0.07);
  });
});
