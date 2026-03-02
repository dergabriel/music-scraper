const BERLIN_TIMEZONE = 'Europe/Berlin';

const PARTS_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  timeZone: BERLIN_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function partsFor(date) {
  const map = new Map();
  PARTS_FORMATTER.formatToParts(date).forEach((part) => {
    if (part.type !== 'literal') map.set(part.type, part.value);
  });
  return {
    year: map.get('year'),
    month: map.get('month'),
    day: map.get('day')
  };
}

function parseIsoDate(isoDate) {
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export function berlinIsoDate(date = new Date()) {
  const { year, month, day } = partsFor(date);
  return `${year}-${month}-${day}`;
}

export function berlinTodayIsoDate() {
  return berlinIsoDate(new Date());
}

export function berlinYesterdayIsoDate() {
  return shiftBerlinIsoDate(berlinTodayIsoDate(), -1);
}

export function shiftBerlinIsoDate(isoDate, days) {
  const base = parseIsoDate(isoDate);
  if (!base) return isoDate;
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return berlinIsoDate(base);
}

export function berlinYear(date = new Date()) {
  return Number(partsFor(date).year);
}

export function weekStartBerlinIso(date = new Date()) {
  const currentIso = berlinIsoDate(date);
  const berlinDate = parseIsoDate(currentIso);
  if (!berlinDate) return currentIso;
  const weekday = (berlinDate.getUTCDay() + 6) % 7;
  berlinDate.setUTCDate(berlinDate.getUTCDate() - weekday);
  return berlinIsoDate(berlinDate);
}

export function clampIsoDate(value, fallback) {
  return parseIsoDate(value) ? String(value) : fallback;
}

