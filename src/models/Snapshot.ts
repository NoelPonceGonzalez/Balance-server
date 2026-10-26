import mongoose from 'mongoose';

const SnapshotSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true },
    day: { type: String, required: true },
    valuedEur: { type: Number, required: true },
    netWorthEur: { type: Number, default: null },
    complete: { type: Boolean, required: true },
    availableEur: { type: Number, required: true },
    investedEur: { type: Number, required: true },
    cryptoEur: { type: Number, required: true },
  },
  { timestamps: true },
);

SnapshotSchema.index({ userId: 1, day: 1 }, { unique: true });

export const Snapshot = mongoose.model('PatSnapshot', SnapshotSchema, 'pat_snapshots');
