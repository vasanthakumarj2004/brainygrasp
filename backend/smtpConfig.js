'use strict';

// Shared by OTP delivery and the connection-only diagnostic.
function smtpOptions(env = process.env) {
  const user = (env.EMAIL_USER || '').trim();
  const pass = (env.EMAIL_PASS || '').replace(/\s/g, '');
  if (!user || !pass) {
    const error = new Error('Set EMAIL_USER and EMAIL_PASS for Gmail SMTP.');
    error.code = 'EMAIL_CONFIG_MISSING';
    throw error;
  }
  return {
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user, pass },
    tls: { rejectUnauthorized: true },
    connectionTimeout: 10000, greetingTimeout: 10000,
    socketTimeout: 15000, dnsTimeout: 10000,
  };
}

function smtpErrorMessage(error) {
  if (error.code === 'EMAIL_CONFIG_MISSING') return 'Set EMAIL_USER and EMAIL_PASS in the backend environment.';
  if (error.code === 'EAUTH') return 'Gmail authentication failed. Check the sender email and its Google app password, then restart the backend.';
  if (['ETIMEDOUT', 'EDNS', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED'].includes(error.code)) {
    return 'Cannot connect to Gmail SMTP. Check DNS and outbound TCP access to smtp.gmail.com:465.';
  }
  if (error.code === 'EENVELOPE' || error.code === 'ERECIPIENT') return 'Gmail did not accept the recipient address.';
  return 'SMTP email delivery failed. Check the sender configuration and SMTP availability.';
}

module.exports = { smtpOptions, smtpErrorMessage };
