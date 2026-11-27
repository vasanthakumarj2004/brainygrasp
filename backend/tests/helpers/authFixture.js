'use strict';
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createAuthSecurity } = require('../../authSecurity');

// Database adapter for unit tests only. Production has no legacy-token or test-login bypass.
function authFixture(env = { JWT_SECRET: 'auth-test-only', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-only' }) {
  const sessions = new Map(), challenges = new Map(), limits = new Map();
  const users = [{ id: 1, email: 'customer@example.com', name: 'Customer', phone: null }];
  const state = { sessions, challenges, limits, users, active: true, passwordHash: 'password-hash' };
  const result = rows => ({ rows: structuredClone(rows) });
  let queue = Promise.resolve();
  const db = { async query(sql, args = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('INSERT INTO auth_limits')) { const n = (limits.get(args[0]) || 0) + 1; limits.set(args[0], n); return result([{ attempts: n }]); }
    if (q.startsWith('INSERT INTO auth_challenges')) { challenges.set(args[0], { verifier: args[1], attempts: 0, valid: true }); return result([]); }
    if (q.startsWith('SELECT verifier')) return result(challenges.has(args[0]) ? [challenges.get(args[0])] : []);
    if (q.startsWith('UPDATE auth_challenges')) { challenges.get(args[0]).attempts++; return result([]); }
    if (q.startsWith('DELETE FROM auth_challenges')) {
      if (!args[1] || challenges.get(args[0])?.verifier === args[1]) challenges.delete(args[0]); return result([]);
    }
    if (q.startsWith('SELECT id, name, email, phone FROM users')) return result(users.filter(u => u.email.toLowerCase() === args[0]));
    if (q.startsWith('INSERT INTO users')) { const user = { id: users.length + 1, email: args[0], name: null, phone: null }; users.push(user); return result([user]); }
    if (q.startsWith('INSERT INTO auth_sessions')) { sessions.set(args[0], { user_id: args[1], role: args[2], credential: args[3] }); return result([]); }
    if (q.startsWith('SELECT user_id,role,credential')) return result(sessions.has(args[0]) ? [sessions.get(args[0])] : []);
    if (q.startsWith('SELECT u.password_hash')) return result(state.active ? [{ password_hash: state.passwordHash }] : []);
    if (q.startsWith('DELETE FROM auth_sessions')) { sessions.delete(args[0]); return result([]); }
    throw new Error('Unexpected auth SQL: ' + q);
  }, async connect() {
    let unlock;
    return { async query(sql, args) {
      if (sql === 'BEGIN') { const previous = queue; queue = new Promise(r => { unlock = r; }); await previous; return result([]); }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { unlock?.(); unlock = null; return result([]); }
      return db.query(sql, args);
    }, release() { unlock?.(); } };
  } };
  const security = createAuthSecurity(db, env);
  function token(claims) {
    const sid = crypto.randomUUID(), role = claims.role || 'customer';
    sessions.set(sid, { user_id: claims.id || null, role,
      credential: role === 'admin' ? security.digest(JSON.stringify([env.ADMIN_USERNAME, env.ADMIN_PASSWORD])) :
        role === 'affiliate' ? security.digest(state.passwordHash) : null });
    return jwt.sign({ ...claims, role, sid }, env.JWT_SECRET, { expiresIn: '1h' });
  }
  return { security, db, state, token, env };
}
module.exports = { authFixture };
