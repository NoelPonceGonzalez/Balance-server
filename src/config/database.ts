import dns from 'dns';
import mongoose from 'mongoose';
import { config } from './env.js';

const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];
const RETRY_DELAYS_MS = [3000, 5000, 10000, 20000, 30000];

let connecting = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let dnsFallbackApplied = false;
let everConnected = false;
let fatal = false;

function isSrvDnsFailure(error: unknown): boolean {
  const e = error as { syscall?: string; code?: string } | null;
  if (!e) return false;
  return e.syscall === 'querySrv' || e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN';
}

function applyPublicDnsFallback(): boolean {
  if (dnsFallbackApplied) return false;
  dnsFallbackApplied = true;
  try {
    dns.setServers(PUBLIC_DNS);
    console.warn(`⚠️  El DNS no resuelve el registro SRV de MongoDB. Reintentando con ${PUBLIC_DNS.join(' y ')}…`);
    return true;
  } catch {
    return false;
  }
}

function preemptPublicDnsIfLoopback(): void {
  if (!config.mongodbUri.startsWith('mongodb+srv://')) return;
  try {
    const servers = dns.getServers();
    const allLoopback = servers.length > 0 && servers.every((s) => s.startsWith('127.') || s === '::1' || s.startsWith('[::1]'));
    if (!allLoopback) return;
    dnsFallbackApplied = true;
    dns.setServers(PUBLIC_DNS);
    console.warn(`⚠️  El DNS local no resuelve SRV. Se usará ${PUBLIC_DNS.join(' y ')}.`);
  } catch {
    /* el reintento lo cubre */
  }
}

async function attemptConnection(): Promise<void> {
  if (fatal || connecting || mongoose.connection.readyState === 1) return;
  connecting = true;
  try {
    await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 8000 });
    if (mongoose.connection.name === 'powerlifting') {
      fatal = true;
      await mongoose.disconnect();
      console.error('❌ Esta aplicación no puede usar la base de datos de Powerlifting. En MONGODB_URI la base tiene que llamarse patrimonio.');
      return;
    }
    attempt = 0;
    everConnected = true;
    console.log(`✅ MongoDB conectado. Base de datos: ${mongoose.connection.name}`);
  } catch (error) {
    if (isSrvDnsFailure(error) && !dnsFallbackApplied && applyPublicDnsFallback()) {
      connecting = false;
      return attemptConnection();
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    attempt += 1;
    const message = error instanceof Error ? error.message : String(error);
    if (attempt === 1) console.error(`❌ MongoDB: ${message}`);
    else console.log(`   MongoDB sin conexión (intento ${attempt}); siguiente en ${Math.round(delay / 1000)} s`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      connecting = false;
      void attemptConnection();
    }, delay);
    (retryTimer as { unref?: () => void }).unref?.();
  } finally {
    connecting = false;
  }
}

export const connectDB = async (): Promise<void> => {
  if (!process.env.MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI no está en server/.env. Se intenta la base local patrimonio.');
  }
  preemptPublicDnsIfLoopback();
  mongoose.connection.on('disconnected', () => {
    if (everConnected && !fatal) console.warn('⚠️  MongoDB desconectado. Reintentando…');
  });
  mongoose.connection.on('reconnected', () => console.log('✅ MongoDB reconectado'));
  await attemptConnection();
};

export const isDbConnected = (): boolean => mongoose.connection.readyState === 1 && !fatal;
