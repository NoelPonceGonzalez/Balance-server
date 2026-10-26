import mongoose from 'mongoose';

const MovementSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    type: {
      type: String,
      enum: ['income', 'expense', 'buy', 'sell', 'fee', 'transfer', 'deposit', 'withdrawal', 'reward', 'adjustment'],
      required: true,
    },
    date: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true, uppercase: true, trim: true },
    eurPerUnit: { type: Number, default: null },
    category: { type: String, default: '', maxlength: 80 },
    description: { type: String, default: '', maxlength: 500 },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatAccount', required: true },
    counterAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatAccount', default: null },
    holdingId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatHolding', default: null },
    quantity: { type: Number, default: null },
    direction: { type: String, enum: ['in', 'out'], required: false },
    fee: { type: Number, default: null },
    applyToBalances: { type: Boolean, default: true },
    fingerprint: { type: String, default: '' },
    source: { type: String, default: 'manual' },
    effects: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

MovementSchema.index({ userId: 1, date: -1 });

export const Movement = mongoose.model('PatMovement', MovementSchema, 'pat_movements');
