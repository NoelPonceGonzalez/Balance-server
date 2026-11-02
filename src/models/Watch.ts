import mongoose from 'mongoose';

const WatchSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    marketHashName: { type: String, required: true },
    label: { type: String, required: true },
    below: { type: Number, required: true },
    belowArmed: { type: Boolean, default: true },
    lastPriceEur: { type: Number, default: null },
    lastSoldAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    place: { type: String, default: '' },
    seenIds: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

WatchSchema.index({ userId: 1, marketHashName: 1 }, { unique: true });

export const Watch = mongoose.model('PatWatch', WatchSchema, 'pat_watches');
