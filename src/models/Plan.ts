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
    image: { type: String, default: '', maxlength: 500 },
  },
  { _id: true },
);

const PlanSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: ['patrimonio', 'liquidez', 'inversion', 'gastos'], default: 'patrimonio' },
    joinCode: { type: String, unique: true, sparse: true },
    members: {
      type: [
        new mongoose.Schema(
          {
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatUser', required: true },
            name: { type: String, required: true, maxlength: 80 },
            color: { type: String, required: true, maxlength: 16 },
            contributed: { type: Number, default: 0 },
            pocket: { type: Number, default: 0 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    tripExpenses: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, required: true, maxlength: 80 },
            amount: { type: Number, required: true },
            paidBy: { type: mongoose.Schema.Types.ObjectId, required: true },
            paidByName: { type: String, default: '', maxlength: 80 },
            category: { type: String, default: '', maxlength: 24 },
            counts: { type: Boolean, default: true },
            splitAmong: { type: [{ type: mongoose.Schema.Types.ObjectId }], default: [] },
            date: { type: String, required: true },
            receipt: { type: String, default: '', maxlength: 500000 },
            charge: { type: String, enum: ['none', 'pending', 'done'], default: 'none' },
            chargeAccountId: { type: mongoose.Schema.Types.ObjectId, default: null },
            chargeMovementId: { type: String, default: '', maxlength: 32 },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    tripStatus: { type: String, enum: ['active', 'settling', 'done'], default: 'active' },
    tripClosedAt: { type: Date, default: null },
    settlements: {
      type: [
        new mongoose.Schema(
          {
            fromId: { type: mongoose.Schema.Types.ObjectId, required: true },
            toId: { type: mongoose.Schema.Types.ObjectId, required: true },
            amount: { type: Number, required: true },
            status: { type: String, enum: ['pending', 'awaiting_confirmation', 'confirmed', 'disputed'], default: 'pending' },
            openedAt: { type: Date, default: Date.now },
            statusAt: { type: Date, default: Date.now },
            paymentReportedAt: { type: Date, default: null },
            confirmedAt: { type: Date, default: null },
            reminded24: { type: Boolean, default: false },
            reminded72: { type: Boolean, default: false },
            events: {
              type: [
                new mongoose.Schema(
                  {
                    at: { type: Date, default: Date.now },
                    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
                    action: { type: String, enum: ['created', 'reported', 'confirmed', 'disputed'], required: true },
                    note: { type: String, default: '', maxlength: 160 },
                  },
                  { _id: false },
                ),
              ],
              default: [],
            },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
    tripActivity: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            title: { type: String, required: true, maxlength: 120 },
            body: { type: String, required: true, maxlength: 240 },
            kind: { type: String, default: 'note', maxlength: 40 },
            settlementId: { type: mongoose.Schema.Types.ObjectId, default: null },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
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
    cashMoves: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, required: true },
            movementId: { type: String, required: true },
            amount: { type: Number, required: true },
            date: { type: String, required: true },
            direction: { type: String, enum: ['in', 'out'], required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    manualRealBalance: { type: Number, default: null },
    recurring: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, required: true, maxlength: 80 },
            amount: { type: Number, required: true },
            dayOfMonth: { type: Number, required: true },
            direction: { type: String, enum: ['in', 'out'], default: 'out' },
            paidDates: { type: [String], default: [] },
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
            paidDates: { type: [String], default: [] },
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
    /** Compras por tandas de un plan de inversión. Sin fecha, la tanda espera a un aviso del mercado. */
    buys: {
      type: [
        new mongoose.Schema(
          {
            asset: { type: String, required: true, maxlength: 40 },
            amount: { type: Number, required: true },
            date: { type: String, default: '' },
            done: { type: Boolean, default: false },
            doneAt: { type: String, default: '' },
            priceEur: { type: Number, default: null },
            /** Marcada a mano con el botón; lo demás sale de las compras de Movimientos. */
            manual: { type: Boolean, default: false },
            manualAt: { type: String, default: '' },
            manualPrice: { type: Number, default: null },
            movementIds: { type: [String], default: [] },
            spent: { type: Number, default: 0 },
            quantity: { type: Number, default: 0 },
          },
          { _id: true },
        ),
      ],
      default: undefined,
    },
    watch: {
      type: new mongoose.Schema(
        {
          dropPct: { type: Number, default: 5 },
          risePct: { type: Number, default: 8 },
          ratioAbove: { type: Number, default: null },
          zones: {
            type: [new mongoose.Schema({ asset: { type: String, required: true }, belowEur: { type: Number, required: true } }, { _id: false })],
            default: [],
          },
          refs: {
            type: [new mongoose.Schema({ asset: { type: String, required: true }, priceEur: { type: Number, required: true }, at: { type: String, required: true }, source: { type: String, default: '' } }, { _id: false })],
            default: [],
          },
          fired: { type: [String], default: [] },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

export const Plan = mongoose.model('PatPlan', PlanSchema, 'pat_plans');
