import { currencyMove, previousWeekday } from '../domain/fx.js';

export interface FxCoin {
  code: string;
  name: string;
  perEur: number;
  changePct: number | null;
}

const COINS: { code: string; name: string }[] = [
  { code: 'EUR', name: 'Euro' },
  { code: 'USD', name: 'Dólar' },
  { code: 'GBP', name: 'Libra' },
  { code: 'CHF', name: 'Franco suizo' },
  { code: 'JPY', name: 'Yen' },
  { code: 'CNY', name: 'Yuan' },
  { code: 'CAD', name: 'Dólar canadiense' },
  { code: 'AUD', name: 'Dólar australiano' },
  { code: 'SEK', name: 'Corona sueca' },
  { code: 'NOK', name: 'Corona noruega' },
  { code: 'DKK', name: 'Corona danesa' },
  { code: 'PLN', name: 'Esloti' },
  { code: 'CZK', name: 'Corona checa' },
  { code: 'HUF', name: 'Forinto' },
  { code: 'TRY', name: 'Lira' },
  { code: 'MXN', name: 'Peso mexicano' },
  { code: 'BRL', name: 'Real' },
];

let cached: { at: number; day: string; coins: FxCoin[] } | null = null;

async function ratesOn(day: string | 'latest'): Promise<{ date: string; rates: Record<string, number> } | null> {
  const path = day === 'latest' ? 'latest' : day;
  const response = await fetch(`https://api.frankfurter.app/${path}?from=EUR`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { date?: string; rates?: Record<string, number> };
  if (!data.date || !data.rates) return null;
  return { date: data.date, rates: data.rates };
}

export async function currencyBoard(): Promise<{ day: string; coins: FxCoin[] }> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return { day: cached.day, coins: cached.coins };
  const euro: FxCoin = { code: 'EUR', name: 'Euro', perEur: 1, changePct: 0 };
  try {
    const latest = await ratesOn('latest');
    if (!latest) return { day: '', coins: [euro] };
    const before = await ratesOn(previousWeekday(latest.date));
    const coins = COINS.flatMap((coin) => {
      if (coin.code === 'EUR') return [euro];
      const perEur = latest.rates[coin.code];
      if (!(perEur > 0)) return [];
      const prior = before?.rates[coin.code];
      return [{
        code: coin.code,
        name: coin.name,
        perEur,
        changePct: prior ? currencyMove(perEur, prior) : null,
      }];
    });
    cached = { at: Date.now(), day: latest.date, coins };
    return { day: latest.date, coins };
  } catch {
    return { day: '', coins: [euro] };
  }
}
