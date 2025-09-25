export const sensitiveConfig = {
  enabled: true,
  allowUnmask: true,
  showPartial: true,
  maskCharacter: '*',
  maskLength: 6,
  separators: [':', '=', '=>', '\n'],
  // Card sizing defaults (pixels)
  noteCardMinHeight: 220,
  noteCardMaxContentHeight: 220,
  // A broader set of sensitive keywords; UI allows editing this list
  sensitiveKeywords: [
    'password', 'pass', 'passwd', 'pwd', 'secret', 'api_key', 'apikey', 'api-key', 'token', 'auth_token', 'access_token',
    'secret_key', 'secretkey', 'client_secret', 'private_key', 'ssh_key', 'ssn', 'social security', 'credit card', 'ccv', 'cvv',
    'card number', 'cardnum', 'bank account', 'routing number', 'ssn', 'dob', 'date of birth', 'pin', 'pincode', 'security answer',
    'one-time password', 'otp', 'two-factor', '2fa', 'multifactor', 'mfa', 'master key'
  ]
};

export const hasSensitiveContent = (text) => {
  if (!sensitiveConfig.enabled || !text) return false;
  const lower = text.toLowerCase();
  return sensitiveConfig.sensitiveKeywords.some(k => lower.includes(k));
};

export const maskSensitiveContent = (text) => {
  if (!text) return text;
  const mask = sensitiveConfig.maskCharacter.repeat(sensitiveConfig.maskLength);
  // naive replacement for keywords
  let out = text;
  sensitiveConfig.sensitiveKeywords.forEach(k => {
    const re = new RegExp(`(${k}\\s*[:=\\n\\s]+)(\\S+)`, 'gi');
    out = out.replace(re, `$1${mask}`);
  });
  return out;
};

export const addSensitiveKeywords = (kw) => {
  if (!sensitiveConfig.sensitiveKeywords.includes(kw)) sensitiveConfig.sensitiveKeywords.push(kw);
};

export const removeSensitiveKeywords = (kw) => {
  sensitiveConfig.sensitiveKeywords = sensitiveConfig.sensitiveKeywords.filter(k => k !== kw);
};

export const updateSensitiveConfig = (patch) => {
  Object.assign(sensitiveConfig, patch);
};

export default sensitiveConfig;