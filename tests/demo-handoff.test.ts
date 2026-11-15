import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer, loadConfigFromFile, type ViteDevServer } from 'vite';
import { resolveDemoTestRecipient, validateDemoApiOrigin } from '../src/lib/demo-policy.ts';
import type { NoticeLocal, NoticeParts, NoticeRuleSet } from '../src/lib/notice-composer.ts';
import { z } from 'zod';
import { noticeFragments } from '../src/lib/notice-fragments.ts';
import rule from '../data/rule-sets/2026-09-24-v2.json' with { type: 'json' };
import { noFileWatcher } from './helpers/no-file-watcher.ts';

const root = path.resolve(import.meta.dirname, '..');
const inbox = 'private-test@example.org';
const directory = z.object({ units: z.array(z.object({
  kind: z.literal('police'), id: z.string(), name: z.string(), email: z.string().nullable(), sourceUrl: z.string().nullable()
})) }).parse(JSON.parse(await readFile(path.join(root, 'data/authority-directory/police.json'), 'utf8')));
const authority = directory.units.find(unit => unit.email);
assert.ok(authority?.email);
const authorityEmail = authority.email;

async function withRecipient<T>(value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.VITE_DEMO_TEST_RECIPIENT;
  process.env.VITE_DEMO_TEST_RECIPIENT = value;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.VITE_DEMO_TEST_RECIPIENT;
    else process.env.VITE_DEMO_TEST_RECIPIENT = previous;
  }
}

async function withClient<T>(value: string, run: (server: ViteDevServer) => Promise<T>): Promise<T> {
  return withRecipient(value, async () => {
    const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), mode: 'staging',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true }, appType: 'custom', plugins: [noFileWatcher] });
    try { return await run(server); } finally { await server.close(); }
  });
}

const local: NoticeLocal = {
  report: { id: '351ad090-8888-4888-8888-888888888888', event_type: 'shot', captured_at: '2026-09-25T10:00:00Z',
    occurred_at: { at: '2026-09-25T09:00:00Z', source: 'device_clock', coarseness: 'exact' },
    device_fix: { lat: 52.12345, lon: 21.23456, accuracy_m: 12, at: '2026-09-25T10:00:00Z' },
    incident_location: { lat: 52.12345, lon: 21.23456, source: 'device_fix' },
    species: null, has_note: true, app_version: '0.1.0', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
  findings: { status: 'pending' }, photos: [{ id: 'local-photo' }],
  note: `Fikcyjny kontakt: ${authority.email}; mailto:${authority.email}?cc=other@example.net oraz mailto:${authority.email!.replace('@', '%40')}`
};
const input = { local, recipient: authority, others: [authority], variant: 'signed' as const,
  signed: { name: 'Jan Testowy', address: 'Fikcyjna 1' }, ruleSet: rule as NoticeRuleSet,
  fragments: noticeFragments, platform: 'android' as const };

function noAuthority(value: string) {
  assert.ok(!value.includes(authorityEmail), 'directory mailbox escaped into a handoff');
  assert.ok(!value.includes(authorityEmail.replace('@', '%40')), 'encoded directory mailbox escaped into a handoff');
  assert.ok(!value.includes('other@example.net'), 'secondary mailbox escaped into a handoff');
}

test('demo accepts exactly one mailbox only in staging and preserves its exact spelling', () => {
  for (const mode of ['production', 'development', 'test']) {
    assert.equal(resolveDemoTestRecipient(mode, undefined), undefined);
    assert.equal(resolveDemoTestRecipient(mode, ''), undefined);
    assert.throws(() => resolveDemoTestRecipient(mode, inbox), /requires --mode staging/);
  }
  assert.equal(resolveDemoTestRecipient('staging', 'Owner+test@Example.org'), 'Owner+test@Example.org');
  for (const value of [' ', ` ${inbox}`, `${inbox} `, `${inbox}\n`, `${inbox}\r\nBcc:other@example.net`,
    `mailto:${inbox}`, `Owner <${inbox}>`, `${inbox},other@example.net`, `${inbox};other@example.net`,
    `${inbox}?cc=other@example.net`, 'bad..dots@example.org', 'bad@-example.org', 'bad@example', 'bad@@example.org']) {
    assert.throws(() => resolveDemoTestRecipient('staging', value), /one literal email/);
  }
});

test('demo native origin must be a canonical HTTPS origin, never a URL with routing or credentials', () => {
  validateDemoApiOrigin('https://example.org');
  validateDemoApiOrigin('https://example.org:8443');
  for (const origin of [undefined, '', 'http://example.org', 'https://example.org/', 'https://example.org/api',
    'https://user:password@example.org', 'https://example.org?next=other', 'https://example.org#route']) {
    assert.throws(() => validateDemoApiOrigin(origin), /HTTPS/);
  }
});

test('actual Vite build configuration rejects demo recipient in production and malformed staging configuration', async () => {
  await withRecipient(inbox, async () => {
    await assert.rejects(() => loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(root, 'vite.config.ts'), root),
      /requires --mode staging/);
  });
  await withRecipient(`${inbox},other@example.net`, async () => {
    await assert.rejects(() => loadConfigFromFile({ command: 'build', mode: 'staging' }, path.join(root, 'vite.config.ts'), root),
      /one literal email/);
  });
});

test('actual Notice, mailto, copy/share text and PDF all keep authority names but only the test destination', async () => {
  let ordinary: NoticeParts | undefined;
  await withClient('', async server => {
    const { composeNotice } = await server.ssrLoadModule('/src/lib/notice-composer.ts');
    const { mailto } = await server.ssrLoadModule('/src/lib/mail-handoff.ts');
    const policy = await server.ssrLoadModule('/src/lib/demo-handoff.ts');
    ordinary = composeNotice(input);
    assert.equal(policy.handoffRecipient(authority.email), authority.email);
    assert.equal(policy.handoffRecipient(null), null);
    assert.equal(policy.handoffRecipient(undefined), undefined);
    assert.equal(policy.handoffText(local.note), local.note);
    assert.equal(policy.handoffNotice(ordinary), ordinary);
    assert.equal(policy.noticeFilename(authority), `powiadomienie-${authority.kind}-${authority.id}.pdf`);
    assert.equal(policy.photoFilename(0), 'zgloszenie-1.jpg');
    const normalMail = new URL(mailto(authority.email, 'Temat', 'Treść').href);
    assert.equal(normalMail.pathname, authority.email);
    assert.equal(normalMail.searchParams.get('subject'), 'Temat');
    assert.equal(normalMail.searchParams.get('body'), 'Treść');
    assert.ok(ordinary!.body.includes(local.note!));
  });
  await withClient(inbox, async server => {
    const { composeNotice } = await server.ssrLoadModule('/src/lib/notice-composer.ts');
    const { mailto, mailtoLimit } = await server.ssrLoadModule('/src/lib/mail-handoff.ts');
    const { noticePdf } = await server.ssrLoadModule('/src/lib/notice-pdf.ts');
    const policy = await server.ssrLoadModule('/src/lib/demo-handoff.ts');
    const notice = composeNotice(input) as NoticeParts;
    assert.equal(policy.handoffRecipient(authority.email), inbox);
    assert.equal(policy.handoffRecipient(null), inbox);
    assert.equal(policy.handoffRecipient(undefined), inbox);
    assert.equal(policy.noticeFilename(authority), 'test-powiadomienie.pdf');
    assert.equal(policy.photoFilename(0), 'test-zgloszenie-1.jpg');
    assert.equal(notice.subject, `[TEST] ${ordinary!.subject}`);
    assert.ok(notice.body.includes(authority.name));
    assert.ok(notice.body.includes(`Odbiorca testowy: ${inbox}`));
    assert.deepEqual(notice.fragmentIds, ordinary!.fragmentIds);
    for (const paragraph of ordinary!.body.split('\n\n').filter(line => !line.startsWith('Notatka zgłaszającego'))) {
      assert.ok(notice.body.includes(paragraph), paragraph);
    }
    assert.deepEqual(policy.handoffNotice(notice), notice, 'reapplying boundary policy must not duplicate test identity');
    noAuthority(JSON.stringify(notice));
    const mail = mailto(`${authority.email}?bcc=other@example.net`, notice.subject, notice.body);
    const url = new URL(mail.href);
    assert.equal(url.pathname, inbox);
    assert.equal(url.searchParams.get('cc'), null);
    assert.equal(url.searchParams.get('bcc'), null);
    assert.ok(url.searchParams.get('subject')!.startsWith('[TEST] '));
    noAuthority(decodeURIComponent(mail.href));
    const long = mailto(authority.email, notice.subject, `${local.note}\n`.repeat(200));
    assert.equal(long.withBody, false);
    assert.ok(long.href.length <= mailtoLimit);
    assert.equal(new URL(long.href).pathname, inbox);
    noAuthority(decodeURIComponent(long.href));

    const temporary = await mkdtemp(path.join(tmpdir(), 'bor-demo-pdf-'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array(await readFile(path.join(root, 'static/fonts/NotoSans-Regular.ttf'))));
    try {
      // The PDF boundary must protect even an old, unsanitized Notice and recipient name.
      const blob = await noticePdf({ ...authority, name: `${authority.name} ${authority.email}` }, ordinary!);
      const file = path.join(temporary, policy.noticeFilename(authority));
      await writeFile(file, new Uint8Array(await blob.arrayBuffer()));
      const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
      assert.ok(text.includes(authority.name));
      assert.ok(text.includes('[TEST]'));
      assert.ok(text.includes(inbox));
      noAuthority(text);
    } finally { globalThis.fetch = originalFetch; await rm(temporary, { recursive: true, force: true }); }
  });
});

