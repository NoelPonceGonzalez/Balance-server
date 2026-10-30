/** Variación del valor en euros de una moneda. Positivo: está por encima del cierre anterior. */
export function currencyMove(perEurToday: number, perEurBefore: number): number | null {
  if (!(perEurToday > 0) || !(perEurBefore > 0)) return null;
  const now = 1 / perEurToday;
  const then = 1 / perEurBefore;
  return ((now - then) / then) * 100;
}

export function previousWeekday(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));
  do {
    date.setUTCDate(date.getUTCDate() - 1);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}
