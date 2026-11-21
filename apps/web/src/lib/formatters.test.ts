import { describe, it, expect } from 'vitest';
import { formatMoney, formatQuantity, formatNumber, toNumber } from './formatters';

describe('formatters — توحيد تنسيق الأرقام والعملات (بند 11)', () => {
  describe('formatMoney', () => {
    it('formats positive integers with 2 fraction digits and Arabic grouping and decimal separators', () => {
      const result = formatMoney(22575);
      expect(result).toBe('٢٢٬٥٧٥٫٠٠ ج.م');
    });

    it('formats fractions correctly with ٫ decimal separator', () => {
      expect(formatMoney(15000.5)).toBe('١٥٬٠٠٠٫٥٠ ج.م');
      expect(formatMoney(97.25)).toBe('٩٧٫٢٥ ج.م');
    });

    it('formats negative numbers cleanly with negative sign without RTL flip', () => {
      expect(formatMoney(-100000)).toBe('− ١٠٠٬٠٠٠٫٠٠ ج.م');
      expect(formatMoney(-15.5)).toBe('− ١٥٫٥٠ ج.م');
    });

    it('formats zero and negative zero consistently without negative sign or dashes', () => {
      expect(formatMoney(0)).toBe('٠٫٠٠ ج.م');
      expect(formatMoney(-0)).toBe('٠٫٠٠ ج.م');
      expect(formatMoney(0.0)).toBe('٠٫٠٠ ج.م');
    });

    it('handles null, undefined, empty string, and NaN safely', () => {
      expect(formatMoney(null)).toBe('٠٫٠٠ ج.م');
      expect(formatMoney(undefined)).toBe('٠٫٠٠ ج.م');
      expect(formatMoney('')).toBe('٠٫٠٠ ج.م');
      expect(formatMoney(NaN)).toBe('٠٫٠٠ ج.م');
    });

    it('parses string numbers and Eastern Arabic numerals properly', () => {
      expect(formatMoney('25000')).toBe('٢٥٬٠٠٠٫٠٠ ج.م');
      expect(formatMoney('-500')).toBe('− ٥٠٠٫٠٠ ج.م');
    });
  });

  describe('formatQuantity', () => {
    it('formats integer quantities cleanly without trailing decimal zeroes', () => {
      expect(formatQuantity(50)).toBe('٥٠');
      expect(formatQuantity(1000)).toBe('١٬٠٠٠');
    });

    it('formats fractional quantities up to specified decimals', () => {
      expect(formatQuantity(97.5)).toBe('٩٧٫٥');
      expect(formatQuantity(97.125, 3)).toBe('٩٧٫١٢٥');
    });

    it('formats negative quantities with minus sign', () => {
      expect(formatQuantity(-3)).toBe('− ٣');
    });

    it('formats zero safely', () => {
      expect(formatQuantity(0)).toBe('٠');
      expect(formatQuantity(-0)).toBe('٠');
    });
  });

  describe('formatNumber', () => {
    it('formats numbers with Arabic grouping and decimal separators', () => {
      expect(formatNumber(12345.67)).toBe('١٢٬٣٤٥٫٦٧');
    });
  });

  describe('toNumber', () => {
    it('converts numbers, strings, and Arabic-Indic numerals', () => {
      expect(toNumber(123)).toBe(123);
      expect(toNumber('123.45')).toBe(123.45);
      expect(toNumber('١٢٣٫٤٥')).toBe(123.45);
      expect(toNumber(null)).toBe(0);
      expect(toNumber(undefined)).toBe(0);
    });
  });
});
