import mongoose from 'mongoose';

const TrackedListingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    listingId: { type: String, required: true },
    marketHashName: { type: String, required: true },
    label: { type: String, required: true },
    image: { type: String, default: null },
    floatValue: { type: Number, default: null },
    paintSeed: { type: Number, default: null },
    firstPriceEur: { type: Number, default: null },
    priceEur: { type: Number, default: null },
    priceCents: { type: Number, default: null },
    state: { type: String, enum: ['listed', 'sold', 'gone'], default: 'listed' },
    endedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

TrackedListingSchema.index({ userId: 1, listingId: 1 }, { unique: true });

export const TrackedListing = mongoose.model('PatTrackedListing', TrackedListingSchema, 'pat_tracked_listings');
