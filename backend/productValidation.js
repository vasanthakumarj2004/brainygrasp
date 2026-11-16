'use strict';

function validateProductImage(value, { production = process.env.NODE_ENV === 'production' } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error('A direct product image URL is required.');
  const image = value.trim();
  if (/[\s<>"'\\]/.test(image)) throw new Error('Use an encoded image URL without spaces or HTML characters.');
  const relative = image.startsWith('/') && !image.startsWith('//');
  let url;
  try { url = new URL(image, relative ? 'https://store.invalid' : undefined); }
  catch { throw new Error('Enter a valid HTTPS image URL or a site path starting with /.'); }
  if (url.username || url.password || !['https:', ...(production ? [] : ['http:'])].includes(url.protocol)) {
    throw new Error('Use a public HTTPS image URL without a username or password.');
  }
  if (['photos.google.com', 'photos.app.goo.gl', 'drive.google.com'].includes(url.hostname)) {
    throw new Error('Google sharing pages are not direct image URLs. Use a publicly hosted image.');
  }
  return image;
}
module.exports = { validateProductImage };
