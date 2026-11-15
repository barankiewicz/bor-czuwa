/** One literal mailbox only: no display name, recipient list, URI, whitespace or header injection. */
export function resolveDemoTestRecipient(mode: string, value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (mode !== 'staging') throw new Error('VITE_DEMO_TEST_RECIPIENT requires --mode staging');
  const parts = value.split('@');
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  if (/\s/u.test(value) || value.length > 254 || parts.length !== 2 || local.length > 64 || !local.length ||
      !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) ||
      !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(domain)) {
    throw new Error('VITE_DEMO_TEST_RECIPIENT must be one literal email address');
  }
  return value;
}

export function validateDemoApiOrigin(origin: string | undefined): void {
  if (!origin) throw new Error('Demo Android requires an HTTPS API origin');
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error('Demo API origin must be an HTTPS origin'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error('Demo API origin must be an HTTPS origin');
  }
}
