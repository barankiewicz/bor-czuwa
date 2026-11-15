// What a version, species key or unit id may look like in a stored Report or Notice event. Each is the shape of the
// real values in the repo and its history, not a list of them: a phone may carry a newer policy, template or
// directory than the server knows (and a rollback the reverse), so a future value of the same shape must pass,
// while a name, e-mail address or canary string must not. Test fixtures use the literals below.
const fixtures = ['internal-fixture', 'internal-workload', 'mixed-benchmark'];
const realDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
};
const shape = (pattern: RegExp, date = false) => (value: string) => fixtures.includes(value) || (pattern.test(value) &&
  (!date || !/^(placeholder-)?\d{4}-/.test(value) || realDate(value.replace('placeholder-', ''))));

/** The shape a release carries: no fixture literal, so a build cannot ship one. */
export const releaseVersionShape = (value: string) => /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
/** 0.1.0 to 0.1.3 so far. */
export const appVersionShape = shape(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
/** The policy and terms versions: 1 and v1 so far. */
export const policyVersionShape = shape(/^v?\d{1,3}$/);
/** The Notice template: placeholder-2026-09-25 so far; a reviewed one may drop the prefix or count up. */
export const templateVersionShape = shape(/^(placeholder-)?(\d{4}-\d{2}-\d{2}|v?\d{1,3})$/, true);
/** The authority directory: 2026-09-24 and 2026-09-26 so far. */
export const directoryVersionShape = shape(/^\d{4}-\d{2}-\d{2}$/, true);
/** The Rule set catalogue's keys are one to three lowercase words joined by hyphens (dziki-krolik); no digits. */
export const speciesKeyShape = /^[a-z]{2,20}(-[a-z]{2,20}){0,2}$/;

// The shape of the ids the directory uses for each kind of recipient (gmina: TERYT code, police: UUID, psl and rdos:
// voivodeship code, park: ZIPOP id). A directory newer than the server's still passes; a name does not.
const unitShapes: Record<string, RegExp> = {
  gmina: /^\d{7}$/,
  police: /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
  psl: /^\d{2}$/,
  rdos: /^\d{2}$/,
  nationalPark: /^PL\.ZIPOP\.\d{4}\.PN\.\d{1,2}$/
};
export const unitIdShape = (kind: string, id: string) => unitShapes[kind]?.test(id) ?? false;
