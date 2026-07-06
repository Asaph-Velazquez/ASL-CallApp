import mongoose from 'mongoose';
import argon2 from 'argon2';

const interpreterUserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    fullName: { type: String, required: true }
  },
  { timestamps: true, versionKey: false }
);

interpreterUserSchema.pre('save', async function savePassword(next) {
  if (!this.isModified('password')) {
    next();
    return;
  }

  this.password = await argon2.hash(this.password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
  next();
});

interpreterUserSchema.methods.comparePassword = async function comparePassword(password) {
  try {
    return await argon2.verify(this.password, password);
  } catch (_error) {
    return false;
  }
};

const InterpreterUser = mongoose.model('InterpreterUser', interpreterUserSchema);
export { InterpreterUser };
