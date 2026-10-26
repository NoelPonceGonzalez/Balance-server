import mongoose from 'mongoose';

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    quoteKey: { type: String, default: null },
    title: { type: String, required: true },
    body: { type: String, required: true },
    direction: { type: String, enum: ['up', 'down', 'due'], required: true },
    changePct: { type: Number, default: null },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

NotificationSchema.index({ userId: 1, createdAt: -1 });

export const Notification = mongoose.model('PatNotification', NotificationSchema, 'pat_notifications');
