import mongoose from 'mongoose';

const QuoteSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    source: { type: String, enum: ['coingecko', 'yahoo'], required: true },
    externalId: { type: String, required: true },
    symbol: { type: String, required: true },
    name: { type: String, required: true },
    image: { type: String, default: null },
    nativePrice: { type: Number, required: true },
    nativeCurrency: { type: String, required: true },
    priceEur: { type: Number, required: true },
    changePct: { type: Number, default: null },
    changeLabel: { type: String, enum: ['24 h', 'sesión'], required: true },
    sparkline: { type: [Number], default: [] },
    fetchedAt: { type: Date, required: true },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

export const Quote = mongoose.model('PatQuote', QuoteSchema, 'pat_quotes');
