import mongoose from 'mongoose';

const CsfloatKeySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, unique: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    cipher: { type: String, required: true },
  },
  { timestamps: true },
);

export const CsfloatKey = mongoose.model('PatCsfloatKey', CsfloatKeySchema, 'pat_csfloat_keys');
