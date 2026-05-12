import { fmtYMD } from "./calendar";

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format a "YYYY-MM-DD" date string into a human-friendly label.
 *
 * - Today's date -> "Today"
 * - Yesterday's date -> "Yesterday"
 * - Otherwise -> "Apr 12" (short month + day, no leading zero)
 */
export function formatDateLabel(dateStr: string, now?: Date): string {
  const ref = now ?? new Date();

  if (dateStr === ymd(ref)) return "Today";

  const yesterday = new Date(ref);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === ymd(yesterday)) return "Yesterday";

  // Parse YYYY-MM-DD
  const [, mm, dd] = dateStr.split("-");
  const monthIndex = parseInt(mm, 10) - 1;
  const day = parseInt(dd, 10);
  return `${SHORT_MONTHS[monthIndex]} ${day}`;
}

function ymd(d: Date): string {
  return fmtYMD(d.getFullYear(), d.getMonth(), d.getDate());
}
