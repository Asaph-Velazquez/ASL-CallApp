import mongoose from 'mongoose';

const callSessionSchema = new mongoose.Schema(
  {
    callId: { type: String, required: true, unique: true, index: true },
    stayId: { type: String, default: null, index: true },
    roomNumber: { type: String, required: true, index: true },
    guestName: { type: String, required: true },
    interpreterId: { type: String, default: null, index: true },
    interpreterName: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'ringing', 'active', 'rejected', 'unavailable', 'completed'],
      default: 'pending',
      index: true,
    },
    requestedAt: { type: Date, default: () => new Date() },
    answeredAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: null }
  },
  { timestamps: true, versionKey: false }
);

const CallSession = mongoose.model('CallSession', callSessionSchema);
export { CallSession };
