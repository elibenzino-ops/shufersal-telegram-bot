import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import type { ShufersalSellingMethodCode } from '../shufersal/types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatCurrency(amount: number): string {
  return `₪${amount.toFixed(2)}`;
}

export function formatQuantity(
  qty: number,
  sellingMethod?: ShufersalSellingMethodCode | string,
): string {
  const cleanQty = Number.isInteger(qty) ? String(qty) : qty.toFixed(2).replace(/\.?0+$/, '');
  if (sellingMethod === 'BY_WEIGHT') {
    return `${cleanQty} ק"ג`;
  }
  if (sellingMethod === 'BY_PACKAGE') {
    return `${cleanQty} מארזים`;
  }
  return `${cleanQty} יח'`;
}

export function formatHebrewDateTime(
  isoDateTime: string,
  endHourString?: string | null,
): string {
  const dt = dayjs(isoDateTime).tz('Asia/Jerusalem');
  if (!dt.isValid()) return isoDateTime;
  const dayName = HEBREW_DAYS[dt.day()] ?? '';
  const datePart = dt.format('DD/MM');
  const startPart = dt.format('HH:mm');
  if (endHourString) {
    return `יום ${dayName} ${datePart} (${startPart}–${endHourString})`;
  }
  return `יום ${dayName} ${datePart} בשעה ${startPart}`;
}

export function formatHebrewDayHeader(isoDateTime: string): {
  dateKey: string;
  label: string;
} {
  const dt = dayjs(isoDateTime).tz('Asia/Jerusalem');
  const dayName = HEBREW_DAYS[dt.day()] ?? '';
  return {
    dateKey: dt.format('YYYY-MM-DD'),
    label: `יום ${dayName} (${dt.format('DD/MM')})`,
  };
}

export function normalizeHebrewQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/["'״׳]/g, '')
    .replace(/\s+/g, ' ');
}

export function normalizeIsraeliPhone(raw: string): string | null {
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+972')) {
    digits = digits.slice(4);
  } else if (digits.startsWith('00972')) {
    digits = digits.slice(5);
  } else if (digits.startsWith('972') && digits.length >= 11) {
    digits = digits.slice(3);
  }
  digits = digits.replace(/\D/g, '');
  if (/^5\d{8}$/.test(digits)) {
    digits = `0${digits}`;
  }
  if (/^05\d{8}$/.test(digits)) {
    return digits;
  }
  return null;
}
