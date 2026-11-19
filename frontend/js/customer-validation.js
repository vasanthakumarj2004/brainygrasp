/* Shared by profile forms, checkout and the backend. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CustomerValidation = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const limits = { name: 100, gender: 20, phone: 20, address: 255, city: 100, state: 100, pincode: 10, country: 80 };
  function normalizePhone(value, country = 'India') {
    if (typeof value !== 'string' || value.length > 40 || !/^\+?[\d\s()-]+$/.test(value.trim())) return null;
    let digits = value.replace(/\D/g, '');
    if (country.trim().toLowerCase() === 'india') {
      if (value.trim().startsWith('+') && !(digits.length === 12 && digits.startsWith('91'))) return null;
      if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
      else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
      return /^\d{10}$/.test(digits) ? digits : null;
    }
    return /^\d{7,15}$/.test(digits) ? (value.trim().startsWith('+') ? '+' : '') + digits : null;
  }
  function profile(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Profile details are required');
    const result = {};
    for (const [field, limit] of Object.entries(limits)) {
      const value = input[field];
      if (value != null && typeof value !== 'string') throw new Error(`Invalid ${field}`);
      result[field] = value?.trim() || null;
      if (field !== 'phone' && result[field]?.length > limit) throw new Error(`Invalid ${field}: maximum ${limit} characters`);
    }
    if (!result.name) throw new Error('Full name is required');
    result.country ||= 'India';
    if (result.phone) {
      result.phone = normalizePhone(result.phone, result.country);
      if (!result.phone) throw new Error(result.country.toLowerCase() === 'india' ? 'Enter a valid 10-digit Indian phone number (optional +91).' : 'Enter a valid phone number with 7 to 15 digits.');
    }
    if (result.pincode && result.country.toLowerCase() === 'india' && !/^[1-9]\d{5}$/.test(result.pincode)) throw new Error('Enter a valid 6-digit Indian PIN code');
    return result;
  }
  return { limits, normalizePhone, profile };
});
