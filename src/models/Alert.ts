import mongoose from 'mongoose';

const AlertSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    quoteKey: { type: String, required: true },
    thresholdPct: { type: Number, default: 3 },
    bandArmed: { type: Boolean, default: true },
    above: { type: Number, default: null },
    aboveArmed: { type: Boolean, default: true },
    below: { type: Number, default: null },
    belowArmed: { type: Boolean, default: true },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

AlertSchema.index({ userId: 1, quoteKey: 1 }, { unique: true });

export const Alert = mongoose.model('PatAlert', AlertSchema, 'pat_alerts');
