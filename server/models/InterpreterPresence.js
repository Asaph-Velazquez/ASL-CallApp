import mongoose from 'mongoose';

const interpreterPresenceSchema = new mongoose.Schema(
  {
    interpreterId: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    availabilityStatus: {
      type: String,
      enum: ['offline', 'available', 'busy'],
      default: 'offline',
      index: true,
    },
    currentCallId: { type: String, default: null },
    lastSeenAt: { type: Date, default: () => new Date() }
  },
  { timestamps: true, versionKey: false }
);

const InterpreterPresence = mongoose.model('InterpreterPresence', interpreterPresenceSchema);
export { InterpreterPresence };
