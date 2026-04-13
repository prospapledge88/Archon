import { describe, test, expect } from 'bun:test';
import { parseCronField, matchesCron } from './cron-parser';

describe('parseCronField', () => {
  test('wildcard matches any value', () => {
    const matcher = parseCronField('*', 0, 59);
    expect(matcher(0)).toBe(true);
    expect(matcher(30)).toBe(true);
    expect(matcher(59)).toBe(true);
  });

  test('literal value matches exactly', () => {
    const matcher = parseCronField('5', 0, 59);
    expect(matcher(5)).toBe(true);
    expect(matcher(6)).toBe(false);
  });

  test('range matches inclusive bounds', () => {
    const matcher = parseCronField('1-5', 0, 59);
    expect(matcher(0)).toBe(false);
    expect(matcher(1)).toBe(true);
    expect(matcher(3)).toBe(true);
    expect(matcher(5)).toBe(true);
    expect(matcher(6)).toBe(false);
  });

  test('step on wildcard matches every N', () => {
    const matcher = parseCronField('*/15', 0, 59);
    expect(matcher(0)).toBe(true);
    expect(matcher(15)).toBe(true);
    expect(matcher(30)).toBe(true);
    expect(matcher(45)).toBe(true);
    expect(matcher(7)).toBe(false);
  });

  test('step on range matches every N within range', () => {
    const matcher = parseCronField('1-10/3', 0, 59);
    expect(matcher(1)).toBe(true);
    expect(matcher(4)).toBe(true);
    expect(matcher(7)).toBe(true);
    expect(matcher(10)).toBe(true);
    expect(matcher(2)).toBe(false);
    expect(matcher(0)).toBe(false);
  });

  test('list matches any listed value', () => {
    const matcher = parseCronField('1,3,5', 0, 59);
    expect(matcher(1)).toBe(true);
    expect(matcher(3)).toBe(true);
    expect(matcher(5)).toBe(true);
    expect(matcher(2)).toBe(false);
    expect(matcher(4)).toBe(false);
  });

  test('throws on invalid field', () => {
    expect(() => parseCronField('abc', 0, 59)).toThrow();
  });
});

describe('matchesCron', () => {
  test('every minute matches any date', () => {
    const date = new Date('2026-04-14T10:30:00Z');
    expect(matchesCron('* * * * *', date)).toBe(true);
  });

  test('specific minute matches only that minute', () => {
    const date30 = new Date('2026-04-14T10:30:00Z');
    const date31 = new Date('2026-04-14T10:31:00Z');
    expect(matchesCron('30 * * * *', date30)).toBe(true);
    expect(matchesCron('30 * * * *', date31)).toBe(false);
  });

  test('every 30 minutes', () => {
    const date0 = new Date('2026-04-14T10:00:00Z');
    const date15 = new Date('2026-04-14T10:15:00Z');
    const date30 = new Date('2026-04-14T10:30:00Z');
    expect(matchesCron('*/30 * * * *', date0)).toBe(true);
    expect(matchesCron('*/30 * * * *', date15)).toBe(false);
    expect(matchesCron('*/30 * * * *', date30)).toBe(true);
  });

  test('9 AM weekdays', () => {
    // 2026-04-14 is a Tuesday (dow=2)
    const tuesdayMorning = new Date('2026-04-14T09:00:00Z');
    const tuesdayAfternoon = new Date('2026-04-14T14:00:00Z');
    // 2026-04-18 is a Saturday (dow=6)
    const saturdayMorning = new Date('2026-04-18T09:00:00Z');
    expect(matchesCron('0 9 * * 1-5', tuesdayMorning)).toBe(true);
    expect(matchesCron('0 9 * * 1-5', tuesdayAfternoon)).toBe(false);
    expect(matchesCron('0 9 * * 1-5', saturdayMorning)).toBe(false);
  });

  test('specific day of month', () => {
    const first = new Date('2026-04-01T12:00:00Z');
    const second = new Date('2026-04-02T12:00:00Z');
    expect(matchesCron('0 12 1 * *', first)).toBe(true);
    expect(matchesCron('0 12 1 * *', second)).toBe(false);
  });

  test('throws on invalid expression (wrong field count)', () => {
    expect(() => matchesCron('* * *', new Date())).toThrow();
  });
});
