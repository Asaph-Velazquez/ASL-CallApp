import mongoose from 'mongoose';

const interpreterReportSchema = new mongoose.Schema(
  {
    reportId: { type: String, required: true, unique: true, index: true },
    callId: { type: String, required: true, index: true },
    stayId: { type: String, default: null },
    roomNumber: { type: String, required: true },
    guestName: { type: String, required: true },
    interpreterId: { type: String, required: true },
    interpreterName: { type: String, required: true },
    summary: { type: String, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], required: true },
    category: { type: String, required: true },
    followUpRequired: { type: Boolean, default: true },
    notes: { type: String, default: '' },
    submittedAt: { type: Date, default: () => new Date() }
  },
  { timestamps: true, versionKey: false }
);

const InterpreterReport = mongoose.model('InterpreterReport', interpreterReportSchema);
export { InterpreterReport };
