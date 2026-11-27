'use strict';
const rateLimit = require('express-rate-limit');
// Additional local protection; authSecurity also enforces shared database limits.
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please wait 15 minutes.' } });
module.exports = { otpLimiter };
