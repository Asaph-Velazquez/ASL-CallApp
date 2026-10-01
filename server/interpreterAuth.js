import jwt from 'jsonwebtoken';

export const INTERPRETER_ISSUER = 'asl-callapp';
export const INTERPRETER_AUDIENCE = 'asl-interpreter-console';
export const authError = (status, message) => Object.assign(new Error(message), { status });

export function createInterpreterAuth({ hotelUrl, internalToken, secret }) {
  async function hotelIdentity(action, body) {
    if (!internalToken) throw authError(503, 'Hotel authentication is not configured');
    try {
      const response = await fetch(`${hotelUrl.replace(/\/$/, '')}/api/internal/interpreters/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-token': internalToken },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      const data = await response.json();
      if (data.code === 'INVALID_INTERNAL_TOKEN') throw authError(503, 'Hotel authentication is not configured');
      if (response.status === 401 || response.status === 403) throw authError(401,
        action === 'authenticate' ? 'Invalid credentials or interpreter access not granted' : 'Interpreter access revoked');
      if (!response.ok) throw authError(response.status === 400 ? 400 : 503, 'Hotel authentication unavailable');
      const user = data.interpreter;
      if (!user || user.role !== 'interpreter' || !/^[a-f0-9]{24}$/i.test(user.userId)
          || typeof user.username !== 'string' || typeof user.fullName !== 'string'
          || (body.userId && body.userId !== user.userId)) throw authError(503, 'Invalid hotel identity response');
      return user;
    } catch (error) {
      if (error.status) throw error;
      throw authError(503, 'Hotel authentication unavailable. Try again later.');
    }
  }
  return {
    login: credentials => hotelIdentity('authenticate', credentials),
    issue(user) {
      return jwt.sign({ userId: user.userId, username: user.username, fullName: user.fullName, role: 'interpreter' }, secret,
        { expiresIn: '8h', issuer: INTERPRETER_ISSUER, audience: INTERPRETER_AUDIENCE, algorithm: 'HS256' });
    },
    async validate(token) {
      let decoded;
      try {
        decoded = jwt.verify(token, secret, { issuer: INTERPRETER_ISSUER, audience: INTERPRETER_AUDIENCE, algorithms: ['HS256'] });
        if (decoded.role !== 'interpreter' || !decoded.exp || !/^[a-f0-9]{24}$/i.test(decoded.userId)) throw Error();
      } catch { throw authError(401, 'Interpreter session expired or access revoked. Sign in again.'); }
      return hotelIdentity('validate', { userId: decoded.userId });
    },
  };
}

// Reserve attempts before the async login to bound concurrent password guesses.
// Only successful logins and upstream outages release their reservation.
export function createLoginLimiter() {
  const attempts = new Map();
  const sweep = setInterval(() => {
    for (const [key, entry] of attempts) if (entry.until <= Date.now()) attempts.delete(key);
  }, 60000);
  sweep.unref();
  return (req, res, next) => {
    const key = req.ip;
    let entry = attempts.get(key);
    if (!entry || entry.until <= Date.now()) {
      if (attempts.size >= 10000) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      entry = { count: 0, until: Date.now() + 15 * 60000 };
      attempts.set(key, entry);
    }
    if (entry.count >= 5) {
      res.set('Retry-After', String(Math.ceil((entry.until - Date.now()) / 1000)));
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
    entry.count++;
    res.once('finish', () => { if (res.statusCode < 400 || res.statusCode >= 500) entry.count--; });
    next();
  };
}
