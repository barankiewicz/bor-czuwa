export const testCertificate: string;
export function assertPrivateCandidate(report: unknown, verified: unknown,
  expected: { sourceCommit: string; origin: string; recipient: string }): void;
export function assertPrivateApk(description: unknown, manifest: unknown, version: string,
  expected: { origin: string; recipient: string }): void;
export function assertSamePayload(original: unknown, finalized: unknown): void;
export function assertTestCertificate(certificate: string): void;
export function parsePrivateApkManifest(badging: string): {
  applicationId: string; versionCode: number; versionName: string; debuggable: boolean; testLabel: boolean;
};
export function finalizePrivateAndroid(directory: string, output: string,
  expected: { sourceCommit: string; origin: string; recipient: string },
  policy: { environment: string; repository: string; branches: string[] },
  api?: (endpoint: string) => Promise<unknown>): Promise<Record<string, unknown>>;
