import mongoose from 'mongoose';

const PLACES = ['objeto', 'cs2', 'tf2', 'steam', 'ledger', 'trezor', 'tangem', 'safepal', 'onekey', 'otro'] as const;

const ExtraSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    place: { type: String, enum: PLACES, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    valueEur: { type: Number, required: true },
    costEur: { type: Number, default: null },
    notes: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true },
);

export const EXTRA_PLACES = PLACES;
export const Extra = mongoose.model('PatExtra', ExtraSchema, 'pat_extras');
