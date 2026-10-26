import mongoose from 'mongoose';
import { connectDB, isDbConnected } from '../config/database.js';

await connectDB();
await new Promise((resolve) => setTimeout(resolve, 1500));
if (!isDbConnected()) {
  console.error('No hay conexión con MongoDB.');
  process.exit(1);
}
const collections = (await mongoose.connection.db?.listCollections().toArray()) ?? [];
console.log(`Base: ${mongoose.connection.name}`);
console.log(collections.map((item) => item.name).sort().join('\n') || '(sin colecciones todavía)');
await mongoose.disconnect();
