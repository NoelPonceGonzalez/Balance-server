import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(currentDir, '..', '..', '.env') });
dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

function requiredSecret(name: string, devFallback: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (isProduction) {
    throw new Error(`Falta ${name}. Defínela en server/.env antes de arrancar en producción.`);
  }
  console.warn(`⚠️  ${name} no está definida: se usa un valor solo para desarrollo local.`);
  return devFallback;
}

export const config = {
  port: parseInt(process.env.PORT || '3010', 10),
  nodeEnv,
  jwtSecret: requiredSecret('JWT_SECRET', 'dev-only-patrimonio-secret'),
  mongodbUri: process.env.MONGODB_URI?.trim() || 'mongodb://127.0.0.1:27017/patrimonio',
};

export function getCorsAllowedOrigins(): string[] {
  const extra = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const local = [
    'http://localhost:3010',
    'http://127.0.0.1:3010',
    'http://localhost:5181',
    'http://127.0.0.1:5181',
  ];
  return [...new Set([...extra, ...(config.nodeEnv === 'production' ? [] : local)])];
}

export function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (getCorsAllowedOrigins().includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname;
    return host === 'balance-client.vercel.app' || /^balance-client(?:-[a-z0-9-]+)?\.vercel\.app$/.test(host);
  } catch {
    return false;
  }
}
