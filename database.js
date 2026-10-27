import mongoose from 'mongoose';
import { sessionIsConfigured } from './sessions.js';
import { User, AuthSession } from './auth.js';

const { Schema } = mongoose;
const cropRecordSchema = new Schema({
  ownerId: { type: String, required: true, index: true, maxlength: 64 },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  variety: { type: String, trim: true, maxlength: 80, default: '' },
  area: { type: Number, min: 0, max: 100000, required: true },
  stage: { type: String, trim: true, maxlength: 80, default: '' },
  date: { type: String, trim: true, maxlength: 10, default: '' }
}, { timestamps: true, versionKey: false });
cropRecordSchema.index({ ownerId: 1, createdAt: -1 });

const reportSchema = new Schema({
  ownerId: { type: String, required: true, index: true, maxlength: 64 },
  crop: { type: String, required: true, trim: true, maxlength: 80 },
  identifiedCrop: { type: String, trim: true, maxlength: 100, default: '' },
  affectedPart: { type: String, trim: true, maxlength: 40, default: '' },
  growthStage: { type: String, trim: true, maxlength: 80, default: '' },
  location: { type: String, trim: true, maxlength: 120, default: '' },
  disease: { type: String, trim: true, maxlength: 500, default: '' },
  uncertain: { type: Boolean, default: false },
  uncertaintyMessage: { type: String, trim: true, maxlength: 1000, default: '' },
  severity: { type: String, enum: ['mild', 'moderate', 'severe', 'unknown'], default: 'unknown' },
  confidenceLevel: { type: String, enum: ['low', 'moderate', 'high'], default: 'low' },
  confidenceNote: { type: String, trim: true, maxlength: 500, default: '' },
  confidenceNoteHi: { type: String, trim: true, maxlength: 500, default: '' },
  symptoms: { type: [String], default: [] },
  possibleCauses: { type: [String], default: [] },
  recommendations: { type: [String], default: [] },
  prevention: { type: [String], default: [] },
  expertWhen: { type: String, trim: true, maxlength: 1000, default: '' },
  language: { type: String, enum: ['hi', 'en'], default: 'en' }
}, { timestamps: true, versionKey: false });
reportSchema.index({ ownerId: 1, createdAt: -1 });

const alertSchema = new Schema({
  ownerId: { type: String, required: true, index: true, maxlength: 64 },
  type: { type: String, required: true, enum: ['weather', 'crop-analysis', 'system'], maxlength: 40 },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  source: { type: String, required: true, trim: true, maxlength: 120 },
  createdAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, default: null }
}, { versionKey: false });
alertSchema.index({ ownerId: 1, createdAt: -1 });
alertSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: 'date' } } });

export const CropRecord = mongoose.models.CropRecord || mongoose.model('CropRecord', cropRecordSchema);
export const CropAnalysisReport = mongoose.models.CropAnalysisReport || mongoose.model('CropAnalysisReport', reportSchema);
export const Alert = mongoose.models.Alert || mongoose.model('Alert', alertSchema);

let connecting = null;
let reconnectTimer = null;
export const database = {
  configured: Boolean(process.env.MONGODB_URI),
  get connected() { return mongoose.connection.readyState === 1; },
  get sessionReady() { return sessionIsConfigured(); },
  get reportsEnabled() { return this.configured && this.connected && this.sessionReady; },
  async connect() {
    if (!process.env.MONGODB_URI) return false;
    if (mongoose.connection.readyState === 1) return true;
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        await mongoose.connect(process.env.MONGODB_URI, {
          serverSelectionTimeoutMS: 5000,
          maxPoolSize: 10,
          autoIndex: process.env.NODE_ENV !== 'production'
        });
        if (process.env.NODE_ENV === 'production') {
          await Promise.all([CropRecord.createIndexes(), CropAnalysisReport.createIndexes(), Alert.createIndexes(), User.createIndexes(), AuthSession.createIndexes()]);
        }
        return true;
      } catch (error) {
        console.error(`MongoDB connection failed: ${error.name || 'Error'}`);
        return false;
      } finally { connecting = null; }
    })();
    return connecting;
  }
};

mongoose.connection.on('disconnected', () => {
  console.error('MongoDB disconnected. Persistence endpoints are unavailable until reconnection.');
  if (process.env.MONGODB_URI && !reconnectTimer) {
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void database.connect(); }, 5000);
    reconnectTimer.unref?.();
  }
});
