import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: { type: String, unique: true, sparse: true, lowercase: true, trim: true, maxlength: 24 },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    timezone: { type: String, default: 'Europe/Madrid' },
    sessionVersion: { type: Number, default: 0 },
    lockHash: { type: String, select: false },
    lockTries: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    passkey: { type: Boolean, default: false },
    passkeys: {
      type: [{
        id: { type: String, required: true },
        publicKey: { type: String, required: true },
        counter: { type: Number, default: 0 },
        transports: { type: [String], default: [] },
      }],
      select: false,
      default: [],
    },
    passkeyChallenge: { type: String, select: false, default: '' },
    passkeyChallengeAt: { type: Date, select: false, default: null },
    resetCodeHash: { type: String },
    resetCodeExpires: { type: Date },
    resetCodeTries: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const User = mongoose.model('PatUser', UserSchema, 'pat_users');
