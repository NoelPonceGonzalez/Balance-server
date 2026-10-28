import mongoose from 'mongoose';

const AccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    platform: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: ['bank', 'cash', 'broker', 'exchange', 'wallet', 'other'], required: true },
    tracking: { type: String, enum: ['balance', 'positions'], required: true },
    currency: { type: String, required: true, uppercase: true, trim: true, maxlength: 8 },
    balance: { type: Number, required: true, default: 0 },
    eurPerUnit: { type: Number, default: null },
    notes: { type: String, default: '', maxlength: 2000 },
    publicAddress: { type: String, default: '', maxlength: 200 },
    archived: { type: Boolean, default: false },
    /** Apartados que la persona ha activado aunque aún estén vacíos. */
    sections: { type: [String], default: [] },
    balanceUpdatedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

export const Account = mongoose.model('PatAccount', AccountSchema, 'pat_accounts');
