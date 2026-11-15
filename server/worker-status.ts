export const workerStatus = {
  api503: {} as Record<string, number>,
  lastPollAt: Date.now(),
  lastIntegrityPollAt: Date.now(),
  recoveryCount: 0,
  databaseRecoveryCount: 0,
  awaitingDatabaseRecovery: false,
  reportCeilingRefusedAt: undefined as number | undefined
};
