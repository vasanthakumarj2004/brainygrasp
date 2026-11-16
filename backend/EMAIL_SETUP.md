# OTP email through Nodemailer

Local and deployed backends use Gmail SMTP exclusively: `smtp.gmail.com`, port
465, with TLS certificate verification enabled. There is no Resend path or
development-mode success fallback. An OTP request reports success only after
Gmail accepts the recipient for delivery; acceptance is not proof of inbox arrival.

## Local setup

Set `EMAIL_USER` to your Gmail address and `EMAIL_PASS` to the Google app password
for that same account in `backend/.env`. Existing values are preserved. Spaces
in Google's grouped app-password display are removed in memory. Restart the
backend after changing these values; running Node processes do not reload `.env`.

From the project root:

```sh
node scripts/smtp-test.js
npm run backend:start
```

The diagnostic uses the same SMTP settings as OTP delivery. It checks connection
and authentication without sending an email, printing credentials, or creating an
OTP. It exits unsuccessfully if verification fails. From `backend/`, the equivalent
command is `npm run email:verify`.

## AWS deployment

Supply `EMAIL_USER` and `EMAIL_PASS` as backend runtime environment variables,
alongside the existing application settings. Runtime values take precedence over
the local `.env` file. The production Compose file already forwards both values;
its interpolation environment must contain them. The backend Docker build excludes
local `.env` files.

The AWS runtime needs internet/DNS access and outbound TCP 465 to Gmail. Use the
same diagnostic inside the deployed runtime before testing login. This change does
not deploy AWS resources or update the frontend's production API URL.

## Failure handling

Missing credentials, authentication errors, network errors, and rejected recipients
return failure in every environment. Server logs describe the failure category
without exposing the app password or OTP. The login page displays the API error.
No test email is sent automatically on startup. SMS OTP is unsupported and returns
failure rather than pretending a message was sent.
