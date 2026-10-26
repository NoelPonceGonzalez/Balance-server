import mongoose from 'mongoose';

const HoldingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatAccount', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    symbol: { type: String, default: '', trim: true, maxlength: 20 },
    assetClass: { type: String, enum: ['crypto', 'stock', 'etf', 'personal_good', 'other'], required: true },
    currency: { type: String, required: true, uppercase: true, trim: true, maxlength: 8 },
    quantity: { type: Number, required: true },
    unitMarketValue: { type: Number, default: null },
    valuedAt: { type: Date, default: null },
    priceSource: { type: String, enum: ['manual', 'market'], default: 'manual' },
    followMarket: { type: Boolean, default: true },
    /** El importe guardado es el total de la posición, no el precio de una participación. */
    amountIsTotal: { type: Boolean, default: false },
    quoteKey: { type: String, default: null, index: true },
    quoteSource: { type: String, default: null },
    quoteId: { type: String, default: null },
    quoteCheckedSymbol: { type: String, default: '' },
    change24hPct: { type: Number, default: null },
    quoteImage: { type: String, default: null },
    costBasis: { type: Number, default: null },
    eurPerUnit: { type: Number, default: null },
    notes: { type: String, default: '', maxlength: 2000 },
    buys: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, required: true },
            spentEur: { type: Number, required: true },
            quantity: { type: Number, required: true },
            unitPriceEur: { type: Number, required: true },
            mode: { type: String, enum: ['market', 'manual'], required: true },
            grain: { type: String, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export const Holding = mongoose.model('PatHolding', HoldingSchema, 'pat_holdings');
