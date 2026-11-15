export const redact = text => text
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[REDACTED_URL]')
  .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[REDACTED_EMAIL]')
  .replace(/\b(authorization["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^"'\s,;}\]]+/gi, '$1[REDACTED]')
  .replace(/\b([\w-]*(?:password|secret|token|authorization|cookie|identity)[\w-]*\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
export const redactValue = (key, item) => /^(?:proxy[-_]?)?authorization$/i.test(key)
  ? '[REDACTED]' : typeof item === 'string' ? redact(item) : item;
