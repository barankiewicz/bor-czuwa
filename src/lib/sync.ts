import { hasReport, isSynced, listReports, listWithdrawals, markNoticeEvent, recordSync, recordWithdrawalRetry, retireWithdrawal, type LocalReport } from './local-store';
import { version } from '$app/environment';
import { solveProof } from './proof';
import type { FindingsResult } from './report';
import { apiFetch, apiUrl } from './api-url';
import { clearAndroidMailCopies } from './platform';

export function createSyncWorker(onChange: () => Promise<unknown>, onStorageError: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let healthyCheckRequested = false;
  let stopped = false;
  let currentStage: LocalReport['retry_stage'];
  let readCooldownUntil = 0;
  let lastRead: { at: string; id: string } | undefined;
  let readRound = new Set<string>();
  const deferredPresence = new Set<string>();
  const readOrigin = new URL(apiUrl('/api/reports'), window.location.href).origin;
  const findingsPolls = new Map<string, { attempts: number; at: number }>();
  // When each Report the server already measured is next checked for, in memory only: a launch
  // checks every one, then a resume or reconnect at most hourly. No timer polls for it.
  const presenceChecks = new Map<string, { at: number; failures: number; retry: boolean }>();
  // Consecutive failed requests per Report and per Withdrawal, for their own retry delays.
  const reportFailures = new Map<string, number>();
  const withdrawalFailures = new Map<string, number>();

  function seen(id: string) {
    reportFailures.delete(id);
    deferredPresence.delete(id);
    presenceChecks.set(id, { at: Date.now() + presenceEvery, failures: 0, retry: false });
  }

  // The server lost this Report: upload it again, keeping its Findings and private details.
  async function restore(id: string) {
    findingsPolls.delete(id);
    presenceChecks.delete(id);
    deferredPresence.delete(id);
    if (await recordSync(id, { synced: false })) await onChange();
  }

  async function defer(id: string, response: Response, stage: LocalReport['retry_stage']) {
    const at = retryAt(response);
    await recordSync(id, { retryAt: at, retryReason: 'rate_limit', retryStage: stage });
    await onChange();
    return at;
  }

  function pause() {
    clearTimeout(timer);
    active?.abort();
  }

  function observeReadLimit(response: Response) {
    try { if (new URL(response.url).origin !== readOrigin) return; } catch { return; }
    readCooldownUntil = Math.max(readCooldownUntil, retryAt(response, 0));
  }

  // Returns whether this Report can proceed to its independent Notice events.
  async function readFindings(local: LocalReport, uploaded: boolean, controller: AbortController,
    checkHealthy: boolean, waitFor: (at: number) => void, pass: { ids: Set<string>; deferred: boolean }) {
    // Keep each round finite: arrivals join a later snapshot, so a growing suffix
    // cannot keep older eligible IDs out of the read-only wrap.
    if (!readRound.size) readRound = new Set(pass.ids);
    const read = () => {
      lastRead = { at: local.events[0].at, id: local.report.id };
      readRound.delete(local.report.id);
      return apiFetch(`/api/reports/${local.report.id}/findings`, {
        headers: { authorization: `Bearer ${local.token}` }, signal: requestSignal(controller.signal)
      });
    };
    if (!uploaded && local.findings.status !== 'pending' && !unsentEvents(local).length) {
      const check = presenceChecks.get(local.report.id);
      if (!checkHealthy && !check?.retry && !deferredPresence.has(local.report.id)) { readRound.delete(local.report.id); return false; }
      if (check && check.at > Date.now()) {
        readRound.delete(local.report.id);
        if (check.retry) waitFor(check.at);
        return false;
      }
      deferredPresence.add(local.report.id);
      if (!readRound.has(local.report.id)) { pass.deferred = true; return false; }
      if (readCooldownUntil > Date.now()) { waitFor(readCooldownUntil); return false; }
      let response: Response | undefined;
      try {
        response = await read();
        await response.body?.cancel();
      } catch (error) {
        if (controller.signal.aborted) return false;
        if (!(error instanceof TypeError || error instanceof DOMException)) throw error;
      }
      if (controller.signal.aborted) return false;
      if (response?.status === 404) { await restore(local.report.id); waitFor(Date.now() + 1); return false; }
      if (response?.ok) { seen(local.report.id); return false; }
      const limited = response?.status === 429;
      if (limited) observeReadLimit(response!);
      const failures = (check?.failures ?? 0) + (limited ? 0 : 1);
      const at = limited ? retryAt(response!) : Date.now() + Math.min(presenceEvery, 30_000 * 2 ** (failures - 1));
      presenceChecks.set(local.report.id, { at, failures, retry: true });
      deferredPresence.delete(local.report.id);
      waitFor(at);
      return false;
    }
    if (local.findings.status !== 'pending') { readRound.delete(local.report.id); return true; }
    const poll = findingsPolls.get(local.report.id);
    if (poll && poll.at > Date.now()) { readRound.delete(local.report.id); waitFor(poll.at); return true; }
    if (!readRound.has(local.report.id)) { pass.deferred = true; return true; }
    if (readCooldownUntil > Date.now()) { waitFor(readCooldownUntil); return true; }
    currentStage = 'findings';
    const response = await read();
    if (!response.ok) await response.body?.cancel();
    if (response.status === 429) {
      observeReadLimit(response);
      waitFor(await defer(local.report.id, response, 'findings'));
      return false;
    }
    if (response.status === 404) { await restore(local.report.id); waitFor(Date.now() + 1); return false; }
    if (!response.ok) throw new Error('findings_unavailable');
    const findings = await response.json() as FindingsResult;
    if (controller.signal.aborted) return false;
    reportFailures.delete(local.report.id);
    if (JSON.stringify(local.findings) !== JSON.stringify(findings) || local.retry_at || local.sync_error) {
      if (!await recordSync(local.report.id, { findings })) return false;
      await onChange();
    }
    if (findings.status === 'pending') {
      const attempts = Math.min((poll?.attempts ?? 0) + 1, 5);
      const at = Date.now() + Math.min(30_000, 1000 * 2 ** attempts);
      findingsPolls.set(local.report.id, { attempts, at });
      waitFor(at);
    } else { findingsPolls.delete(local.report.id); seen(local.report.id); }
    return true;
  }

  async function wake(checkHealthyReports = true) {
    healthyCheckRequested ||= checkHealthyReports;
    clearTimeout(timer);
    if (stopped || document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (active) return;
    const checkHealthy = healthyCheckRequested;
    healthyCheckRequested = false;
    const controller = new AbortController();
    active = controller;
    let pending = false;
    let passFailed = false;
    let waitUntil = 0;
    const waitFor = (at: number) => { waitUntil = waitUntil ? Math.min(waitUntil, at) : at; };
    try {
      const withdrawals = await listWithdrawals();
      // A failing Withdrawal waits on its own retry time and the Reports still get their pass. Its
      // Report already left the phone when it was withdrawn, so nothing below can upload it.
      for (const withdrawal of withdrawals) {
        if (controller.signal.aborted) return;
        if (withdrawal.retry_at && withdrawal.retry_at > Date.now()) {
          waitFor(withdrawal.retry_at);
          continue;
        }
        try {
          const response = await apiFetch(`/api/reports/${withdrawal.id}`, {
            method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${withdrawal.token}` },
            signal: requestSignal(controller.signal)
          });
          await response.body?.cancel();
          if (response.status === 429) {
            const at = retryAt(response);
            await recordWithdrawalRetry(withdrawal.id, withdrawal.token, at);
            waitFor(at);
            continue;
          }
          if (!response.ok) throw new Error('withdrawal_unavailable');
          await clearAndroidMailCopies();
          await retireWithdrawal(withdrawal.id, withdrawal.token);
          withdrawalFailures.delete(withdrawal.id);
          await onChange();
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof DOMException && storageFailures.includes(error.name)) throw error;
          const count = (withdrawalFailures.get(withdrawal.id) ?? 0) + 1;
          withdrawalFailures.set(withdrawal.id, count);
          const at = Date.now() + retryDelay(count);
          waitFor(at);
          pending = true;
          await recordWithdrawalRetry(withdrawal.id, withdrawal.token, at);
          await onChange();
        }
      }
      const reports = await listReports();
      const ids = new Set(reports.map(local => local.report.id));
      const readPass = { ids, deferred: false };
      for (const id of readRound) if (!ids.has(id)) readRound.delete(id);
      for (const id of deferredPresence) if (!ids.has(id)) deferredPresence.delete(id);
      const nextRead = lastRead ? reports.findIndex(local =>
        (local.events[0].at.localeCompare(lastRead!.at) || local.report.id.localeCompare(lastRead!.id)) > 0) : 0;
      const readStart = Math.max(0, nextRead);
      let wrapReports = new Map<string, LocalReport>();
      let reportLimit = Math.max(0, ...reports.filter(local => !isSynced(local) && local.retry_reason === 'rate_limit' &&
        local.retry_stage === 'report').map(local => local.retry_at ?? 0));
      // A failure belongs to the Report that met it: it waits on its own retry time while every
      // later Report still gets its upload, Findings, Notice events and presence check.
      reportLoop: for (let index = 0; index < reports.length + readStart; index++) {
        const readOnly = index >= reports.length;
        if (index === reports.length) wrapReports = new Map((await listReports()).map(local => [local.report.id, local]));
        const local = readOnly ? wrapReports.get(reports[index - reports.length].report.id) : reports[index];
        if (!local) continue;
        if (controller.signal.aborted) return;
        currentStage = undefined;
        let uploaded = false;
        try {
          if (local.sync_error && local.refused_version === version) { readRound.delete(local.report.id); continue; }
          if (local.retry_at && local.retry_at > Date.now()) {
            readRound.delete(local.report.id);
            waitFor(local.retry_at);
            continue;
          }
          if (readOnly) {
            if (isSynced(local)) await readFindings(local, false, controller, checkHealthy, waitFor, readPass);
            else readRound.delete(local.report.id);
            continue;
          }
          if (!isSynced(local)) {
            if (reportLimit > Date.now()) {
              readRound.delete(local.report.id);
              waitFor(reportLimit);
              continue;
            }
            currentStage = 'report';
            const challenge = await apiFetch('/api/challenge', {
              signal: requestSignal(controller.signal)
            });
            if (!challenge.ok) await challenge.body?.cancel();
            // The daily limit covers this address, so later uploads wait too; their other requests go on.
            if (challenge.status === 429) { reportLimit = await defer(local.report.id, challenge, 'report'); waitFor(reportLimit); continue; }
            if (!challenge.ok) throw new Error('challenge_unavailable');
            const solution = await solveProof(await challenge.json(), controller.signal);
            // A Withdrawal made while the proof was solved must not put the Report back.
            if (!await hasReport(local.report.id)) continue;
            const response = await apiFetch('/api/reports', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...local.report, solution }),
              signal: requestSignal(controller.signal)
            });
            await response.body?.cancel();
            if (response.status === 429) {
              reportLimit = await defer(local.report.id, response, 'report');
              waitFor(reportLimit);
              continue;
            }
            if (response.status === 400 || response.status === 409 || response.status === 410) {
              await recordSync(local.report.id, { error: response.status === 400 ? 'validation_refused' : 'server_refused' });
              await onChange();
              continue;
            }
            if (!response.ok) throw new Error('sync_unavailable');
            if (!await recordSync(local.report.id, { synced: true })) {
              // Withdrawal intent owns deletion after a concurrent upload.
              continue;
            }
            if (controller.signal.aborted) return;
            uploaded = true;
            await onChange();
          }
          if (uploaded) seen(local.report.id);
          if (index >= readStart && !await readFindings(local, uploaded, controller, checkHealthy, waitFor, readPass)) continue;
          for (const event of unsentEvents(local)) {
            currentStage = 'events';
            const { synced: _, refused: __, ...body } = event;
            const response = await apiFetch(`/api/reports/${local.report.id}/events`, {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${local.token}` },
              body: JSON.stringify(body),
              signal: requestSignal(controller.signal)
            });
            await response.body?.cancel();
            if (response.status === 429) { waitFor(await defer(local.report.id, response, 'events')); continue reportLoop; }
            if (response.status === 404) { await restore(local.report.id); waitFor(Date.now() + 1); continue reportLoop; }
            if (response.status === 400 || response.status === 409) {
              await markNoticeEvent(local.report.id, event.id, 'refused');
              continue;
            }
            if (!response.ok) throw new Error('events_unavailable');
            if (controller.signal.aborted) return;
            await markNoticeEvent(local.report.id, event.id, 'synced');
            seen(local.report.id);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          if (!currentStage || (error instanceof DOMException && storageFailures.includes(error.name))) throw error;
          const count = (reportFailures.get(local.report.id) ?? 0) + 1;
          reportFailures.set(local.report.id, count);
          const at = Date.now() + retryDelay(count);
          waitFor(at);
          pending = true;
          await recordSync(local.report.id, { retryAt: at,
            retryReason: error instanceof TypeError || error instanceof DOMException ? 'network' : 'server', retryStage: currentStage });
          await onChange();
        }
      }
      currentStage = undefined;
      // Include Reports saved while this pass was in flight.
      const remainingReports = await listReports();
      const remainingIds = new Set(remainingReports.map(local => local.report.id));
      for (const id of readRound) if (!remainingIds.has(id)) readRound.delete(id);
      if (readPass.deferred || remainingReports.some(local => !ids.has(local.report.id))) {
        waitFor(Math.max(Date.now() + 1, readCooldownUntil));
      }
      pending ||= (await listWithdrawals()).length > 0 ||
        remainingReports.some(local => !local.sync_error && (!isSynced(local) || unsentEvents(local).length > 0));
    } catch (error) {
      passFailed = true;
      healthyCheckRequested ||= checkHealthy;
      if (error instanceof DOMException && storageFailures.includes(error.name)) {
        onStorageError();
      }
      pending = true;
    } finally {
      currentStage = undefined;
      active = undefined;
      if (controller.signal.aborted && checkHealthy) healthyCheckRequested = true;
      if (!stopped && (pending || waitUntil || controller.signal.aborted || healthyCheckRequested) && document.visibilityState === 'visible' && navigator.onLine) {
        timer = setTimeout(() => void wake(false), healthyCheckRequested && !passFailed ? 1 : waitUntil ? Math.min(2_147_483_647, Math.max(1, waitUntil - Date.now())) : retryDelay(0));
      }
    }
  }

  return { wake, pause, stop() { stopped = true; pause(); } };
}

const presenceEvery = 60 * 60_000;
const storageFailures = ['QuotaExceededError', 'UnknownError', 'InvalidStateError'];

function requestSignal(parent: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  if (AbortSignal.any) return AbortSignal.any([parent, timeout]);
  const combined = new AbortController();
  const abort = () => {
    combined.abort(parent.aborted ? parent.reason : timeout.reason);
    parent.removeEventListener('abort', abort);
    timeout.removeEventListener('abort', abort);
  };
  if (parent.aborted) abort();
  else {
    parent.addEventListener('abort', abort, { once: true });
    timeout.addEventListener('abort', abort, { once: true });
  }
  return combined.signal;
}

function retryDelay(failures: number) {
  return Math.min(30_000, Math.round(1000 * 2 ** Math.min(failures, 5) * (0.8 + Math.random() * 0.4)));
}

function unsentEvents(local: LocalReport) {
  return (local.notices ?? []).flatMap(notice => [...notice.events, ...(notice.outcomes ?? [])])
    .filter(event => !event.synced && !event.refused);
}

function retryAt(response: Response, fallback = 60_000) {
  const now = Date.now();
  const retry = response.headers.get('retry-after');
  const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry ?? '') - now;
  return now + (Number.isFinite(delay) && delay > 0 ? delay : fallback);
}
