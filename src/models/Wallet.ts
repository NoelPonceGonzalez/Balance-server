import mongoose from 'mongoose';

const EntrySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    amount: { type: Number, required: true },
    date: { type: String, required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    origin: { type: String, default: '', maxlength: 80 },
    image: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true },
);

const WalletSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatAccount', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    openingBalance: { type: Number, default: 0 },
    entries: { type: [EntrySchema], default: [] },
  },
  { timestamps: true },
);

WalletSchema.index({ userId: 1, accountId: 1 }, { unique: true });

export const Wallet = mongoose.model('PatWallet', WalletSchema, 'pat_wallets');
