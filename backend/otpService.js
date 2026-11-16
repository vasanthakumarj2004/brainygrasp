'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const nodemailer = require('nodemailer');
const { smtpOptions, smtpErrorMessage } = require('./smtpConfig');

// ── Shared HTML email template ────────────────────────────────────────────
function buildEmailHTML(otp) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #FF6B35 0%, #E85520 100%); padding: 30px; border-radius: 12px; text-align: center; margin-bottom: 30px;">
        <h1 style="color: white; margin: 0; font-size: 32px;">brainy<span style="color:#FFE66D;">grasp</span></h1>
        <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0 0; font-size: 14px;">Where Learning Meets Play!</p>
      </div>
      <div style="background: #f8f9fa; padding: 30px; border-radius: 10px; margin-bottom: 20px;">
        <h2 style="color: #1e1e2e; margin: 0 0 10px 0; font-size: 20px;">Your One-Time Password</h2>
        <p style="color: #555; margin: 0 0 20px 0; font-size: 14px;">Use this OTP to verify your identity on BrainyGrasp.</p>
        <div style="background: white; border: 2px dashed #FF6B35; padding: 24px; border-radius: 10px; text-align: center; margin: 0 0 20px 0;">
          <span style="font-size: 40px; font-weight: bold; color: #FF6B35; letter-spacing: 10px;">${otp}</span>
        </div>
        <p style="color: #666; margin: 0; line-height: 1.6; font-size: 14px;">
          This OTP is valid for <strong>10 minutes</strong>. Do not share this code with anyone.
        </p>
      </div>
      <div style="text-align: center; color: #999; font-size: 12px; border-top: 1px solid #eee; padding-top: 20px;">
        <p style="margin: 0 0 6px;">If you didn't request this OTP, please ignore this email.</p>
        <p style="margin: 0 0 6px;">Support: <a href="mailto:brainygrasp@gmail.com" style="color:#FF6B35;">brainygrasp@gmail.com</a></p>
        <p style="margin: 0;">© 2026 BrainyGrasp Learning Pvt. Ltd.</p>
      </div>
    </div>
  `;
}

// Gmail SMTP is the only OTP delivery provider in every environment.
async function sendOTPEmail(email, otp) {
  let transporter;
  try {
    const options = smtpOptions();
    transporter = nodemailer.createTransport(options);
    const result = await transporter.sendMail({
      from: { name: 'BrainyGrasp', address: options.auth.user },
      replyTo: options.auth.user,
      to: email,
      subject: 'BrainyGrasp - Your One-Time Password (OTP)',
      text: `Your BrainyGrasp OTP is ${otp}. It expires in 10 minutes. Do not share this code.`,
      html: buildEmailHTML(otp),
    });
    const accepted = (result.accepted || []).some(recipient =>
      String(typeof recipient === 'string' ? recipient : recipient.address).toLowerCase() === String(email).trim().toLowerCase());
    if (!accepted) {
      const error = new Error('Recipient not accepted');
      error.code = 'ERECIPIENT';
      throw error;
    }
    return true;
  } catch (error) {
    // Do not log provider responses: they can include credentials or recipient data.
    console.error(smtpErrorMessage(error));
    return false;
  } finally {
    transporter?.close();
  }
}

async function sendOTPSMS() {
  console.error('SMS OTP is not configured. Use email verification.');
  return false;
}

async function sendOTP(method, value, otp) {
  if (method === 'email') return sendOTPEmail(value, otp);
  if (method === 'phone') return sendOTPSMS();
  return false;
}

module.exports = { sendOTP, sendOTPEmail, sendOTPSMS };
