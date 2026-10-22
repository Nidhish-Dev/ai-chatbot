/**
 * Disposable email domain blocklist and email validation
 * Used to enforce Risk 8.1: Prevent fake contact details before Try-it gate
 */

const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com',
  '10minutemail.net',
  'tempmail.com',
  'tempmail.net',
  'temp-mail.org',
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'trashmail.com',
  'throwawaymail.com',
  'yopmail.com',
  'getairmail.com',
  'dispostable.com',
  'sharklasers.com',
  'maildrop.cc',
  'fakeinbox.com',
  'inboxkitten.com',
  'burnermail.io',
  'mohmal.com',
  'crazymailing.com',
  'generator.email',
  'mytemp.email',
  'fakemailgenerator.com'
]);

function isDisposableEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2) return true;
  const domain = parts[1];
  return DISPOSABLE_DOMAINS.has(domain);
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email.trim()) && !isDisposableEmail(email);
}

function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  // Cleans digits and leading +
  const cleaned = phone.replace(/[^0-9+]/g, '');
  // At least 8 digits, at most 15 digits
  const digits = cleaned.replace(/\+/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

module.exports = {
  isDisposableEmail,
  isValidEmail,
  isValidPhone,
  DISPOSABLE_DOMAINS
};
