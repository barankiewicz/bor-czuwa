export const requiredChecks: string[];
export const humanGates: Record<string, string>;
export function digest(bytes: string | Buffer): string;
export function writeActivationReceipt(directory: string, result: Record<string, unknown>): Promise<void>;
export function githubApi(endpoint: string): Promise<unknown>;
export function verifyCandidate(directory: string, mode: string, policy: {
  repository: string;
  workflowSha256: string;
  branches: string[];
  environment?: 'demo' | 'production';
  maxAgeHours?: number;
  allowedSigners?: string;
  approver?: string;
}, api?: (endpoint: string) => Promise<unknown>, action?: string): Promise<{
  sourceCommit: string;
  candidateSha256: string;
  artifactSha256: string;
  mode: string;
  action: string;
  androidApiOrigin: string | null;
  verificationZipSha256: string;
  verificationArtifactId: number;
  workflowRunId: string;
  workflowAttempt: number;
  workflowBranch: string;
}>;
