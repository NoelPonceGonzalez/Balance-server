import mongoose from 'mongoose';

const PushSubSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    endpoint: { type: String, required: true },
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  { timestamps: true },
);

PushSubSchema.index({ endpoint: 1 }, { unique: true });

export const PushSub = mongoose.model('PatPushSub', PushSubSchema, 'pat_push_subs');
