import { assertNoSecret, type AccountKind, type AssetClass, type MovementType, type Tracking } from './domain/finance.js';
import { HttpError } from './http.js';

const KINDS: AccountKind[] = ['bank', 'cash', 'broker', 'exchange', 'wallet', 'other'];
const TRACKING: Tracking[] = ['balance', 'positions'];
const CLASSES: AssetClass[] = ['crypto', 'stock', 'etf', 'personal_good', 'other'];
const TYPES: MovementType[] = ['income', 'expense', 'buy', 'sell', 'fee', 'transfer', 'deposit', 'withdrawal', 'reward', 'adjustment'];

export function asText(value: unknown, field: string, max: number, required = true): string {
  if (value == null || value === '') {
    if (!required) return '';
    throw new HttpError(400, `${field} es obligatorio.`);
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} no es válido.`);
  const text = value.trim();
  if (!text && required) throw new HttpError(400, `${field} es obligatorio.`);
  if (text.length > max) throw new HttpError(400, `${field} es demasiado largo.`);
  const secret = assertNoSecret(text);
  if (secret) throw new HttpError(400, secret);
  return text;
}

export function asMoney(value: unknown, field: string, allowZero = false): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new HttpError(400, `${field} tiene que ser un número.`);
  if (allowZero ? number < 0 : number <= 0) throw new HttpError(400, allowZero ? `${field} no puede ser negativo.` : `${field} tiene que ser mayor que cero.`);
  return number;
}

export function asOptionalMoney(value: unknown, field: string): number | null {
  if (value == null || value === '') return null;
  return asMoney(value, field, true);
}

export function asPicture(value: unknown): string {
  if (value == null || value === '') return '';
  const text = asText(value, 'La imagen', 500, false);
  if (!text) return '';
  if (text.startsWith('/brands/') || text.startsWith('/platforms/') || text.startsWith('/extras/') || text.startsWith('https://')) return text;
  throw new HttpError(400, 'La imagen no es válida.');
}

export function asDay(value: unknown, field: string): string {
  const text = asText(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, `${field} tiene que ser una fecha.`);
  return text;
}

export function asCurrency(value: unknown): string {
  const code = asText(value, 'La moneda', 8).toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(code)) throw new HttpError(400, 'La moneda tiene que ser un código como EUR o USD.');
  return code;
}

export function asTicker(value: unknown): string {
  const code = asText(value, 'La moneda', 15).toUpperCase();
  if (!/^[A-Z0-9]{1,15}$/.test(code)) throw new HttpError(400, 'La moneda tiene que ser un código como EUR o BTC.');
  return code;
}

export function asKind(value: unknown): AccountKind {
  if (!KINDS.includes(value as AccountKind)) throw new HttpError(400, 'El tipo de cuenta no es válido.');
  return value as AccountKind;
}

export function asTracking(value: unknown): Tracking {
  if (!TRACKING.includes(value as Tracking)) throw new HttpError(400, 'El modo de seguimiento no es válido.');
  return value as Tracking;
}

export function asClass(value: unknown): AssetClass {
  if (!CLASSES.includes(value as AssetClass)) throw new HttpError(400, 'El tipo de activo no es válido.');
  return value as AssetClass;
}

export function asType(value: unknown): MovementType {
  if (!TYPES.includes(value as MovementType)) throw new HttpError(400, 'El tipo de movimiento no es válido.');
  return value as MovementType;
}

export function asRate(value: unknown, currency: string): number | null {
  if (currency === 'EUR') return null;
  const rate = asMoney(value, 'El tipo de cambio a euros');
  return rate;
}

export function asId(value: unknown, field: string, required = true): string | null {
  if (value == null || value === '') {
    if (!required) return null;
    throw new HttpError(400, `${field} es obligatorio.`);
  }
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) throw new HttpError(400, `${field} no es válido.`);
  return value;
}
