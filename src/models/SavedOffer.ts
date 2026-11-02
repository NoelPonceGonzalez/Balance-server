import mongoose from 'mongoose';

const SavedOfferSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    listingKey: { type: String, required: true },
    label: { type: String, required: true },
    priceEur: { type: Number, default: null },
    floatValue: { type: Number, default: null },
    image: { type: String, default: null },
    url: { type: String, required: true },
  },
  { timestamps: true },
);

SavedOfferSchema.index({ userId: 1, listingKey: 1 }, { unique: true });

export const SavedOffer = mongoose.model('PatSavedOffer', SavedOfferSchema, 'pat_saved_offers');
