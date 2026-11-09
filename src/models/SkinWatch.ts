import mongoose from 'mongoose';

const SkinWatchSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    name: { type: String, required: true, maxlength: 120 },
    wear: { type: String, default: '', maxlength: 40 },
    label: { type: String, required: true, maxlength: 120 },
    image: { type: String, default: null },
    paintIndex: { type: Number, default: null },
    wears: { type: [String], default: [] },
    lastBestEur: { type: Number, default: null },
    lastCheckedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

SkinWatchSchema.index({ userId: 1, name: 1, wear: 1 }, { unique: true });

export const SkinWatch = mongoose.model('PatSkinWatch', SkinWatchSchema, 'pat_skin_watches');
