import mongoose from 'mongoose';

const moneyEvent = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    amount: { type: Number, required: true },
    date: { type: String, required: true },
    status: { type: String, enum: ['expected', 'confirmed'], default: 'confirmed' },
    paid: { type: Boolean, default: false },
    surprise: { type: Boolean, default: false },
    automatic: { type: Boolean, default: false },
  },
  { _id: true },
);

const PlanSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: ['patrimonio', 'liquidez', 'inversion'], default: 'patrimonio' },
    field: { type: String, default: '', maxlength: 40 },
    salary: { type: Number, default: 0 },
    salaryAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatAccount', default: null },
    savingsDay: { type: Number, default: null },
    openingBalance: { type: Number, required: true },
    startDate: { type: String, required: true },
    targetAmount: { type: Number, required: true },
    targetDate: { type: String, required: true },
    monthlySavings: { type: Number, required: true },
    savingsPaid: { type: [String], default: [] },
    surpriseCleared: { type: [String], default: [] },
    savingsSkipped: { type: [String], default: [] },
    settled: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, required: true },
            done: { type: Boolean, required: true },
            amount: { type: Number, default: 0 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    savingsAdjustments: {
      type: [
        new mongoose.Schema(
          {
            date: { type: String, required: true },
            amount: { type: Number, required: true },
            name: { type: String, default: '', maxlength: 80 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    linkedAccountIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'PatAccount' }],
    manualRealBalance: { type: Number, default: null },
    recurring: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, required: true, maxlength: 80 },
            amount: { type: Number, required: true },
            dayOfMonth: { type: Number, required: true },
            direction: { type: String, enum: ['in', 'out'], default: 'out' },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    intervals: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, required: true, maxlength: 80 },
            amount: { type: Number, required: true },
            everyWeeks: { type: Number, required: true },
            startDate: { type: String, required: true },
            direction: { type: String, enum: ['in', 'out'], default: 'out' },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    plannedExpenses: { type: [moneyEvent], default: [] },
    incomes: { type: [moneyEvent], default: [] },
    scenarios: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, required: true, maxlength: 80 },
            monthlySavings: { type: Number, required: true },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export const Plan = mongoose.model('PatPlan', PlanSchema, 'pat_plans');
