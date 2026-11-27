'use strict';
function authenticateToken(req, res, next) {
  return require('../authSecurity').security().authenticate('customer')(req, res, next);
}
module.exports = { authenticateToken };
