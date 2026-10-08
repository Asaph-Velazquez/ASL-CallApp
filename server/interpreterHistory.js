import { Router } from 'express';

const callFields = 'callId roomNumber guestName status requestedAt answeredAt endedAt endReason';
const reportFields = 'reportId callId summary priority category followUpRequired notes submittedAt forwardedToAslWeb forwardedAt';

export function createInterpreterHistoryRouter({ verifyInterpreter, CallSession, InterpreterReport }) {
  const router = Router();
  router.get('/history', verifyInterpreter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const rawPage = req.query.page ?? '1';
    const rawSize = req.query.pageSize ?? '20';
    if (typeof rawPage !== 'string' || typeof rawSize !== 'string'
        || !/^[1-9]\d*$/.test(rawPage) || !/^[1-9]\d*$/.test(rawSize)
        || Number(rawPage) > 100000 || Number(rawSize) > 50) {
      return res.status(400).json({ error: 'Invalid history pagination' });
    }
    const page = Number(rawPage), pageSize = Number(rawSize);
    // Ownership comes only from the centrally validated identity, never query parameters.
    const interpreterId = req.user.userId;
    const filter = { $or: [{ interpreterId }, { assignedInterpreterId: interpreterId }] };
    try {
      const [calls, total] = await Promise.all([
        CallSession.find(filter).select(callFields).sort({ requestedAt: -1, _id: -1 })
          .skip((page - 1) * pageSize).limit(pageSize).lean(),
        CallSession.countDocuments(filter),
      ]);
      const reports = calls.length ? await InterpreterReport.find({
        interpreterId, callId: { $in: calls.map(call => call.callId) },
      }).select(reportFields).sort({ submittedAt: -1, _id: -1 }).lean() : [];
      const byCall = new Map();
      for (const report of reports) {
        if (!byCall.has(report.callId)) {
          const { _id, ...publicReport } = report;
          byCall.set(report.callId, publicReport);
        }
      }
      return res.json({
        calls: calls.map(({ _id, ...call }) => ({ ...call, report: byCall.get(call.callId) ?? null })),
        page, pageSize, total, totalPages: Math.ceil(total / pageSize),
      });
    } catch {
      return res.status(503).json({ error: 'Call history is temporarily unavailable. Try again.' });
    }
  });
  return router;
}
