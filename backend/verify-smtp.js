'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const nodemailer = require('nodemailer');
const { smtpOptions, smtpErrorMessage } = require('./smtpConfig');

(async () => {
  let transport;
  try {
    transport = nodemailer.createTransport(smtpOptions());
    await transport.verify();
    console.log('Gmail SMTP connection and authentication verified. No email was sent.');
  } catch (error) {
    console.error(smtpErrorMessage(error));
    process.exitCode = 1;
  } finally { transport?.close(); }
})();
