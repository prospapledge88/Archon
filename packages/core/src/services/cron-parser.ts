/**
 * Lightweight 5-field cron expression parser and matcher.
 *
 * Fields: minute hour day-of-month month day-of-week
 * Supports: literals, wildcards, ranges, steps, lists.
 * No extended syntax (seconds, named days/months).
 */

type FieldMatcher = (value: number) => boolean;

/** Parse a single cron field into a matcher function. */
export function parseCronField(field: string, min: number, max: number): FieldMatcher {
  // Wildcard
  if (field === '*') return () => true;

  // List (must check before range/step since lists can contain ranges)
  if (field.includes(',')) {
    const matchers = field.split(',').map(part => parseCronField(part.trim(), min, max));
    return (value: number) => matchers.some(m => m(value));
  }

  // Step (*/N or range/N)
  if (field.includes('/')) {
    const [base, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) throw new Error(`Invalid cron step: ${field}`);

    if (base === '*') {
      return (value: number) => value % step === 0;
    }
    // Range with step
    const rangeMatcher = parseRange(base, min, max);
    return (value: number) => {
      if (!rangeMatcher.inRange(value)) return false;
      return (value - rangeMatcher.start) % step === 0;
    };
  }

  // Range (N-M)
  if (field.includes('-')) {
    const range = parseRange(field, min, max);
    return (value: number) => value >= range.start && value <= range.end;
  }

  // Literal
  const num = parseInt(field, 10);
  if (isNaN(num) || num < min || num > max) {
    throw new Error(`Invalid cron field value: ${field} (expected ${String(min)}-${String(max)})`);
  }
  return (value: number) => value === num;
}

function parseRange(
  field: string,
  min: number,
  max: number
): { start: number; end: number; inRange: (v: number) => boolean } {
  const [startStr, endStr] = field.split('-');
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);
  if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
    throw new Error(`Invalid cron range: ${field} (expected ${String(min)}-${String(max)})`);
  }
  return {
    start,
    end,
    inRange: (v: number) => v >= start && v <= end,
  };
}

/**
 * Check if a cron expression matches a given date.
 * @param expression - 5-field cron expression (minute hour dom month dow)
 * @param date - The date to check against
 * @returns true if the expression matches the date
 */
export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${String(fields.length)}`);
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const minute = parseCronField(minuteField, 0, 59);
  const hour = parseCronField(hourField, 0, 23);
  const dom = parseCronField(domField, 1, 31);
  const month = parseCronField(monthField, 1, 12);
  const dow = parseCronField(dowField, 0, 6);

  return (
    minute(date.getUTCMinutes()) &&
    hour(date.getUTCHours()) &&
    dom(date.getUTCDate()) &&
    month(date.getUTCMonth() + 1) &&
    dow(date.getUTCDay())
  );
}
