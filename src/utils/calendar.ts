/**
 * Pure calendar grid utilities — no React or React Native dependencies.
 */

/**
 * Format year, 0-based month, and day into "YYYY-MM-DD".
 */
export function fmtYMD(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Parse a "YYYY-MM-DD" string into { year, month (0-based), day }.
 */
export function parseYMD(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { year: y, month: m - 1, day: d };
}

/**
 * Get today's date as "YYYY-MM-DD".
 */
export function todayStr(): string {
  const d = new Date();
  return fmtYMD(d.getFullYear(), d.getMonth(), d.getDate());
}

export interface CalendarCell {
  day: number;
  dateStr: string;
}

/**
 * Build the grid of day cells for a given month.
 * Returns an array of rows, where each row has 7 cells.
 * Each cell is either null (empty) or { day, dateStr }.
 *
 * @param year - Full year (e.g. 2026)
 * @param month - 0-based month (0 = January)
 */
export function buildCalendarGrid(
  year: number,
  month: number,
): Array<Array<CalendarCell | null>> {
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: Array<CalendarCell | null> = [];

  // Leading blanks
  for (let i = 0; i < firstDay; i++) {
    cells.push(null);
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, dateStr: fmtYMD(year, month, d) });
  }

  // Pad to complete last row
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  // Split into rows of 7
  const rows: Array<Array<CalendarCell | null>> = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7));
  }

  return rows;
}
