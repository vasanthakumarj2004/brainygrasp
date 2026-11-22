'use strict';

const jwt = require('jsonwebtoken');
const { reviewerEnabled, validReviewerSession } = require('../reviewerLogin');

function authenticateToken(req, res, next) {
  const SECRET_KEY = process.env.JWT_SECRET;
  if (!SECRET_KEY) {
    throw new Error('❌ Missing required env var: JWT_SECRET must be set in .env');
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access Denied" });

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid Token" });
    if (reviewerEnabled(process.env) && !user.reviewer) {
      return res.status(401).json({ error: 'Use the test account to access the storefront in verification mode.' });
    }
    if (user.reviewer && !validReviewerSession(user, process.env)) {
      return res.status(401).json({ error: 'Verification session ended. Sign in again.' });
    }
    req.user = user;
    next();
  });
}

module.exports = {
  authenticateToken
};
