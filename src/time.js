import { DateTime } from 'luxon';

export const BERLIN_TZ = 'Europe/Berlin';

export function parseWeekStartBerlin(weekStart) {
  const dt = DateTime.fromISO(weekStart, { zone: BERLIN_TZ }).startOf('day');
  if (!dt.isValid) {
    throw new Error(`Invalid --week-start value: ${weekStart}`);
  }
  return dt;
}

export function buildWeekRanges(weekStart) {
  const currentStartBerlin = parseWeekStartBerlin(weekStart);
  const currentEndBerlin = currentStartBerlin.plus({ days: 7 });
  const prevStartBerlin = currentStartBerlin.minus({ days: 7 });
  const prevEndBerlin = currentStartBerlin;

  return {
    current: {
      startBerlin: currentStartBerlin,
      endBerlin: currentEndBerlin,
      startUtcIso: currentStartBerlin.toUTC().toISO(),
      endUtcIso: currentEndBerlin.toUTC().toISO()
    },
    previous: {
      startBerlin: prevStartBerlin,
      endBerlin: prevEndBerlin,
      startUtcIso: prevStartBerlin.toUTC().toISO(),
      endUtcIso: prevEndBerlin.toUTC().toISO()
    }
  };
}

export function parsePlayedAt(raw, timezone = BERLIN_TZ, now = DateTime.now().setZone(timezone)) {
  const value = (raw ?? '').trim();
  if (!value) return null;

  const formats = [
    'yyyy-LL-dd HH:mm',
    'dd.LL.yyyy HH:mm',
    'dd.LL.yy HH:mm',
    'HH:mm'
  ];

  for (const fmt of formats) {
    let dt = DateTime.fromFormat(value, fmt, { zone: timezone, locale: 'de' });
    if (!dt.isValid) continue;

    if (fmt === 'HH:mm') {
      dt = now.set({ hour: dt.hour, minute: dt.minute, second: 0, millisecond: 0 });
      if (dt > now.plus({ hours: 2 })) {
        dt = dt.minus({ days: 1 });
      }
    }

    return dt.toUTC().toJSDate();
  }

  const iso = DateTime.fromISO(value, { zone: timezone });
  if (iso.isValid) return iso.toUTC().toJSDate();

  return null;
}

export function isoUtcNow() {
  return DateTime.utc().toISO();
}

export function berlinTodayIso() {
  return DateTime.now().setZone(BERLIN_TZ).toISODate();
}

export function buildDayRangeBerlin(dateBerlinIso) {
  const startBerlin = DateTime.fromISO(dateBerlinIso, { zone: BERLIN_TZ }).startOf('day');
  if (!startBerlin.isValid) {
    throw new Error(`Invalid Berlin date: ${dateBerlinIso}`);
  }
  const endBerlin = startBerlin.plus({ days: 1 });
  return {
    startBerlin,
    endBerlin,
    startUtcIso: startBerlin.toUTC().toISO(),
    endUtcIso: endBerlin.toUTC().toISO()
  };
}
