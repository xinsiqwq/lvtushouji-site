/** Calendar dates are labels in the source timezone, never browser-local instants. */
export function localDay(value: string | null | undefined): string {
  const day = value?.slice(0, 10) ?? '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return '';
  const [, y, m, d] = match;
  const year = Number(y),
    month = Number(m),
    date = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && date >= 1 && date <= days[month - 1] ? day : '';
}

export function formatDay(value: string | null | undefined, sep = '.'): string {
  return localDay(value).replaceAll('-', sep);
}

export function formatRange(start: string | null | undefined, end: string | null | undefined): string {
  return [formatDay(start), formatDay(end)].filter(Boolean).join(' — ');
}

/** exifr must supply unrevived strings; Date objects have already lost timezone provenance. */
export function exifTakenAt(value: unknown, offset?: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = `${year}-${month}-${day}`;
  if (!localDay(date) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  let suffix = '';
  if (offset !== undefined && offset !== null && offset !== '') {
    if (typeof offset !== 'string' || !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset.trim())) return null;
    suffix = offset.trim();
    if (suffix.slice(1, 3) === '14' && !suffix.endsWith(':00')) return null;
  }
  return `${date}T${hour}:${minute}:${second}${suffix}`;
}
