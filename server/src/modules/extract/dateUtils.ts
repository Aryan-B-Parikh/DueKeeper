/**
 * Date helpers for the extraction module.
 *
 * The zone-aware primitives moved to `lib/zonedTime` once the ICS importer and
 * the calendar sync needed them too — `lib` importing from a feature module
 * would have been the wrong direction. They are re-exported here so existing
 * call sites keep working and there is still only one implementation.
 */
export {
  tzOffsetMinutes,
  zonedToUtc,
  zonedToUtcIso,
  civilDateInZone,
  addCivilDays,
  isValidCivilDate,
  localDateKey,
  type ZonedConversion,
  type CivilDate
} from '../../lib/zonedTime';

export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

export function startOfDay(date: Date): Date {
  const result = new Date(date.getTime());
  result.setHours(0, 0, 0, 0);
  return result;
}
