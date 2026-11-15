<script lang="ts">
  import { checkInEnabled } from '$lib/check-in';
  import { flushSync, onMount, tick } from 'svelte';
  import { prepareSensors, sessionFix, freshSessionFix } from '$lib/sensor-session';
  import brandSvg from '../../brand/symbol/symbol-white.svg?raw';
  import { addNotices, awaitingSignedNoticeReply, forgetHome, getHome, getSigner, isSynced, listDrafts, listReports, listWithdrawals, noticeState, signedNoticeCheckInAt,
    noticeFindings, recordNoticeEvent, recordNoticeOutcome, recordSync, rememberSigner, saveNoticePreparation, setHandoffQuestion, storageDenied, keepStorage, watchReportWithdrawals, withdrawReport, DraftClosedError, type LocalDraft, type LocalNotice, type LocalReport, type LocalWithdrawal, type NoticeRoute, type NoticeState } from '$lib/local-store';
  import { asksDirection, choosesPoint, defaultPointRadiusM, hearingDistance, radiusSteps, manualPoint, outgoingArea, placeOrigin, resolvedHome, withResolvedHome } from '$lib/home-area';
  import { draftReadiness, DraftValidationError, type DraftIssue } from '$lib/draft-readiness';
  import { createDraftEditing } from '$lib/draft-editing';
  import { draftPlaceWords, draftPrivacyLine, incidentAreaDescription, reportPlaceDetail, reportPlaceSentence, estimatedPlace } from '$lib/notice-location';
  import { composeNotice } from '$lib/notice-composer';
  import type { NoticeVariant, SignedDetails } from '$lib/notice-composer';
  import type { NoticeEvent, NoticeOutcome } from '$lib/notice-event';
  import { mailto } from '$lib/mail-handoff';
  import { demoTestRecipient, handoffRecipient, handoffText, noticeFilename, photoFilename } from '$lib/demo-handoff';
  import DemoNotice from '$lib/DemoNotice.svelte';
  import DemoAccess from '$lib/DemoAccess.svelte';
  // The one-colour symbol for a coloured ground. The inline copy drops its own title, because the button names it,
  // and takes the band's text colour, so each theme and forced colours decide the ink.
  const brandMark = brandSvg.replace(/<title[\s\S]*?<\/title>\s*/, '').replace(/ (?:width|height|role|aria-labelledby)="[^"]*"/g, '').replace('fill="#ffffff"', 'fill="currentColor"');
  import { apiFetch, apiUrl, nativeDemoAccessEnabled } from '$lib/api-url';
  import { askForReminders, isAndroidApp, openAndroidMail, openExactAlarmSetting, reconcileSignedNoticeCheckIns, saveLocalFile, syncReminders, watchAppState, watchAndroidBack, watchDraftReminderActions, type ReminderIssue } from '$lib/platform';
  import { createJourneyNavigation, type JourneyLocation, type JourneyScreen } from '$lib/journey-navigation';
  import { noticeFragments } from '$lib/notice-fragments';
  import { findingRuleSet, noticeRuleSet } from '$lib/notice-rule-set';
  import { createSyncWorker } from '$lib/sync';
  import { watchTheme } from '$lib/theme';
  import { icons } from '$lib/icons';
  import DirectionTarget from '$lib/DirectionTarget.svelte';
  import HourWheel from '$lib/HourWheel.svelte';
  import SpeciesChoice from '$lib/SpeciesChoice.svelte';
  import { disclosure, requestOpen } from '$lib/disclosure';
  import FindingsSummary from '$lib/FindingsSummary.svelte';
  import KeptArea from '$lib/KeptArea.svelte';
  import LocationPicker from '$lib/LocationPicker.svelte';
  import MapDisclosure from '$lib/MapDisclosure.svelte';
  let mapOpen = $state(false);
  import RecordLibrary, { type ReportRow } from '$lib/RecordLibrary.svelte';
  import { pendingWork, type Task } from '$lib/pending-work';
  import { followHeight, lineOut, reveal, textIn, textIn as receiptIn, textOut as receiptOut, unfold } from '$lib/reveal';
  import { warsawDate } from '$lib/time-findings';
  import './page.css';
  import { eventTypes } from '$lib/event-types';
  import type { DeviceFix, Findings, FindingsResult, Report } from '$lib/report';
  import { photoFromFile, photoFromImage, type LocalPhoto } from '$lib/photos';
  import { privacyPolicyUrl, termsOfUseUrl } from '$lib/legal/versions';
  import { translate, type Language } from '$lib/strings';
  import { directoryVersion, lookupRecipients, noticePlaces, type RecipientCatalog, type RecipientKind,
    type RecipientSuggestion, type RecipientUnit } from '$lib/recipient-resolver';
  import { loadRecipientCatalog } from '$lib/recipient-catalog';
  import { watchOfflineReadiness, type OfflineStatus } from '$lib/offline-readiness';

  const events = [
    ['Strzał', 'audio-lines', 'Dokończ zgłoszenie strzału'],
    ['Człowiek z bronią', 'user-round', 'Dokończ zgłoszenie człowieka z bronią'],
    ['Szczątki w lesie', 'bone', 'Dokończ zgłoszenie szczątków w lesie'],
    ['Ranne zwierzę', 'paw-print', 'Dokończ zgłoszenie rannego zwierzęcia'],
    ['Kłusownictwo', 'lasso', 'Dokończ zgłoszenie kłusownictwa']
  ];
  // Gdzie's direction target for each Event placed by direction: heading and instruction.
  const directionCopy: Record<number, [string, string]> = {
    0: ['Skąd słychać strzał?', 'Przeciągnij od siebie w stronę strzału albo skieruj tam telefon.'],
    1: ['Gdzie widzisz człowieka z bronią?', 'Przeciągnij od siebie w jego stronę albo skieruj tam telefon.'],
    3: ['Gdzie widzisz ranne zwierzę?', 'Przeciągnij od siebie w jego stronę albo skieruj tam telefon.'],
    4: ['Gdzie to widzisz?', 'Przeciągnij od siebie w tę stronę albo skieruj tam telefon. Jeśli jesteś na miejscu, pomiń.']
  };
  type Screen = JourneyScreen | 'loading';
  let screen = $state<Screen>('loading');
  let safetyShown = false;
  let showSafety = $state(false);
  let navigation: ReturnType<typeof createJourneyNavigation> | undefined;
  let restoration = 0;
  // What a slow start is opening, said only once it has taken 300 ms; a quick start never shows it.
  let startupLine = $state('');
  let displayVersion = 0;
  let refreshVersion = 0;
  let afterWelcome: JourneyLocation | undefined;
  let firstLaunch = $state(true);
  let preferenceError = $state('');
  let stopSensors: (() => void) | undefined;
  const preferenceFailure = 'Nie udało się zapamiętać ustawień. Przy następnym uruchomieniu aplikacja może zapytać o nie ponownie.';
  let language = $state<Language>('pl');
  let androidWeb = $state(false);
  const t = (value: string) => translate(language, value);
  function setLanguage(next: Language) {
    language = next;
    document.documentElement.lang = next;
    try { localStorage.setItem('interface-language', next); }
    catch { preferenceError = t(preferenceFailure); }
  }
  async function setWelcomeLanguage(next: Language, control: HTMLButtonElement) {
    setLanguage(next);
    await tick();
    if (screen === 'welcome' && document.activeElement === control)
      control.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  function finishWelcome(allowLocation: boolean) {
    if (!firstLaunch) return;
    firstLaunch = false;
    try { localStorage.setItem('first-launch-seen', '1'); }
    catch { preferenceError = t(preferenceFailure); }
    stopSensors = prepareSensors(theme);
    // The gesture starts the existing watch; opening capture never waits for its first fix.
    if (allowLocation) void sessionFix().catch(() => {});
    navigation?.navigate(afterWelcome?.screen === 'welcome' ? { screen: 'home' } : afterWelcome ?? { screen: 'home' }, true);
    afterWelcome = undefined;
  }
  let drafts = $state.raw<LocalDraft[]>([]);
  let reports = $state.raw<LocalReport[]>([]);
  let withdrawals = $state.raw<LocalWithdrawal[]>([]);
  let draft = $state.raw<LocalDraft>();
  let report = $state.raw<LocalReport>();
  let confirmingWithdrawal = $state(false);
  // The saved home's Usuń in Menu: its confirmation, and the result line that replaces the row.
  let confirmingHome = $state(false);
  let homeRemoved = $state(false);
  let homeRemoveButton = $state<HTMLButtonElement>();
  let homeCancel = $state<HTMLButtonElement>();
  // Bumped once the home is deleted, so a refresh that read it before then cannot bring it back.
  let homeVersion = 0;
  // The remembered signer details in Menu: read when Menu opens, deleted the same way as the home.
  let signerSaved = $state(false);
  let confirmingSigner = $state(false);
  let signerRemoved = $state(false);
  let signerRemoveButton = $state<HTMLButtonElement>();
  let signerCancel = $state<HTMLButtonElement>();
  let withdrawnReportId = $state<string>();
  let withdrawalButton = $state<HTMLButtonElement>();
  let withdrawalCancel = $state<HTMLButtonElement>();
  let findingRules = $derived(report?.findings.status === 'computed' ? findingRuleSet(report.findings.rule_set_id) : undefined);
  let homePreset = $state.raw<DeviceFix>();
  const draftIssues = $derived(draft ? draftReadiness(draft, homePreset) : []);
  // Saving on Sprawdź confirms the area shown there, so an unconfirmed area is never a step of its own.
  const blockingIssues = $derived(draftIssues.filter(issue => issue !== 'area'));
  const resolved = $derived(draft && withResolvedHome(draft, homePreset));
  // The area Sprawdź draws and saving confirms; null for a point or before the home question is answered.
  const keptArea = $derived(resolved && resolved.fromHome !== undefined ? outgoingArea(resolved) : null);
  const issueCopy: Record<DraftIssue, string> = {
    event: 'Wybierz rodzaj zdarzenia.', location: 'Wskaż miejsce na mapie.',
    home: 'Odpowiedz, czy jesteś w domu.', area: 'Sprawdź miejsce i zapisz zgłoszenie.',
    photo: 'Dodaj wymagane zdjęcie lub usuń nadmiar zdjęć.', details: 'Skróć notatkę do 500 znaków.',
    manual_point: 'Popraw współrzędne wskazanego miejsca.', near_home: 'Ten punkt jest przy zapisanym domu. Wskaż inne miejsce albo zaznacz, że to Twój dom.',
    moved_point: 'Jesteś przy zapisanym domu. Wskaż miejsce na mapie albo zaznacz, że to Twój dom.', occurrence: 'Popraw czas zdarzenia.'
  };
  const issueText = (issue: DraftIssue, item: LocalDraft) =>
    t(issue === 'photo' && item.eventType === 2 && !item.photos?.length ? 'Dodaj zdjęcie szczątków.'
      // An Event placed by direction has no map step, so the only safe answer at the saved home is the home one.
      : issue === 'moved_point' && asksDirection(item) ? 'Jesteś przy zapisanym domu. Zaznacz, że to Twój dom, żeby nie pokazać, gdzie mieszkasz.'
      : issue === 'home' ? 'Odpowiedz na pytanie o dom.'
      : issueCopy[issue]);
  // A change made from Sprawdź returns to Sprawdź instead of walking the remaining stages again.
  let editing = false;
  // Co opened by "Zmień" on Sprawdź is a plain step; every other arrival, Back included, is the
  // quick-capture receipt. Fixed on arrival, so leaving an edit never shows the receipt on its way out.
  let coIsReceipt = $state(false);
  let editingCo = false;
  // The Draft just captured: only its receipt says the Reporter can leave now, until it is reopened.
  // Kept through "Dokończę później", so the outgoing receipt does not lose a line under the transition.
  let freshCapture = $state<string>();
  const savedDrafts = new Set<string>();
  // Fixed when Gdzie opens, so a fix arriving meanwhile does not swap the map for the dial under the Reporter.
  const whereView = $derived(draft && !choosesPoint(draft) ? draft.eventType === 2 ? 'reporter' : 'compass' : 'map');
  // Problems are named beside their controls once the Reporter has tried to move on.
  let triedSave = $state(false);
  /** A press on a blocked primary marks its reason and the first thing blocking it, until the screen changes. */
  let blockedPress = $state(false);
  type Stage = 'choose-event' | 'when' | 'where' | 'details';
  const stageNames: Record<Stage, string> = { 'choose-event': 'Co', when: 'Kiedy', where: 'Gdzie', details: 'Sprawdź' };
  /** Gdzie is asked only when there is something to ask: a direction from the Reporter, or a place to point at. */
  function draftStages(item: LocalDraft): Stage[] {
    const where = asksDirection(item) || choosesPoint(item) || screen === 'where';
    return [...(item.quickCapture ? ['choose-event' as const] : []), 'when', ...(where ? ['where' as const] : []), 'details'];
  }
  /** Kiedy until it is answered, then the first stage with a missing fact, else Sprawdź. */
  function resumeScreen(item: LocalDraft): Stage {
    if (item.eventType === null) return 'choose-event';
    if (!item.occurredMode) return 'when';
    return draftReadiness(item, homePreset).includes('location') ? 'where' : 'details';
  }
  const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
  const distanceText = (metres: number) => metres < 1000 ? `${metres} m`
    : `${new Intl.NumberFormat(language === 'en' ? 'en-GB' : 'pl-PL', { maximumFractionDigits: 1 }).format(metres / 1000)} km`;
  function whenWords(item: LocalDraft) {
    const clock = new Date(item.capturedAt).toLocaleTimeString(language === 'en' ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
    if (item.occurredMode === 'within_hours') return fill(t('Około {hours} godz. przed {time}'), { hours: String(item.hoursAgo ?? 1), time: clock });
    if (item.occurredMode === 'date_only') return item.occurredDate && !draftIssues.includes('occurrence')
      ? `${t('Innego dnia')}, ${new Date(`${item.occurredDate}T12:00:00Z`).toLocaleDateString(language === 'en' ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'long' })}`
      : t('Innego dnia');
    return `${t('Teraz')}, ${clock}`;
  }
  let saving = $state(false);
  let mailOpening = $state(false);
  let fileSaving = $state(false);
  let reminderIssue = $state<ReminderIssue>();
  // The Menu switch "Przypomnienia o szkicach"; on unless the Reporter turned it off.
  let draftReminders = $state(true);
  // The Menu switch for the map under the Gdzie direction target; on unless the Reporter turned it off.
  let directionMap = $state(true);
  let followUpReminderIssue = $state(false);
  let clockNow = $state(Date.now());
  let error = $state('');
  /** Set once the local database proves newer than this code (a rollback); Moje zapisy says so above its list. */
  let newerDatabase = $state(false);
  let cameraDeniedDraft = $state<string>();
  let galleryRejectedDraft = $state<string>();
  let galleryFeedbackRequest = 0;
  let locationError = $state('');
  // Location was refused, so trying again cannot help.
  let locationDenied = $state(false);
  // The Draft whose background location attempt is still running.
  let locating = $state<string>();
  let storageWarning = $state(false);
  // The browser refuses this site storage: nothing can be saved until the Reporter allows it.
  let storageBlocked = $state(false);
  let online = $state(true);
  let announcement = $state('');
  let confirmingDelete = $state<string>();
  // A confirmation belongs to the visit to Moje zapisy that opened it.
  $effect(() => { if (screen !== 'library') confirmingDelete = undefined; });
  let library = $state<ReturnType<typeof RecordLibrary>>();
  let request = 0;
  let themeWatch: ReturnType<typeof watchTheme> | undefined;
  let currentTransition: ViewTransition | undefined;
  let sync: ReturnType<typeof createSyncWorker> | undefined;
  const draftEdits = createDraftEditing({ failed: cause => storageError(cause), changed: next => {
    if (draft?.id === next.id) draft = next;
    drafts = drafts.map(item => item.id === next.id ? next : item);
  } });
  let camera: MediaStream | undefined;
  let cameraOpening = $state(false);
  let takingPhoto = $state(false);
  let cameraVideo = $state<HTMLVideoElement>();
  let photoUrls = $state<Record<string, string>>({});
  let recipientChoices = $state.raw<{ unit: RecipientUnit; selected: boolean }[]>([]);
  let recipientSuggestion = $state.raw<RecipientSuggestion>();
  // Undefined uses the geometry proposal; null explicitly leaves the Notice gmina unknown.
  let gminaAnswer = $state<string | null>();
  let gminaCorrection = $state.raw<RecipientUnit>();
  let placeSearchOpen = $state(false);
  let placeQuery = $state('');
  let placeSearchInput = $state<HTMLInputElement>();
  let placeChangeButton = $state<HTMLButtonElement>();
  let recipientFallback = $state(false);
  /** Outside coverage nothing is suggested, so name search moves up under the status sentence. */
  let recipientSearchFirst = $state(false);
  let recipientSearchInput = $state<HTMLInputElement>();
  let recipientIssue = $state<'offline' | 'unavailable' | 'unresolved'>();
  const recipientsOffline = $derived(!online || recipientIssue === 'offline');
  const recipientsDeferred = $derived(recipientsOffline || recipientIssue === 'unavailable');
  let recipientBusy = $state(false);
  let recipientCatalog = $state.raw<RecipientCatalog>();
  let catalogMissing = $state(false);
  let offlineStatus = $state<OfflineStatus>();
  let offlineReadiness: ReturnType<typeof watchOfflineReadiness> | undefined;
  let offlinePreparationPending = false;
  const pdfOffline = $derived(!online && offlineStatus?.pdf !== 'ready');
  let appUpdate = $state(false);
  let restarting = $state(false);
  const oldVersionCopy = 'Ta karta działa w starszej wersji aplikacji i nie może zapisać zmian. Uruchom nową wersję. Zapisane dane zostaną na telefonie.';
  const storageBlockedCopy = 'Przeglądarka blokuje zapis danych. Odblokuj go w ustawieniach witryny.';
  // What a failed write says: no space, an older tab, anything else.
  const storageFailureCopy = ['Brak miejsca na urządzeniu. Zwolnij miejsce i spróbuj ponownie.', oldVersionCopy, 'Nie udało się zapisać danych na urządzeniu. Spróbuj ponownie.'];
  const pdfLoadCopy = 'Nie udało się wczytać plików PDF. Uruchom aplikację ponownie i spróbuj jeszcze raz. Zapisane dane zostaną na telefonie.';
  // Screens where nothing is being entered or handed off, so a restart costs the Reporter nothing.
  const restingScreen = $derived(screen === 'home' || screen === 'library');
  let recipientSearchKind = $state<RecipientKind>('police');
  let recipientQuery = $state('');
  let noticeVariant = $state<NoticeVariant>();
  let signer = $state<SignedDetails>({ name: '', address: '', phone: '' });
  let signerForReport: string | undefined;
  let rememberDetails = $state(false);
  // Signed details live in memory per Notice unless the Reporter asked this phone to remember them.
  let signedByNotice = $state<Record<string, SignedDetails>>({});
  let noticeId = $state<string>();
  let outcomeCode = $state<NoticeOutcome['outcome']>();
  let outcomeDate = $state('');
  // A Signed Notice with a verified email can be filed as a PDF instead. Email stays its approved
  // primary, so the choice lasts this visit unless a saved PDF already raised the handoff question.
  let pdfChosen = $state<Record<string, boolean>>({});
  // The check-in shows its saved answer until the Reporter asks to change it or its date.
  let checkInChanging = $state(false);
  let checkInDateOpen = $state(false);
  let checkInSaved = $state(false);
  let flaggingAddress = $state(false);
  let flaggedAddresses = $state<Record<string, boolean>>({});
  let needsSignerEntry = $state<Record<string, boolean>>({});
  let recipientRequest = 0;
  let recipientForReport: string | undefined;
  const work = $derived(pendingWork(drafts, reports, withdrawals, clockNow));
  const homeTask = $derived(work.tasks.find(task => task.kind === 'draft' && task.id === cameraDeniedDraft) ?? work.tasks[0]);
  const taskCount = $derived(work.tasks.filter(task => !(task.kind === 'draft' && task.id === draft?.id
    && ['choose-event', 'when', 'where', 'details', 'camera'].includes(screen))).length);
  const queuedUploads = $derived(work.automatic.filter(item => item.kind === 'upload').length);
  const selectedRecipients = $derived(recipientChoices.filter(choice => choice.selected));
  const recipientPlaces = $derived(noticePlaces(recipientSuggestion, gminaAnswer, gminaCorrection));
  const selectedGmina = $derived(gminaAnswer === null ? undefined : gminaCorrection ?? recipientSuggestion?.gminy.find(unit =>
    gminaAnswer === undefined ? recipientSuggestion?.gminy.length === 1 : unit.id === gminaAnswer));
  const placeResults = $derived(recipientCatalog?.searchUnits('gmina', placeQuery) ?? { units: [], total: 0 });
  const gminaUnanswered = $derived(!!recipientSuggestion?.gminaQuestion && gminaAnswer === undefined);
  const recipientResults = $derived(recipientCatalog?.searchUnits(recipientSearchKind, recipientQuery) ?? { units: [], total: 0 });
  const suggestedKeys = $derived(new Set(recipientSuggestion?.roles.flatMap(role => role.units.map(unit => `${unit.kind}:${unit.id}`)) ?? []));
  const signedReady = (details?: SignedDetails) => !!details?.name.trim() && !!details.address.trim();
  const recipientReason = $derived(gminaUnanswered ? 'gmina' : !recipientsDeferred && !selectedRecipients.length ? 'select' : undefined);
  const signatureBlocked = $derived(noticeVariant === 'signed' && !signedReady(signer));
  const currentNotice = $derived(report?.notices?.find(item => item.id === noticeId));
  /** One handoff route per Notice: mail with a verified email, else a PDF when signed, else copied text. */
  function noticeRoute(notice: LocalNotice): NoticeRoute {
    if (handoffRecipient(notice.recipient.email) && !pdfChosen[notice.id] && !(notice.askHandoff && notice.handoffRoute === 'pdf')) return 'mail';
    return notice.variant === 'signed' ? 'pdf' : 'copy';
  }
  const nextNotice = $derived(report?.notices?.find(item => item.id !== noticeId && noticeState(item) !== 'confirmed_by_reporter'));
  const answeredCheckIn = $derived(currentNotice?.outcomes?.at(-1));
  function composeFor(notice: LocalNotice, platform: 'web' | 'android' = 'web') {
    if (!report || (notice.variant === 'signed' && !signedReady(signedByNotice[notice.id]))) return undefined;
    try {
      const findings = noticeFindings(report, notice);
      return composeNotice({ local: { ...report, findings }, recipient: notice.recipient, others: notice.others, places: notice.places,
        variant: notice.variant, signed: notice.variant === 'signed' ? signedByNotice[notice.id] : undefined,
        ruleSet: noticeRuleSet(report.report, findings), fragments: noticeFragments, platform });
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'unknown_notice_rule_set') return undefined;
      throw cause;
    }
  }
  const noticeText = $derived(currentNotice && composeFor(currentNotice, isAndroidApp ? 'android' : 'web'));
  const pdfText = $derived(currentNotice?.variant === 'signed' ? composeFor(currentNotice) : undefined);
  const currentRecipient = $derived(currentNotice && handoffRecipient(currentNotice.recipient.email));
  const handoff = $derived(currentRecipient && noticeText
    ? mailto(currentRecipient, noticeText.subject, noticeText.body) : undefined);
  const offlineSummary = $derived.by(() => {
    if (!offlineStatus) return 'Sprawdzam, czy aplikacja działa bez internetu…';
    if (offlineStatus.shell === 'missing') return 'Aplikacja otworzy się tylko z internetem';
    if (offlineStatus.shell === 'loading') return 'Pobieram pliki do pracy bez internetu…';
    if (offlineStatus.catalog === 'missing' || offlineStatus.pdf === 'missing') {
      if (offlineStatus.catalog !== 'ready' && offlineStatus.pdf !== 'ready') return 'Bez internetu nie zadziałają katalog urzędów i PDF';
      return offlineStatus.catalog !== 'ready' ? 'Bez internetu nie zadziała katalog urzędów' : 'Bez internetu nie zadziała PDF';
    }
    if (offlineStatus.catalog === 'loading' || offlineStatus.pdf === 'loading') return 'Pobieram pliki do pracy bez internetu…';
    return 'Gotowe do pracy bez internetu';
  });
  const offlineReady = $derived(!!offlineStatus && Object.values(offlineStatus).every(state => state === 'ready'));
  const offlineMissing = $derived(!!offlineStatus && Object.values(offlineStatus).includes('missing'));
  const noticeStates: Record<NoticeState, string> = {
    not_notified: 'Gotowe do przejrzenia',
    handed_to_mail_client: 'Otwarto pocztę',
    confirmed_by_reporter: 'Przekazanie potwierdzone przez Ciebie'
  };
  const outcomeLabels: Record<NoticeOutcome['outcome'], string> = {
    reply: 'Przyszła odpowiedź', proceedings_opened: 'Wszczęto postępowanie',
    refusal: 'Odmowa', no_answer_yet: 'Jeszcze bez odpowiedzi'
  };
  const checkInAnswers: [NoticeOutcome['outcome'], string][] = [
    ['reply', 'Przyszła odpowiedź'], ['proceedings_opened', 'Wszczęto postępowanie'], ['refusal', 'Odmowa'], ['no_answer_yet', 'Jeszcze nie']
  ];
  // Komenda, Straż, Regionalna Dyrekcja and the two "Gmina …" offices take the feminine verb; Urząd and Park the masculine.
  const repliedQuestion = (unit: RecipientUnit) => fill(t(/^(Komenda|Państwowa|Regionalna|Gmina|Dyrekcja)\b/.test(unit.name)
    ? 'Czy {name} odpowiedziała?' : 'Czy {name} odpowiedział?'), { name: unit.name });
  /** "2 października", with the year only when it is not this year. */
  const shortDay = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString(language === 'en' ? 'en-GB' : 'pl-PL',
    { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'long', ...(value.slice(0, 4) === warsawDate(new Date()).slice(0, 4) ? {} : { year: 'numeric' }) });
  const day = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString(language === 'en' ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'long', year: 'numeric' });
  const recipientKinds: [RecipientKind, string][] = [
    ['police', 'Policja'], ['psl', 'Państwowa Straż Łowiecka'],
    ['nationalPark', 'Park narodowy'], ['rdos', 'RDOŚ'], ['gmina', 'Gmina']
  ];
  const kindLabel = (kind: RecipientKind) => t(recipientKinds.find(([value]) => value === kind)![1]);
  const jstTypes: Record<NonNullable<RecipientUnit['jstType']>, string> = {
    GW: 'gmina wiejska', GMW: 'gmina miejsko-wiejska', GM: 'gmina miejska', MNP: 'miasto na prawach powiatu'
  };
  /** Type, powiat and województwo tell apart gminy that share a locality name. */
  function gminaDetail(unit: RecipientUnit) {
    if (!unit.jstType) return '';
    return [t(jstTypes[unit.jstType]), unit.powiat ? `${t('powiat')} ${unit.powiat}` : '',
      unit.voivodeship ? `${t('woj.')} ${unit.voivodeship}` : ''].filter(Boolean).join(' · ');
  }
  function unitDetail(unit: RecipientUnit) {
    return [kindLabel(unit.kind), unit.kind === 'gmina' ? t('informacyjnie') : '', gminaDetail(unit)].filter(Boolean).join(' · ');
  }

  let preparationSave = Promise.resolve();
  let preparationPending = $state(0);
  function restorePreparation() {
    if (!report || recipientForReport === report.report.id) return;
    recipientRequest++;
    recipientBusy = false;
    recipientForReport = report.report.id;
    const saved = report.noticePreparation;
    recipientChoices = saved?.choices ?? [];
    recipientSuggestion = saved?.suggestion;
    gminaAnswer = saved?.gminaAnswer;
    gminaCorrection = saved?.gminaCorrection;
    placeSearchOpen = false;
    placeQuery = '';
    noticeVariant = saved?.variant;
    signer = { name: '', address: '', phone: '' };
    signerForReport = undefined;
    rememberDetails = false;
    recipientIssue = recipientSuggestion?.incomplete ? 'unresolved' : undefined;
    recipientFallback = false;
    recipientSearchFirst = false;
    recipientQuery = '';
    catalogMissing = false;
  }
  function keepPreparation() {
    if (!report) return Promise.resolve();
    const id = report.report.id;
    // Identity is never part of preparation storage. Only remembered signer details survive restart.
    const preparation = JSON.parse(JSON.stringify({ choices: recipientChoices, suggestion: recipientSuggestion,
      gminaAnswer, gminaCorrection, variant: noticeVariant })) as LocalReport['noticePreparation'];
    preparationPending++;
    preparationSave = preparationSave.catch(() => {}).then(() => saveNoticePreparation(id, preparation))
      .finally(() => preparationPending--);
    void preparationSave.catch(storageError);
    return preparationSave;
  }
  async function chooseGmina(value: string | null | undefined, correction?: RecipientUnit, returnFocus = false) {
    gminaAnswer = value;
    gminaCorrection = correction;
    placeSearchOpen = false;
    void keepPreparation();
    await tick();
    if (returnFocus) placeChangeButton?.focus({ preventScroll: true });
  }
  async function openPlaceSearch() {
    placeSearchOpen = true;
    placeQuery = '';
    await tick();
    placeSearchInput?.focus();
  }
  function chooseSignature(value: NoticeVariant) { noticeVariant = value; void keepPreparation(); }
  async function loadRecipients() {
    if (!report) return;
    const id = report.report.id;
    const location = report.report.incident_location;
    restorePreparation();
    recipientRequest++;
    const requestId = recipientRequest;
    // Not the screen: display() switches it inside a view transition, after a fast failure can land.
    const stale = () => requestId !== recipientRequest || report?.report.id !== id;
    catalogMissing = false;
    recipientIssue = navigator.onLine ? undefined : 'offline';
    recipientFallback = false;
    recipientBusy = !recipientsOffline;
    const lookup = recipientIssue === 'offline' ? undefined : lookupRecipients(location);
    lookup?.catch(() => {});
    try {
      recipientCatalog ??= await loadRecipientCatalog();
      if (!lookup || stale()) return;
      const suggestion = recipientCatalog.recipientSuggestions(await lookup);
      if (stale()) return;
      recipientSuggestion = suggestion;
      const existing = new Map(recipientChoices.map(choice => [`${choice.unit.kind}:${choice.unit.id}`, choice]));
      recipientChoices = [...recipientChoices, ...suggestion.roles.flatMap(role => role.units)
        .filter(unit => !existing.has(`${unit.kind}:${unit.id}`))
        .map(unit => ({ unit, selected: suggestion.proposed.includes(unit) }))];
      await keepPreparation();
      if (stale()) return;
      recipientIssue = suggestion.incomplete || !suggestion.roles.length ? 'unresolved' : undefined;
      // Only a search the Reporter has not opened yet may move; an open one keeps its place and input.
      recipientSearchFirst = !recipientFallback && recipientIssue === 'unresolved' && !suggestion.roles.length;
      recipientFallback ||= recipientIssue === 'unresolved' && !recipientSearchFirst;
    } catch {
      if (stale()) return;
      // Without the catalog neither suggestions nor search can name a unit.
      if (recipientCatalog) recipientIssue = navigator.onLine ? 'unavailable' : 'offline';
      else catalogMissing = true;
    } finally {
      if (requestId === recipientRequest) recipientBusy = false;
    }
  }
  function openRecipients() {
    if (!report) return;
    restorePreparation();
    show('recipients');
  }

  async function openRecipientSearch() {
    recipientFallback = true;
    recipientQuery = '';
    await tick();
    recipientSearchInput?.focus({ preventScroll: true });
    if (still()) showRecipientSearchFocus();
  }

  function showRecipientSearchFocus() {
    if (recipientSearchInput && document.activeElement === recipientSearchInput) {
      recipientSearchInput.scrollIntoView({ block: 'nearest', behavior: still() ? 'instant' : 'smooth' });
    }
  }

  function toggleRecipient(unit: RecipientUnit) {
    const key = `${unit.kind}:${unit.id}`;
    const existing = recipientChoices.find(choice => `${choice.unit.kind}:${choice.unit.id}` === key);
    recipientChoices = existing
      ? recipientChoices.map(choice => choice === existing ? { ...choice, selected: !choice.selected } : choice)
      : [...recipientChoices, { unit, selected: true }];
    void keepPreparation();
  }
  async function loadSigner() {
    const id = report?.report.id;
    if (!id || signerForReport === id) return;
    let remembered: SignedDetails | undefined;
    try { remembered = await getSigner(); } catch { storageError(); }
    if (report?.report.id !== id) return;
    signerForReport = id;
    if (!signer.name && !signer.address && !signer.phone) {
      signer = { name: '', address: '', phone: '', ...remembered };
      rememberDetails = !!remembered;
    }
  }
  /** Moves focus to the control that blocks a primary. It scrolls into view smoothly, and only if it is out of view. */
  function focusBlocking(target: HTMLElement | null | undefined) {
    blockedPress = true;
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  function blockedRecipients() {
    focusBlocking(recipientReason === 'gmina' ? document.querySelector<HTMLElement>('.screen-body .incident-gmina input')
      : [...document.querySelectorAll<HTMLElement>('.screen-body .recipient-choice input')].find(input => input.checkVisibility())
        // With no suggested office there is nothing to tick, so the way to add one gets the focus.
        ?? (recipientSearchInput?.checkVisibility() ? recipientSearchInput : document.querySelector<HTMLElement>('#recipient-search-open')));
  }
  function blockedSignature() {
    focusBlocking([...document.querySelectorAll<HTMLInputElement>('.screen-body .signature-fields input')].slice(0, 2).find(input => !input.value.trim()));
  }
  async function openSignature() {
    if (!selectedRecipients.length || gminaUnanswered || catalogMissing) return;
    try { await keepPreparation(); } catch { return; }
    await loadSigner();
    show('signature');
  }
  function noticeEvent(notice: LocalNotice, kind: NoticeEvent['kind']): NoticeEvent {
    return { id: crypto.randomUUID(), kind, notice_id: notice.id, recipient_kind: notice.recipient.kind, unit_id: notice.recipient.id,
      template_version: noticeFragments.version, directory_version: directoryVersion, at: new Date().toISOString() };
  }
  async function prepareNotices() {
    if (!report || !noticeVariant || !selectedRecipients.length || gminaUnanswered || (noticeVariant === 'signed' && !signedReady(signer)) || saving) return;
    saving = true;
    const units = selectedRecipients.map(choice => choice.unit);
    const notices: LocalNotice[] = units.map(unit => ({
      id: crypto.randomUUID(), recipient: unit, others: units.filter(other => other !== unit),
      places: recipientPlaces, variant: noticeVariant!, events: []
    }));
    for (const notice of notices) notice.events.push(noticeEvent(notice, 'notice_composed'));
    try {
      await preparationSave;
      if (noticeVariant === 'signed') {
        const details = { name: signer.name.trim(), address: signer.address.trim(), ...(signer.phone?.trim() ? { phone: signer.phone.trim() } : {}) };
        await rememberSigner(rememberDetails ? details : undefined);
        signerSaved = rememberDetails;
      }
      const prepared = await addNotices(report.report.id, notices);
      if (noticeVariant === 'signed') signedByNotice = { ...signedByNotice, ...Object.fromEntries(prepared.map(notice =>
        [notice.id, { name: signer.name.trim(), address: signer.address.trim(), phone: signer.phone?.trim() }])) };
      await refresh();
      await prepareNoticeState(prepared[0]);
      show('notice', '', true);
      announcement = t('Przygotowano osobne powiadomienia.');
      void sync?.wake();
    } catch { storageError(); }
    finally { saving = false; }
  }
  async function prepareNoticeState(notice: LocalNotice) {
    noticeId = notice.id;
    outcomeCode = undefined;
    outcomeDate = warsawDate(new Date());
    if (notice.variant === 'signed' && !signedByNotice[notice.id]) {
      let remembered: SignedDetails | undefined;
      try { remembered = await getSigner(); } catch { storageError(); }
      signedByNotice = { ...signedByNotice, [notice.id]: { name: '', address: '', phone: '', ...remembered } };
      needsSignerEntry = { ...needsSignerEntry, [notice.id]: !signedReady(remembered) };
    }
  }
  async function openNotice(notice: LocalNotice) {
    await prepareNoticeState(notice);
    show('notice');
  }
  /** `used` is the Findings the handed-off text was composed from, taken when it was composed. */
  async function noticeStep(notice: LocalNotice, kind: NoticeEvent['kind'] | 'not_yet', used?: FindingsResult) {
    if (!report) return;
    try {
      if (kind === 'not_yet') await setHandoffQuestion(report.report.id, notice.id, false);
      else await recordNoticeEvent(report.report.id, notice.id, noticeEvent(notice, kind), used);
      await refresh();
      if (kind === 'handed_to_mail_client') await focusHandoff(notice.id);
      if (kind === 'confirmed_by_reporter') {
        void updateCheckIns();
        confirmSaved(t('Zapisano Twoje potwierdzenie. To nie jest potwierdzenie doręczenia.'));
      }
      void sync?.wake();
    } catch { storageError(); }
  }
  async function focusHandoff(id: string) {
    await tick();
    await currentTransition?.finished.catch(() => {});
    if (screen !== 'notice' || currentNotice?.id !== id || !currentNotice.askHandoff) return;
    const heading = document.getElementById('handoff-question');
    heading?.focus({ preventScroll: true });
    const body = document.querySelector<HTMLElement>('.screen-body');
    if (heading && body) body.scrollTo({
      top: body.scrollTop + heading.getBoundingClientRect().top - body.getBoundingClientRect().top - 12,
      behavior: still() ? 'instant' : 'smooth'
    });
  }
  async function handoffWeb(event: MouseEvent, notice: LocalNotice) {
    if (!handoff || !noticeText || !report) return;
    const used = noticeFindings(report, notice);
    if (!handoff.withBody) {
      event.preventDefault();
      const href = handoff.href;
      // Start the clipboard write inside the tap, before storage or navigation can consume activation.
      if (!await copy(noticeText.body, 'Treść jest w schowku. Wklej ją do wiadomości.')) return;
      window.location.href = href;
      confirmSaved(t('Treść jest w schowku. Wklej ją do wiadomości.'));
    }
    await noticeStep(notice, 'handed_to_mail_client', used);
  }
  async function recordOutcome(notice: LocalNotice, code: NoticeOutcome['outcome'] | undefined, observedOn: string) {
    if (!report || !code || !/^\d{4}-\d{2}-\d{2}$/.test(observedOn) || observedOn > warsawDate(new Date()) ||
      noticeState(notice) !== 'confirmed_by_reporter' || saving) return false;
    saving = true;
    const outcome: NoticeOutcome = { id: crypto.randomUUID(), kind: 'outcome_reported', notice_id: notice.id,
      recipient_kind: notice.recipient.kind, unit_id: notice.recipient.id, outcome: code,
      observed_on: observedOn, at: new Date().toISOString() };
    try {
      await recordNoticeOutcome(report.report.id, notice.id, outcome);
      await refresh();
      void updateCheckIns();
      void sync?.wake();
      return true;
    } catch { storageError(); return false; }
    finally { saving = false; }
  }
  async function saveOutcome(notice: LocalNotice) {
    if (!await recordOutcome(notice, outcomeCode, outcomeDate)) return;
    outcomeCode = undefined;
    confirmSaved(t('Zapisano zgłoszony przez Ciebie wynik.'));
  }
  /** One tap answers the check-in, dated today; a later date or answer is a correction in the same history. */
  async function answerCheckIn(notice: LocalNotice, code: NoticeOutcome['outcome'], observedOn = warsawDate(new Date())) {
    if (!await recordOutcome(notice, code, observedOn) || screen !== 'check-in' || noticeId !== notice.id) return;
    checkInChanging = false;
    checkInDateOpen = false;
    checkInSaved = true;
    announcement = t(code === 'no_answer_yet' ? 'Zapisano. Zapytamy znowu za sześć tygodni.' : 'Zapisano zgłoszony przez Ciebie wynik.');
    await tick();
    document.querySelector<HTMLElement>('#check-in-saved')?.focus({ preventScroll: true });
  }
  async function openCheckIn(item: LocalReport, notice: LocalNotice) {
    report = item;
    await prepareNoticeState(notice);
    show('check-in');
  }
  /** A save says it worked: briefly, floating above the footer, read once by the live region. */
  let confirmation = $state<{ id: number; text: string }>();
  let confirmationBottom = $state(0);
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmationFrame = 0;
  let confirmationRequest = 0;
  function confirmSaved(text: string) {
    announcement = text;
    clearTimeout(confirmationTimer);
    cancelAnimationFrame(confirmationFrame);
    // Above whichever footer the saved state ends on, once a screen change has put it there; the screen
    // under it never moves.
    const shown = ++confirmationRequest;
    void (currentTransition?.updateCallbackDone.catch(() => {}) ?? Promise.resolve()).then(() => {
      if (shown !== confirmationRequest) return;
      confirmationFrame = requestAnimationFrame(() => {
        confirmationBottom = (document.querySelector<HTMLElement>('.screen-foot')?.offsetHeight ?? 0) + 12;
        confirmation = { id: (confirmation?.id ?? 0) + 1, text };
        confirmationTimer = setTimeout(() => { confirmation = undefined; }, 4000);
      });
    });
  }
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Fades and rises in over 240 ms, out over 220 ms; with reduced motion it appears and goes without moving.
  const briefIn = (_node: Element) => ({ duration: still() ? 0 : 240, easing: (x: number) => 1 - (1 - x) ** 3,
    css: (x: number) => `opacity: ${x}; transform: translateY(${(1 - x) * 10}px)` });
  const briefOut = (_node: Element) => ({ duration: still() ? 0 : 220,
    css: (x: number) => `opacity: ${x}; transform: translateY(${(1 - x) * 6}px)` });
  async function flagAddress(notice: LocalNotice) {
    if (flaggingAddress || flaggedAddresses[notice.id] || noticeState(notice) === 'not_notified') return;
    flaggingAddress = true;
    error = '';
    try {
      const response = await apiFetch('/api/recipient-address-flags', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: notice.recipient.kind, unit_id: notice.recipient.id })
      });
      if (!response.ok) throw new Error('address_flag_failed');
      flaggedAddresses = { ...flaggedAddresses, [notice.id]: true };
      announcement = t('Zapisano sygnał o adresie. Sprawdzimy go przed zmianą katalogu.');
    } catch { error = t('Nie udało się zgłosić adresu. Spróbuj ponownie, gdy masz połączenie.'); }
    finally { flaggingAddress = false; }
  }
  let geodataDownloading = $state(false);
  let geodataError = $state('');
  async function downloadDemoGeodata(snapshot: string) {
    if (geodataDownloading || !/^[a-z0-9-]{1,80}$/.test(snapshot)) return;
    geodataDownloading = true;
    if (error === geodataError) error = '';
    geodataError = '';
    try {
      const response = await apiFetch(`/api/geodata/${snapshot}/ambony`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('geodata_unavailable');
      const blob = await response.blob();
      if (!blob.type.startsWith('application/geo+json-seq')) throw new Error('geodata_unavailable');
      await saveLocalFile(blob.slice(0, blob.size, 'application/geo+json-seq'), `osm-stands-${snapshot}.geojsonseq`);
    } catch { geodataError = error = t('Nie udało się pobrać zbioru ambon. Sprawdź połączenie i kod zaproszenia w Menu.'); }
    finally { geodataDownloading = false; }
  }
  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      announcement = t(done);
      return true;
    } catch {
      error = t('Nie udało się skopiować. Zaznacz tekst i skopiuj go ręcznie.');
      return false;
    }
  }
  /** Without an address the copied text is the handoff, so the question follows it. */
  async function copyHandoff(notice: LocalNotice, body: string) {
    if (!report) return;
    const used = noticeFindings(report, notice);
    if (!await copy(body, 'Treść skopiowana.')) return;
    try { await setHandoffQuestion(report.report.id, notice.id, true, 'copy', used); await refresh(); await focusHandoff(notice.id); }
    catch { storageError(); }
  }
  function photoFiles(photos: LocalPhoto[]) {
    return photos.map((photo, index) => new File([photo.jpeg], photoFilename(index), { type: 'image/jpeg' }));
  }
  function canSharePhotos(photos: LocalPhoto[]) {
    if (!photos.length || typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
    try { return navigator.canShare({ files: photoFiles(photos) }); }
    catch { return false; }
  }
  async function sharePhotos(notice: LocalNotice, photos: LocalPhoto[]) {
    error = '';
    const text = composeFor(notice, 'android');
    if (!text) return;
    try { await navigator.share({ files: photoFiles(photos), title: text.subject, text: text.body }); }
    catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      error = t('Nie udało się udostępnić zdjęć. Spróbuj ponownie albo pobierz je na urządzenie.');
    }
  }
  async function handoffAndroid(notice: LocalNotice) {
    const recipient = handoffRecipient(notice.recipient.email);
    if (!recipient || mailOpening) return;
    const text = composeFor(notice, 'android');
    if (!text || !report) return;
    const used = noticeFindings(report, notice);
    mailOpening = true;
    error = '';
    try {
      await openAndroidMail(recipient, text.subject, text.body, report?.photos ?? []);
      await noticeStep(notice, 'handed_to_mail_client', used);
    } catch { error = t('Nie udało się otworzyć poczty. Spróbuj ponownie lub skopiuj treść.'); }
    finally { mailOpening = false; }
  }
  /** A reminder says what one Draft still needs, or how many wait, in the words of the home task row. */
  function reminderText(list: LocalDraft[], draftIds: string[]) {
    const waiting = list.filter(item => draftIds.includes(item.id));
    // A reminder names the step by its screen only. A missing fact on Sprawdź (a photo, the home question)
    // could read a day later as going back to the place, which hard rule 9 forbids.
    if (waiting.length === 1) return { title: taskCopy({ kind: 'draft', item: waiting[0] } as Task).title,
      body: `${t('Dalej:')} ${resumeScreen(waiting[0]) === 'details' ? t('Sprawdź i zapisz') : draftStep(waiting[0])}` };
    return { title: fill(t('Szkice do dokończenia: {count}'), { count: String(draftIds.length) }), body: t('Wybierz w Moich zapisach, od którego zacząć.') };
  }
  let reminderSync = Promise.resolve();
  let draftsLoaded: () => void;
  // A reminder tapped while the app was closed waits for the Drafts and the first screen.
  const startup = new Promise<void>(resolve => { draftsLoaded = resolve; });
  /** Runs one reconciliation at a time, each against the Drafts as they are when it starts. */
  function updateReminders() {
    reminderSync = reminderSync.then(async () => {
      try {
        // Read from storage, not the screen's list: a refresh that started earlier can land later.
        // A Draft changed this session is named by its newest copy, unsaved edits included.
        const list = (await listDrafts()).filter(item => !draftEdits.isClosed(item.id)).map(item => draftEdits.current(item.id) ?? item);
        reminderIssue = await syncReminders(list, draftReminders, ids => reminderText(list, ids), { finish: t('Dokończ'), stop: t('Nie przypominaj') });
      }
      catch { reminderIssue = 'notifications'; }
    });
    return reminderSync;
  }
  async function turnOnExactReminders() {
    try { await openExactAlarmSetting(); } catch { /* the advice stays */ }
    await updateReminders();
  }
  async function retryReminders() {
    try { await askForReminders(); } catch { /* the note stays */ }
    await updateReminders();
  }
  async function setDraftReminders(on: boolean) {
    draftReminders = on;
    try { localStorage.setItem('draft-reminders', on ? 'on' : 'off'); } catch { /* kept for this session */ }
    if (on) { try { await askForReminders(); } catch { /* the note says so */ } }
    await updateReminders();
    confirmSaved(t(on ? 'Przypomnienia o szkicach włączone.' : 'Przypomnienia o szkicach wyłączone.'));
  }
  function setDirectionMap(on: boolean) {
    directionMap = on;
    try { localStorage.setItem('direction-map', on ? 'on' : 'off'); } catch { /* kept for this session */ }
    confirmSaved(t(on ? 'Mapa pod tarczą kierunku włączona.' : 'Mapa pod tarczą kierunku wyłączona.'));
  }
  /** "Dokończ" opens the Draft at its missing step, or Moje zapisy for several; "Nie przypominaj" keeps the Drafts. */
  async function reminderAction(action: 'finish' | 'stop', draftIds: string[]) {
    await startup;
    const waiting = drafts.filter(item => draftIds.includes(item.id));
    if (action === 'finish') {
      // A grouped reminder promised a list, so it opens one even if only one of its Drafts is left.
      if (draftIds.length === 1 && waiting.length === 1) openDraft(waiting[0]);
      else show('library');
      return;
    }
    try {
      for (const item of waiting) draftEdits.change(item, newest => ({ ...newest, remindersOff: true }));
      await draftEdits.flush();
      await refresh();
    } catch (cause) { storageError(cause); return; }
    await updateReminders();
    confirmSaved(t(draftIds.length > 1 ? 'Nie przypomnimy już o tych szkicach. Zostają w Moich zapisach.' : 'Nie przypomnimy już o tym szkicu. Zostaje w Moich zapisach.'));
  }
  async function downloadPhoto(photo: LocalPhoto, index: number) {
    if (fileSaving) return;
    fileSaving = true;
    error = '';
    try { await saveLocalFile(photo.jpeg, photoFilename(index)); }
    catch { error = t('Nie udało się zapisać pliku. Spróbuj ponownie.'); }
    finally { fileSaving = false; }
  }
  async function exportPdf() {
    if (!report || !currentNotice || !pdfText || fileSaving) return;
    const reportId = report.report.id;
    const notice = currentNotice;
    const recipient = notice.recipient;
    const filename = noticeFilename(recipient);
    const text = pdfText;
    const used = noticeFindings(report, notice);
    fileSaving = true;
    error = '';
    let noticePdf: typeof import('$lib/notice-pdf').noticePdf;
    // A failed import stays failed until reload, and an old tab's engine may no longer be on the server.
    try { ({ noticePdf } = await import('$lib/notice-pdf')); }
    catch { error = t(pdfLoadCopy); fileSaving = false; return; }
    let saved = false;
    try { saved = await saveLocalFile(await noticePdf(recipient, text), filename); }
    catch (cause) {
      error = t(cause instanceof Error && cause.message === 'pdf_unsupported_character'
        ? 'Czcionka PDF nie obsługuje części znaków w treści. Skopiuj treść i przygotuj plik w edytorze dokumentów.'
        : 'Nie udało się zapisać pliku. Spróbuj ponownie.');
    }
    finally { fileSaving = false; }
    if (!saved) return;
    confirmSaved(t(demoTestRecipient ? 'PDF testowy gotowy. Przekaż go tylko do skrzynki testowej.' : 'PDF przygotowany. Podpisz i złóż pismo w serwisie urzędowym.'));
    try { await setHandoffQuestion(reportId, notice.id, true, 'pdf', used); await refresh(); await focusHandoff(notice.id); }
    catch { storageError(); }
  }

  function previewPhotos(photos: LocalPhoto[] = []) {
    for (const url of Object.values(photoUrls)) URL.revokeObjectURL(url);
    photoUrls = Object.fromEntries(photos.map(photo => [photo.id, URL.createObjectURL(photo.jpeg)]));
  }
  function stopCamera() {
    camera?.getTracks().forEach(track => track.stop());
    camera = undefined;
    if (cameraVideo) cameraVideo.srcObject = null;
  }
  function attachCamera(node: HTMLVideoElement) {
    cameraVideo = node;
    if (camera) node.srcObject = camera;
    return { destroy() { node.srcObject = null; cameraVideo = undefined; } };
  }
  async function addPhoto(photo: LocalPhoto, draftId: string | undefined) {
    if (!draft || draft.id !== draftId || (draft.photos?.length ?? 0) >= 3) return;
    photoUrls = { ...photoUrls, [photo.id]: URL.createObjectURL(photo.jpeg) };
    updateDraft(newest => ({ photos: [...(newest.photos ?? []), photo] }));
    try { await draftEdits.flush(); } catch { return; }
    if (cameraDeniedDraft === draftId) cameraDeniedDraft = undefined;
    if (galleryRejectedDraft === draftId) galleryRejectedDraft = undefined;
    galleryFeedbackRequest++;
    announcement = `${t('Dodano zdjęcie. ')}${draft.photos?.length ?? 0} ${t('z 3.')}`;
  }
  const finiteAnimations = () => document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
  async function selectPhoto(event: Event) {
    const draftId = draft?.id;
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const request = ++galleryFeedbackRequest;
    if (cameraDeniedDraft === draftId) cameraDeniedDraft = undefined;
    galleryRejectedDraft = undefined;
    try {
      const photo = await photoFromFile(file);
      if (screen === 'details') await addPhoto(photo, draftId);
    }
    catch {
      if (request !== galleryFeedbackRequest || screen !== 'details' || draft?.id !== draftId) return;
      galleryRejectedDraft = draftId;
      await tick();
      const current = () => request === galleryFeedbackRequest && screen === 'details' && draft?.id === draftId && galleryRejectedDraft === draftId;
      // Shut Photos opens first, with its normal motion; the scroll below waits for it.
      const section = document.getElementById('gallery-import-feedback')?.closest('details');
      if (section && current()) requestOpen(section);
      // The pane is shorter than it will be while a section above or around the alert is still opening.
      // Other animations may delay the scroll, but never past 600 ms.
      const deadline = Date.now() + 600;
      for (let running = finiteAnimations(); running.length && Date.now() < deadline; running = finiteAnimations())
        await Promise.race([Promise.allSettled(running.map(animation => animation.finished)), new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
      const alert = document.getElementById('gallery-import-feedback');
      if (alert && current()) revealAlert(alert, current);
    }
  }
  /** How far the pane must scroll for `block: 'nearest'`, with the alert's scroll margin and the pane's scroll padding. */
  function nearestDelta(alert: HTMLElement, pane: HTMLElement) {
    const a = alert.getBoundingClientRect(), p = pane.getBoundingClientRect(), a_ = getComputedStyle(alert), p_ = getComputedStyle(pane);
    const top = a.top - (parseFloat(a_.scrollMarginTop) || 0), bottom = a.bottom + (parseFloat(a_.scrollMarginBottom) || 0);
    const edgeTop = p.top + (parseFloat(p_.scrollPaddingTop) || 0), edgeBottom = p.bottom - (parseFloat(p_.scrollPaddingBottom) || 0);
    const above = top < edgeTop, below = bottom > edgeBottom, taller = bottom - top > edgeBottom - edgeTop;
    if (above === below) return 0;
    return (above && !taller) || (below && taller) ? top - edgeTop : bottom - edgeBottom;
  }
  /** Brings the alert into its scroll pane: at once under reduced motion, else over a short sine in-out travel that
   * starts from rest, follows the alert while layout around it changes, and gives way to the Reporter's own input. */
  function revealAlert(alert: HTMLElement, current: () => boolean) {
    const pane = alert.closest<HTMLElement>('.screen-body');
    if (!pane || !alert.checkVisibility()) return;
    if (still()) { alert.scrollIntoView({ block: 'nearest', behavior: 'instant' }); return; }
    const distance = Math.abs(nearestDelta(alert, pane));
    if (!distance) return;
    const duration = Math.min(450, 240 + distance / 2), inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
    let elapsed = 0, last = performance.now(), eased = 0, stopped = false;
    const stop = () => { stopped = true; for (const type of inputs) pane.removeEventListener(type, stop); };
    for (const type of inputs) pane.addEventListener(type, stop, { passive: true });
    const step = (now: number) => {
      // Gone when the Reporter acted, the request went stale, or the alert is no longer rendered.
      if (stopped || !current() || !pane.isConnected || !alert.checkVisibility()) { stop(); return; }
      // A hidden tab pauses frames; the first one back must not jump to the end.
      elapsed += Math.min(now - last, 34); last = now;
      const next = (1 - Math.cos(Math.PI * Math.min(1, elapsed / duration))) / 2;
      // The share of what is left that this frame covers, so a target that moves does not make the curve step.
      pane.scrollTop += nearestDelta(alert, pane) * (next - eased) / (1 - eased);
      eased = next;
      if (eased < 1) requestAnimationFrame(step); else stop();
    };
    requestAnimationFrame(step);
  }
  function removePhoto(id: string) {
    if (!draft) return;
    updateDraft(newest => ({ photos: newest.photos?.filter(photo => photo.id !== id) }));
    URL.revokeObjectURL(photoUrls[id]);
    photoUrls = Object.fromEntries(Object.entries(photoUrls).filter(([key]) => key !== id));
  }
  async function openCamera() {
    if (cameraOpening) return;
    galleryRejectedDraft = undefined;
    galleryFeedbackRequest++;
    cameraOpening = true;
    const draftId = draft?.id;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 4096 }, height: { ideal: 3072 } } });
      if (screen !== 'details' || draft?.id !== draftId) { stream.getTracks().forEach(track => track.stop()); return; }
      camera = stream;
      show('camera');
    } catch {
      stopCamera();
      if (draft?.id !== draftId || (screen !== 'details' && screen !== 'camera')) return;
      cameraDeniedDraft = draftId;
      show(draft?.eventType === 2 ? 'home' : 'details');
    } finally { cameraOpening = false; }
  }
  async function takePhoto() {
    if (takingPhoto || !cameraVideo?.videoWidth) return;
    takingPhoto = true;
    const draftId = draft?.id;
    const stream = camera;
    try {
      const photo = await photoFromImage(cameraVideo, cameraVideo.videoWidth, cameraVideo.videoHeight);
      if (camera !== stream || screen !== 'camera' || draft?.id !== draftId) return;
      stopCamera();
      await addPhoto(photo, draftId);
      show('details', '', true);
    } catch { if (screen === 'camera' && draft?.id === draftId) error = t('Nie udało się zapisać zdjęcia. Spróbuj ponownie.'); }
    finally { takingPhoto = false; }
  }

  const svg = (name: string) => `<svg aria-hidden="true" viewBox="0 0 24 24">${icons[name]}</svg>`;
  /** "dziś 13:00", "wczoraj 13:00", else "18 sierpnia 13:00", with the year only when it is not this year. */
  function capturedWhen(at: string, withTime = true) {
    const locale = language === 'en' ? 'en-GB' : 'pl-PL';
    const value = new Date(at);
    const day = warsawDate(value), today = warsawDate(new Date());
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const dayWords = day === today ? t('dziś')
      : day === yesterday ? t('wczoraj')
      : new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'long', ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }) });
    return withTime ? `${dayWords} ${value.toLocaleTimeString(locale, { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' })}` : dayWords;
  }
  const date = (at: string) => new Date(at).toLocaleString(language === 'en' ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const eventLabel = (type: Report['event_type']) => t(events[eventTypes.indexOf(type)][0]);
  /** The record's number: the first eight hex digits of the Report's own id, so it is the same wherever it is shown. */
  const recordNumber = (id: string) => id.replace(/-/g, '').slice(0, 8).toUpperCase();
  /** A Reporter's edit to the open Draft. `wait` holds the store back while typing goes on. */
  function updateDraft(edit: Partial<LocalDraft> | ((newest: LocalDraft) => Partial<LocalDraft>), options?: { wait?: number }) {
    if (!draft) return;
    draftEdits.change(draft, newest => {
      const patch = typeof edit === 'function' ? edit(newest) : edit;
      const updated = { ...newest, ...patch, lastActivityAt: new Date().toISOString() };
      if (!('manualReference' in patch) && (('manualLat' in patch) || ('manualLon' in patch))) updated.manualReference = undefined;
      // A home answer was about one place; once the place changes the question is open again.
      if (!('fromHome' in patch) && JSON.stringify(placeOrigin(updated)) !== JSON.stringify(placeOrigin(newest))) updated.fromHome = undefined;
      return updated;
    }, options);
  }
  /** The next step of a Draft in the words of the screen it opens on. */
  function draftStep(item: LocalDraft) {
    const stage = resumeScreen(item);
    if (stage === 'choose-event') return t('Co się stało?');
    if (stage === 'when') return t('Kiedy to się stało?');
    if (stage === 'where') return t(item.eventType === 0 ? 'Skąd padł strzał?' : 'Gdzie to było?');
    return draftNext(item) ?? t('Sprawdź i zapisz');
  }
  /** What a task asks of the Reporter, as its row says it on home and in Moje zapisy. */
  function taskCopy(task: Task) {
    if (task.kind === 'draft') return { title: t(task.item.eventType === null ? 'Dokończ zgłoszenie' : events[task.item.eventType][2]),
      sub: `${capturedWhen(task.item.capturedAt)} · ${t('Dalej:')} ${draftStep(task.item)}` };
    const event = eventLabel(task.item.report.event_type);
    if (task.kind === 'refused') return { title: t('Zgłoszenie nie zostało przyjęte'),
      sub: `${event}, ${capturedWhen(task.item.report.captured_at)} · ${t('Zobacz, co możesz zrobić')}` };
    if (task.kind === 'confirm') return { title: fill(t('Potwierdź przekazanie: {name}'), { name: taskUnit(task) }),
      sub: `${event}, ${capturedWhen(task.item.report.captured_at)}` };
    const name = taskUnit(task);
    return { title: name === task.notice.recipient.name ? repliedQuestion(task.notice.recipient)
      : fill(t(task.notice.recipient.kind === 'nationalPark' ? 'Czy {name} odpowiedział?' : 'Czy {name} odpowiedziała?'), { name }), sub: `${event}, ${capturedWhen(task.item.report.occurred_at.at, false)}` };
  }
  // Short enough for one line on the home card; the screen the task opens names the unit in full.
  const taskUnits: Record<RecipientKind, string> = { police: 'Policja', psl: 'Straż Łowiecka', nationalPark: 'Park narodowy', rdos: 'RDOŚ', gmina: 'Gmina' };
  /** The short name, or the full one when another task of the same kind would read the same. */
  function taskUnit(task: Task & { notice: LocalNotice }) {
    const same = work.tasks.filter(other => other.kind === task.kind && 'notice' in other && other.notice.recipient.kind === task.notice.recipient.kind);
    return same.length > 1 ? task.notice.recipient.name : t(taskUnits[task.notice.recipient.kind]);
  }
  function openTask(task: Task) {
    if (task.kind === 'draft') openDraft(task.item);
    else if (task.kind === 'refused') openReport(task.item);
    else if (task.kind === 'check_in') void openCheckIn(task.item, task.notice);
    else { report = task.item; void openNotice(task.notice); }
  }
  const draftNext = (item: LocalDraft) => { const issue = draftReadiness(item, homePreset)[0]; return issue && issueText(issue, item); };
  function change(update: () => void) {
    currentTransition?.skipTransition();
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      currentTransition = document.startViewTransition(() => flushSync(update));
      // A newer change skips this one, which rejects `ready`; the update itself still ran.
      currentTransition.ready.catch(() => {});
      return currentTransition.updateCallbackDone;
    }
    flushSync(update);
    return Promise.resolve();
  }
  function inputMode(mode: 'keyboard' | 'pointer') {
    if (document.documentElement.dataset.input !== mode) document.documentElement.dataset.input = mode;
  }
  let confirmationLeaving: Promise<void> | undefined;
  function dismissConfirmation() {
    clearTimeout(confirmationTimer);
    cancelAnimationFrame(confirmationFrame);
    confirmationRequest++;
    if (confirmationLeaving) return confirmationLeaving;
    const node = document.querySelector('.brief-confirmation');
    if (!node) return Promise.resolve();
    confirmationLeaving = new Promise<void>(resolve => {
      node.addEventListener('outroend', () => { confirmationLeaving = undefined; resolve(); }, { once: true });
      confirmation = undefined;
    });
    return confirmationLeaving;
  }
  function display(next: Screen, message = '', scroll = 0, transition = true) {
    galleryFeedbackRequest++;
    // Leaving a screen stores what was typed on it.
    void draftEdits.flush().catch(() => {});
    const receipt = next === 'choose-event' && !editingCo;
    editingCo = false;
    const heading = next === 'home' && cameraDeniedDraft ? '.continuation .record-main'
      : next === 'library' && withdrawnReportId ? '#withdrawal-result' : receipt ? '#receipt' : 'main h1';
    if (screen === 'camera' && next !== 'camera') stopCamera();
    const current = ++displayVersion;
    let focused: Element | null = null;
    const apply = transition ? change : (update: () => void) => { flushSync(update); return Promise.resolve(); };
    void dismissConfirmation().then(() => {
      if (current !== displayVersion) return;
      return apply(() => {
        if (draft && savedDrafts.has(draft.id)) { draft = undefined; previewPhotos(); }
        // A Report withdrawn elsewhere is let go here, inside the change that takes it off screen.
        if (report && next === 'library' && !reports.some(item => item.report.id === report!.report.id)) report = undefined;
        if (next === 'choose-event') coIsReceipt = receipt;
        if (next !== 'report') confirmingWithdrawal = false;
        if (next !== 'library') withdrawnReportId = undefined;
        if (next !== 'menu') { confirmingHome = false; homeRemoved = false; confirmingSigner = false; signerRemoved = false; }
        if (next === 'when' && screen !== 'when') {
          showSafety = !safetyShown && (draft?.eventType === 0 || draft?.eventType === 1)
            && (!draft.occurredMode || draft.occurredMode === 'now');
          if (showSafety) safetyShown = true;
        }
        if (draft?.id !== cameraDeniedDraft || !['home', 'details'].includes(next)) cameraDeniedDraft = undefined;
        if (draft?.id !== galleryRejectedDraft || next !== 'details') galleryRejectedDraft = undefined;
        screen = next; error = message; focused = document.activeElement;
      });
    }).then(() => {
      if (current !== displayVersion) return;
      document.querySelector('.screen-body')?.scrollTo(0, scroll);
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(heading);
        // Someone who already moved on the new screen, by a tap or a missing-fact focus, keeps their place.
        if (current === displayVersion && [focused, document.body, null].includes(document.activeElement)) target?.focus({ preventScroll: true });
      });
    });
  }
  function locationFor(next: JourneyScreen): JourneyLocation {
    return { screen: next, draftId: ['choose-event', 'when', 'where', 'details', 'camera'].includes(next) ? draft?.id : undefined,
      reportId: ['report', 'recipients', 'signature', 'notices', 'notice', 'check-in'].includes(next) ? report?.report.id : undefined,
      noticeId: next === 'notice' || next === 'check-in' ? noticeId : undefined };
  }
  function recover(location: JourneyLocation, message = '') {
    navigation?.replace(location);
    display(location.screen, message);
  }
  async function applyLocation(location: JourneyLocation, scroll: number, message = '') {
    if (firstLaunch) {
      afterWelcome = location;
      display('welcome', message);
      return;
    }
    const current = ++restoration;
    // A line from the screen being left would otherwise stay in the status region on the next one.
    if (location.screen !== screen) announcement = '';
    if ((location.draftId && draft?.id !== location.draftId) || (location.reportId && report?.report.id !== location.reportId)) {
      try { await refresh(); } catch (cause) {
        storageError(cause);
        // Without storage no saved journey can open, so home shows why.
        if (storageBlocked) recover({ screen: 'home' });
        return;
      }
    }
    if (current !== restoration) return;
    if (location.draftId) {
      const found = drafts.find(item => item.id === location.draftId) ?? (draft?.id === location.draftId ? draft : undefined);
      // Back from a new Report passes the steps of the Draft it came from; those lead home, not to an error.
      if (!found && savedDrafts.has(location.draftId)) { recover({ screen: 'home' }); return; }
      if (!found) { recover({ screen: 'library' }, t('Nie znaleziono szkicu na tym urządzeniu.')); return; }
      draft = found; previewPhotos(found.photos);
    }
    if (location.reportId) {
      const found = reports.find(item => item.report.id === location.reportId) ?? (report?.report.id === location.reportId ? report : undefined);
      if (!found) { recover({ screen: 'library' }, t('Nie znaleziono zgłoszenia na tym urządzeniu.')); return; }
      report = found;
    }
    if (location.screen === 'notice' || location.screen === 'check-in') {
      const found = report?.notices?.find(item => item.id === location.noticeId);
      if (!found) { recover({ screen: 'notices', reportId: report?.report.id }, t('Nie znaleziono powiadomienia.')); return; }
      await prepareNoticeState(found);
      // A check-in exists only after a confirmed handoff; otherwise the Notice itself is the next step.
      if (location.screen === 'check-in' && (!checkInEnabled || noticeState(found) !== 'confirmed_by_reporter')) { recover({ ...location, screen: 'notice' }); return; }
      // Each arrival at the check-in starts from what is stored, not from an earlier visit's state.
      if (location.screen === 'check-in') { checkInChanging = false; checkInDateOpen = false; checkInSaved = false; }
    }
    if (location.screen === 'camera' && !camera) { recover({ screen: 'details', draftId: draft?.id }); return; }
    if (['when', 'where', 'details'].includes(location.screen) && draft?.eventType === null) { recover({ screen: 'choose-event', draftId: draft.id }); return; }
    if (['recipients', 'signature'].includes(location.screen)) restorePreparation();
    if (location.screen === 'signature' && (!selectedRecipients.length || gminaUnanswered)) {
      recover({ screen: 'report', reportId: report?.report.id });
      return;
    }
    if (location.screen === 'signature') await loadSigner();
    if (current !== restoration) return;
    if (location.screen === 'where' && draft && !draft.locationMethod) {
      updateDraft({ locationMethod: choosesPoint(draft) ? 'map' : 'reporter' });
    }
    triedSave = false;
    blockedPress = false;
    display(location.screen, message, scroll);
    if (location.screen === 'recipients' && !recipientBusy
      && (!recipientCatalog || !recipientSuggestion || recipientIssue || !online)) void loadRecipients();
  }
  function show(next: JourneyScreen, message = '', replace = false) {
    if (!navigation) { display(next, message); return; }
    navigation.navigate(locationFor(next), replace);
    if (message) error = message;
  }
  function askWithdrawal() {
    flushSync(() => confirmingWithdrawal = true);
    riseWith(withdrawalCancel, '.withdrawal-confirm');
  }
  function askHome() {
    flushSync(() => { confirmingSigner = false; confirmingHome = true; });
    riseWith(homeCancel, '.home-confirm');
  }
  function askSigner() {
    flushSync(() => { confirmingHome = false; confirmingSigner = true; });
    riseWith(signerCancel, '.signer-confirm');
  }
  /** Focuses a confirmation's Anuluj as its panel unfolds. */
  function riseWith(cancel: HTMLElement | undefined, selector: string) {
    // A focus scroll would jump to the half-grown panel. Instead, on every frame of its growth the
    // screen rises by what the panel grew, so its edge stays above the footer and nothing jumps.
    const body = document.querySelector<HTMLElement>('.screen-body');
    const panel = cancel?.closest<HTMLElement>(selector);
    if (!cancel || !body || !panel) return;
    // Reduced motion shows the panel at full height at once (and fires no introend), so one scroll does.
    let growing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Focus stays on the button that opened the panel until the panel is fully visible, so the focus
    // indicator is never drawn on something still at zero height or opacity. Until then the panel is
    // inert, so a quick Tab cannot walk into it, and Anuluj only takes focus if the opener still has it.
    const opener = document.activeElement;
    const ready = () => {
      if (!panel.isConnected) return;
      panel.inert = false;
      const active = document.activeElement;
      if (active === opener || active === document.body) cancel.focus({ preventScroll: true });
    };
    if (growing) {
      panel.inert = true;
      panel.addEventListener('introend', () => { growing = false; ready(); }, { once: true });
      setTimeout(() => { if (growing) { growing = false; ready(); } }, 600);
    } else ready();
    // On a short screen or with large text the heading rises out of view; the focused Anuluj never hides.
    const follow = () => {
      if (!panel.isConnected) return;
      const view = body.getBoundingClientRect();
      const footer = Math.min(view.bottom, document.querySelector('.screen-foot')?.getBoundingClientRect().top ?? view.bottom);
      const overflow = panel.getBoundingClientRect().bottom + 16 - footer;
      if (overflow > 0) body.scrollTop += overflow;
      if (growing) requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
  }
  function cancelWithdrawal() {
    // Mid-save the panel stays, so a failed save still shows where it failed.
    if (saving) return;
    confirmingWithdrawal = false;
    withdrawalButton?.focus();
  }
  function cancelHome() {
    if (saving) return;
    confirmingHome = false;
    homeRemoveButton?.focus();
  }
  function cancelSigner() {
    if (saving) return;
    confirmingSigner = false;
    signerRemoveButton?.focus();
  }
  async function removeSigner() {
    if (saving || !confirmingSigner) return;
    saving = true;
    try { await rememberSigner(undefined); }
    catch { storageError(); saving = false; return; }
    // The copy typed into the signature form in this session goes too, so the next signature starts empty.
    signer = { name: '', address: '', phone: '' };
    rememberDetails = false;
    signerSaved = false;
    confirmingSigner = false;
    signerRemoved = true;
    saving = false;
    await tick();
    document.getElementById('signer-result')?.focus({ preventScroll: true });
  }
  async function readSigner() {
    try { signerSaved = !!(await getSigner()); } catch { storageError(); }
  }
  $effect(() => { if (screen === 'menu') void readSigner(); });
  async function removeHome() {
    // The delete takes milliseconds, so the buttons stay as they are; a second tap meanwhile does nothing.
    if (saving || !confirmingHome) return;
    saving = true;
    try { await forgetHome(); }
    catch { storageError(); saving = false; return; }
    homeVersion++;
    homePreset = undefined;
    confirmingHome = false;
    homeRemoved = true;
    saving = false;
    // The result line takes focus on arrival, so it is not announced twice; it stays until Menu closes.
    await tick();
    document.getElementById('home-result')?.focus({ preventScroll: true });
  }
  function goBack() {
    if (confirmingWithdrawal) { cancelWithdrawal(); return; }
    if (confirmingHome) { cancelHome(); return; }
    if (confirmingSigner) { cancelSigner(); return; }
    navigation?.back();
  }
  /** Opens a stage from Sprawdź; its Dalej comes back here. */
  function edit(stage: Stage) {
    editing = true;
    editingCo = stage === 'choose-event';
    show(stage);
  }
  function nextStage(from: Stage) {
    if (!draft) return;
    if (from === 'when' && draftIssues.includes('occurrence')) {
      triedSave = true;
      document.querySelector<HTMLElement>('.screen-body #when-detail')?.focus();
      return;
    }
    if (from === 'where' && whereView === 'map' && choosesPoint(draft) && !manualPoint(draft)) {
      triedSave = true;
      document.querySelector<HTMLElement>(mapOpen ? '.screen-body .map-surface' : '.screen-body .map-disclosure button')?.focus();
      return;
    }
    const stages = draftStages(draft);
    const next = stages[stages.indexOf(from) + 1] ?? 'details';
    // An edit that opened a new question (an earlier time now needs a point) walks on to it.
    if (editing && !(next === 'where' && draftIssues.includes('location'))) { editing = false; goBack(); return; }
    editing = false;
    show(next);
  }
  function chooseWhen(mode: NonNullable<LocalDraft['occurredMode']>) {
    if (!draft) return;
    if (mode === 'now') { updateDraft({ occurredMode: 'now' }); nextStage('when'); return; }
    updateDraft(mode === 'within_hours' ? { occurredMode: mode, hoursAgo: draft.hoursAgo ?? 1 }
      : { occurredMode: mode, occurredDate: draft.occurredDate ?? warsawDate(new Date(draft.capturedAt)) });
  }
  async function refresh(transition = true) {
    const current = ++refreshVersion;
    const readHome = homeVersion;
    const [nextDrafts, nextReports, nextWithdrawals, nextHome] = await Promise.all([listDrafts(), listReports(), listWithdrawals(), getHome(), draftEdits.prepare()]);
    if (current !== refreshVersion) return nextDrafts;
    const activeReportId = report?.report.id;
    const nextReport = activeReportId ? nextReports.find(item => item.report.id === activeReportId) : undefined;
    const withdrawnActive = report && !nextReport;
    const findingsArrived = report?.findings.status !== 'computed' && nextReport?.findings.status === 'computed';
    const syncArrived = report && !isSynced(report) && nextReport && isSynced(nextReport);
    const recovered = syncArrived && report?.server_lost;
    const findingsChanged = report?.findings.status !== nextReport?.findings.status;
    // A Report withdrawn in another tab stays drawn until the screen change to Moje zapisy has taken
    // its picture; that change crossfades it away, so this refresh must not start a transition of its own.
    const leaving = transition && withdrawnActive && !['home', 'library'].includes(screen);
    // On home and in Moje zapisy the rows animate themselves, and on a Report its status, Findings and
    // retry lines do; a whole-page crossfade on top would show a frozen copy over the moving one.
    const apply = !transition || restingScreen || screen === 'report' || leaving ? (update: () => void) => { flushSync(update); } : change;
    await apply(() => {
      if (current !== refreshVersion) return;
      // Storage can lag behind an edit still waiting to be stored, and a Draft just saved or deleted.
      drafts = nextDrafts.filter(item => !draftEdits.isClosed(item.id)).map(item => draftEdits.current(item.id) ?? item);
      reports = nextReports;
      withdrawals = nextWithdrawals;
      if (readHome === homeVersion) homePreset = nextHome;
      if (report && report.report.id === activeReportId) {
        if (withdrawnActive) {
          for (const notice of report.notices ?? []) delete signedByNotice[notice.id];
        }
        if (!leaving) report = nextReport;
        if (findingsArrived) announcement = t('Pomiar odległości jest dostępny.');
        else if (recovered) announcement = t('Zgłoszenie jest znowu zapisane na serwerze.');
        else if (syncArrived) announcement = t('Zgłoszenie zapisano na serwerze.');
        else if (nextReport && isSynced(nextReport) && findingsChanged)
          announcement = findingsState(nextReport);
      }
    });
    if (current === refreshVersion && withdrawnActive && (leaving || !report) && !['home', 'library'].includes(screen)) {
      if (transition) show('library');
      else { navigation?.replace({ screen: 'library' }); display('library', '', 0, false); }
    }
    return nextDrafts;
  }
  async function updateCheckIns() {
    try { followUpReminderIssue = !await reconcileSignedNoticeCheckIns(checkInEnabled ? await listReports() : []); }
    catch { followUpReminderIssue = true; }
  }
  function syncState(item: LocalReport) {
    if (isSynced(item)) return t('Zapisano na serwerze.');
    if (item.sync_error === 'validation_refused') return t('Serwer nie przyjął zgłoszenia: nieprawidłowe dane. Sprawdź dane i zapisz nowe zgłoszenie albo przygotuj powiadomienie.');
    if (item.sync_error) return t('Serwer nie przyjął zgłoszenia. Zgłoszenie zostaje na telefonie. Możesz zapisać nowe zgłoszenie albo przygotować powiadomienie.');
    const retrying = item.retry_at && item.retry_at > clockNow;
    if (item.server_lost && !retrying) return t(online ? 'Zgłoszenia zabrakło na serwerze. Telefon zapisze je tam ponownie sam.'
      : 'Zgłoszenia zabrakło na serwerze. Telefon zapisze je tam ponownie, gdy wróci internet.');
    if (!online) return t('Zapisano na telefonie. Czeka na połączenie.');
    if (item.retry_at && item.retry_at > clockNow) return `${t(item.retry_reason === 'rate_limit' ? 'Serwer ograniczył liczbę zgłoszeń. Ponowna próba: ' : item.retry_reason === 'network' ? 'Nie udało się połączyć. Ponowna próba: ' : 'Serwer jest niedostępny. Ponowna próba: ')}${capturedWhen(new Date(item.retry_at).toISOString())}.`;
    return t('Zapisano na telefonie. Czeka na zapis na serwerze.');
  }
  /** A history row: a place word the Reporter has seen for this Report, its sync state while that needs saying,
   * and how far its Notices got. The place never comes from the saved home's area. */
  function libraryRow(item: LocalReport): ReportRow {
    const location = item.report.incident_location;
    // The gmina as the Notice names it, so an unanswered choice between gminy names none.
    const preparation = item.noticePreparation;
    const gmina = 'precise_fix_withheld' in location && location.precise_fix_withheld ? undefined
      : (preparation?.suggestion && noticePlaces(preparation.suggestion, preparation.gminaAnswer, preparation.gminaCorrection)?.gmina)
        ?? item.notices?.find(notice => notice.places?.gmina)?.places?.gmina;
    const lines: ReportRow['lines'] = [];
    if (item.sync_error) lines.push({ text: t('Nie zostało przyjęte. Otwórz, żeby zobaczyć dlaczego.'), tone: 'alert' });
    else if (!isSynced(item)) {
      const retrying = item.retry_at && item.retry_at > clockNow;
      lines.push({ tone: 'muted', text: t(!online || (retrying && item.retry_reason === 'network') ? 'Czeka na internet, potem zapisze się samo'
        : retrying ? 'Serwer chwilowo nie przyjmuje zgłoszeń. Zapisze się samo później.'
        : item.server_lost ? 'Zapisuje się ponownie na serwerze' : 'Zapisuje się na serwerze') });
    }
    const notices = item.notices ?? [];
    // Short names, or the full one where two Notices of this Report go to the same kind of authority.
    const unit = (notice: LocalNotice) => notices.filter(other => other.recipient.kind === notice.recipient.kind).length > 1
      ? notice.recipient.name : t(taskUnits[notice.recipient.kind]);
    const handed = notices.filter(notice => noticeState(notice) === 'confirmed_by_reporter');
    const waiting = notices.filter(notice => !handed.includes(notice)).map(unit);
    const answers = notices.flatMap(notice => {
      const outcome = notice.outcomes?.at(-1)?.outcome;
      if (!outcome || outcome === 'no_answer_yet') return [];
      const label = t(outcomeLabels[outcome]);
      return [`${unit(notice)}: ${label.charAt(0).toLocaleLowerCase() + label.slice(1)}`];
    });
    if (notices.length) lines.push({ tone: waiting.length ? 'ink' : 'muted', text: [
      handed.length ? fill(t('Przekazano {done} z {total}'), { done: String(handed.length), total: String(notices.length) }) : '',
      waiting.length ? fill(t('Czeka: {names}'), { names: waiting.join(', ') }) : '', ...answers
    ].filter(Boolean).join(' · ') });
    return { title: eventLabel(item.report.event_type), place: gmina ? fill(t('gm. {name}'), { name: gmina }) : undefined, lines };
  }
  function libraryWhen(at: string) {
    const value = new Date(at), locale = language === 'en' ? 'en-GB' : 'pl-PL';
    const warsaw = (options: Intl.DateTimeFormatOptions) => value.toLocaleDateString(locale, { timeZone: 'Europe/Warsaw', ...options });
    return { day: capturedWhen(at, false), time: value.toLocaleTimeString(locale, { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' }),
      month: warsaw({ month: 'long', year: 'numeric' }), date: warsaw({ day: 'numeric' }), weekday: warsaw({ weekday: 'short' }) };
  }
  function findingsState(item: LocalReport) {
    if (item.sync_error) return t('Pomiary są niedostępne, bo serwer nie przyjął zgłoszenia. Możesz przygotować powiadomienie bez nich.');
    // Findings the phone already holds stay readable while a lost Report is saved again.
    if (item.findings.status === 'failed') return t('Nie udało się obliczyć ustaleń. Możesz przygotować powiadomienie bez pomiarów.');
    if (!isSynced(item)) return t('Pomiary będą dostępne po zapisie zgłoszenia na serwerze.');
    if (item.findings.status === 'pending' && item.retry_stage === 'findings' && item.retry_at && item.retry_at > clockNow)
      return t('Nie udało się pobrać pomiarów. Spróbujemy ponownie.');
    return t('Czekamy na pomiary.');
  }
  async function retrySync(item: LocalReport) {
    try { await recordSync(item.report.id, {}); await refresh(); void sync?.wake(); }
    catch (cause) { storageError(cause); }
  }
  function storageError(cause?: unknown) {
    if (cause instanceof DraftClosedError) { closedElsewhere(cause.draft); return; }
    if (storageDenied(cause)) {
      storageBlocked = true;
      // An earlier failure's advice to try again no longer holds once the browser refuses storage outright.
      if (storageFailureCopy.some(text => error === t(text))) error = '';
      // Home already shows the line, so a tap there moves focus to it instead of saying it twice.
      if (screen === 'home') void tick().then(() => document.getElementById('storage-blocked')?.focus());
      // Start-up finds the block while the first screen is still loading; home then shows the line.
      else if (screen !== 'loading') error = t(storageBlockedCopy);
      return;
    }
    const name = cause instanceof DOMException ? cause.name : '';
    if (name === 'VersionError') newerDatabase = true;
    // A newer version in another tab upgraded the local database, which this tab's code cannot open.
    error = t(name === 'QuotaExceededError' ? storageFailureCopy[0] : name === 'VersionError' ? storageFailureCopy[1] : storageFailureCopy[2]);
  }
  /** A write found the Draft deleted or saved as a Report in another tab: show what exists instead. */
  function closedElsewhere(id?: string) {
    if (draft && (!id || draft.id === id)) { draft = undefined; show('home', '', true); }
    void refresh(false).catch(cause => { if (!(cause instanceof DraftClosedError)) storageError(cause); });
  }
  /** Signer details typed here and not remembered on this phone live only in memory. */
  async function unsavedSigner() {
    const held = [signer, ...Object.values(signedByNotice)].filter(details =>
      details.name.trim() || details.address.trim() || details.phone?.trim());
    if (!held.length) return false;
    const remembered = await getSigner().catch(() => undefined);
    return held.some(details => !remembered || details.name.trim() !== remembered.name ||
      details.address.trim() !== remembered.address || (details.phone?.trim() || undefined) !== (remembered.phone || undefined));
  }
  async function restartApp() {
    if (restarting) return;
    restarting = true;
    try {
      const losses: string[] = [];
      if (draft) {
        try { await draftEdits.flush(); }
        catch { losses.push(t('Nie udało się zapisać ostatnich zmian szkicu.')); }
      }
      if (await unsavedSigner()) losses.push(t('Wpisane dane do podpisu nie są zapisane w telefonie i trzeba będzie wpisać je ponownie.'));
      if (losses.length && !window.confirm(`${losses.join(' ')} ${t('Uruchomić aplikację ponownie?')}`)) return;
      await offlineReadiness?.restart();
    } finally { restarting = false; }
  }
  function focusIssue(issue: DraftIssue) {
    if (issue === 'event') { edit('choose-event'); return; }
    if (issue === 'location') { edit('where'); return; }
    const placeControl = '#place-row button';
    const selector: Record<Exclude<DraftIssue, 'event' | 'location'>, string> = {
      home: '#home-check button', area: '.screen-foot .primary',
      photo: draft?.eventType === 0 || (draft?.photos?.length ?? 0) > 3 ? '.photo-tile button' : '#photo-required button, .photo-controls input[type="file"]',
      details: '#report-note', manual_point: placeControl,
      near_home: '#home-check button', moved_point: '#home-check button',
      occurrence: '#when-row button'
    };
    const control = document.querySelector<HTMLElement>(`.screen-body ${selector[issue]}`);
    const container = control?.closest('details');
    if (container && !container.open) {
      // Content that is opening can take focus from the frame after its toggle event.
      container.addEventListener('toggle', () => requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`.screen-body ${selector[issue]}`)?.focus({ preventScroll: false })), { once: true });
      requestOpen(container);
    } else control?.focus({ preventScroll: false });
  }
  async function finishLater() {
    try { await draftEdits.flush(); }
    catch (cause) { storageError(cause); return; }
    editing = false;
    show('home');
    confirmSaved(t('Zapisane na telefonie. Dokończysz, kiedy zechcesz.'));
    // The Reporter has just chosen to come back later, so this is when Android asks about notifications.
    if (draftReminders) void askForReminders().catch(() => false).then(() => updateReminders());
  }
  function theme() { themeWatch?.update(); }
  onMount(() => {
    language = navigator.language.toLowerCase().startsWith('en') ? 'en' : 'pl';
    try {
      firstLaunch = localStorage.getItem('first-launch-seen') !== '1';
      const savedLanguage = localStorage.getItem('interface-language');
      if (savedLanguage === 'en' || savedLanguage === 'pl') language = savedLanguage;
      draftReminders = localStorage.getItem('draft-reminders') !== 'off';
      directionMap = localStorage.getItem('direction-map') !== 'off';
    } catch { preferenceError = t(preferenceFailure); }
    document.documentElement.lang = language;
    if (!firstLaunch) stopSensors = prepareSensors(theme);
    if (!checkInEnabled) void updateCheckIns();
    androidWeb = /Android/i.test(navigator.userAgent) && !isAndroidApp;
    const reminderActions = watchDraftReminderActions((action, ids) => { void reminderAction(action, ids); });
    navigation = createJourneyNavigation((location, scroll) => { void applyLocation(location, scroll); },
      () => document.querySelector('.screen-body')?.scrollTop ?? 0);
    const initial = navigation.initial;
    // Keep the requested journey in the URL while the introduction is open, including on reload.
    if (firstLaunch) void applyLocation(initial, 0);
    const clock = setInterval(() => { clockNow = Date.now(); }, 60_000);
    themeWatch = watchTheme(() => freshSessionFix() ?? draft?.fix ?? drafts.findLast(item => item.fix)?.fix);
    sync = createSyncWorker(() => refresh(false), storageError);
    online = navigator.onLine;
    const stopWithdrawalWatch = watchReportWithdrawals(() => { void refresh().catch(storageError); });
    // Home needs no history; saved journeys still wait for their Draft or Report.
    const immediate = !initial.draftId && !initial.reportId;
    const initialScroll = (history.state as { scroll?: number })?.scroll ?? 0;
    const landed = !firstLaunch && immediate ? applyLocation(initial, initialScroll) : undefined;
    // A start that has failed or moved on by then says nothing.
    const slowStart = setTimeout(() => { if (screen === 'loading' && !error) startupLine = initial.reportId ? 'Otwieram zgłoszenie…' : 'Otwieram szkic…'; }, 300);
    void refresh().then(async () => {
      // A tap made while storage was being read has already moved the Reporter on; the saved address no longer applies.
      const restored = !firstLaunch && !immediate && screen === 'loading' && restoration === 0
        ? applyLocation(initial, initialScroll) : landed;
      void Promise.resolve(restored).finally(draftsLoaded);
      theme(); sync?.wake();
      // Capture is usable by now; the optional offline files download after it.
      offlineReadiness = watchOfflineReadiness(isAndroidApp, status => {
        const ready = Object.values(status).every(state => state === 'ready');
        if (Object.values(status).includes('missing')) offlinePreparationPending = true;
        offlineStatus = status;
        if (ready && offlinePreparationPending) {
          offlinePreparationPending = false;
          if (screen === 'menu') confirmSaved(t('Pliki pobrane. Aplikacja działa bez internetu.'));
        }
      }, ready => appUpdate = ready);
      void offlineReadiness.prepare();
      if (!isAndroidApp && (drafts.length || reports.length) && typeof navigator.storage?.persisted === 'function') {
        try { storageWarning = !(await navigator.storage.persisted()); } catch { storageWarning = true; }
        // A Draft stored before this load, even by an earlier version, gets the same request as a new one.
        // Firefox can leave the question open, so the warning stays until the browser actually agrees.
        if (storageWarning) void keepStorage().then(kept => { if (kept) storageWarning = false; });
      }
      void updateReminders();
      if (checkInEnabled) await updateCheckIns();
    }).catch(cause => {
      draftsLoaded(); storageError(cause);
      // A saved journey cannot be opened without storage, so home says why instead of the screen staying blank.
      if (storageBlocked && !firstLaunch && !immediate) show('home', '', true);
    });
    const backListener = watchAndroidBack(() => {
      if (confirmingWithdrawal) { cancelWithdrawal(); return true; }
      if (confirmingHome) { cancelHome(); return true; }
      if (confirmingSigner) { cancelSigner(); return true; }
      if (screen === 'library' && confirmingDelete) { library?.cancel(); return true; }
      return navigation?.back() ?? false;
    });
    const listener = watchAppState(() => {
      sync?.pause();
      void draftEdits.flush(true).catch(() => {});
      // A reminder names the step still missing, so it is rewritten as the Reporter leaves.
      void updateReminders();
    }, () => { clockNow = Date.now(); theme(); void refresh().then(async () => { void updateReminders(); await updateCheckIns(); }).catch(storageError); void sync?.wake(); });
    return () => { clearTimeout(slowStart); stopSensors?.(); request++; restoration++; navigation?.dispose(); stopCamera(); previewPhotos(); sync?.stop(); offlineReadiness?.stop(); stopWithdrawalWatch(); themeWatch?.stop(); clearInterval(clock); void listener.then(remove => remove()); void backListener.then(remove => remove()); void reminderActions.then(remove => remove()); };
  });
  /** Asks for the phone's position in the background. A cold fix in a forest can take most of a minute,
   * and a fix the phone took up to a minute ago is still where the Reporter was. */
  function locate(item: LocalDraft) {
    const requestedAt = new Date().toISOString();
    const current = ++request;
    locationError = '';
    locationDenied = false;
    if (!navigator.geolocation) { locationError = t('Ta przeglądarka nie udostępnia lokalizacji.'); return; }
    locating = item.id;
    void sessionFix().then(async fix => {
      if (current !== request) return;
      locating = undefined;
      // Dropped when the Draft is already a Report or deleted.
      if (!draftEdits.change(item, newest => ({ ...newest, fix,
        lastActivityAt: newest.lastActivityAt && newest.lastActivityAt > requestedAt ? newest.lastActivityAt : requestedAt }))) return;
      try {
        await draftEdits.flush();
        await refresh(); theme();
        if (screen !== 'choose-event' || !coIsReceipt) announcement = t('Miejsce zapisane w szkicu.');
      }
      catch { /* the edit path named the storage error */ }
    }, failure => {
      if (current !== request) return;
      locating = undefined;
      // 1 is PERMISSION_DENIED: the Reporter or the phone refused, and asking again would not change that.
      locationDenied = failure === 1;
      // A refusal is named by the status line under the method buttons, so it needs no alert of its own.
      locationError = locationDenied ? '' : t('Nie udało się ustalić miejsca. Możesz spróbować ponownie z bezpiecznego miejsca.');
    });
  }
  /** The retry leaves while the phone tries, so its focus goes to the screen's heading rather than nowhere. */
  function retryLocation(item: LocalDraft) {
    locate(item);
    document.querySelector<HTMLElement>('.screen-body h1')?.focus({ preventScroll: true });
  }
  async function capture(eventType: number | null) {
    if (saving) return;
    saving = true;
    const item: LocalDraft = { id: crypto.randomUUID(), eventType, capturedAt: new Date().toISOString(),
      ...(eventType === null ? { quickCapture: true } : {}) };
    try {
      await draftEdits.create(item);
      // The first stored Draft is what the browser should keep, so it is asked now rather than at the Report.
      if (!isAndroidApp) void keepStorage();
      draft = item;
      previewPhotos();
      // The receipt confirms this durable write, not a read of every older record.
      void refresh(false).catch(storageError);
      if (eventType === null) freshCapture = item.id;
      show(eventType === null ? 'choose-event' : 'when');
      // The receipt panel takes focus and says the same thing.
      if (eventType !== null) announcement = t('Szkic zapisany na urządzeniu.');
      // Never asks for the notification permission here: it would cover the receipt.
      void updateReminders();
      locate(item);
    } catch (cause) { storageError(cause); }
    finally { saving = false; }
  }
  function openDraft(item: LocalDraft) { draft = item; previewPhotos(item.photos); locationError = ''; locationDenied = false; editing = false; freshCapture = undefined; theme(); show(resumeScreen(item)); }
  function openReport(item: LocalReport) { report = item; show('report'); }
  async function removeDraft(id: string) {
    try { await draftEdits.remove(id); if (draft?.id === id) draft = undefined; await refresh(); void updateReminders(); return true; }
    catch { storageError(); return false; }
  }
  async function withdraw(local: LocalReport) {
    if (saving || !confirmingWithdrawal) return;
    saving = true;
    try { await withdrawReport(local); }
    catch {
      error = t('Nie udało się zapisać wycofania. Zwolnij miejsce na urządzeniu i spróbuj ponownie.');
      saving = false;
      return;
    }
    report = undefined;
    withdrawnReportId = local.report.id;
    confirmingWithdrawal = false;
    reports = reports.filter(item => item.report.id !== local.report.id);
    withdrawals = [...withdrawals, { id: local.report.id, token: local.token, at: new Date().toISOString() }];
    try { await refresh(); } catch { storageError(); }
    // The result line takes focus on arrival, so a live announcement here would read it twice.
    show('library');
    void sync?.wake();
    saving = false;
  }
  function chooseLocationMethod(locationMethod: 'map' | 'reporter') {
    if (!draft || (locationMethod === 'reporter' && !draft.fix)) return;
    triedSave = false;
    updateDraft({ locationMethod });
  }
  function chooseLocation(point: { lat: number; lon: number }, manualReference?: LocalDraft['manualReference']) {
    updateDraft({ locationMethod: 'map', manualReference, manualLat: String(point.lat), manualLon: String(point.lon), pointRadiusM: draft?.pointRadiusM ?? defaultPointRadiusM });
  }
  async function chooseEvent(eventType: number) {
    if (!draft || saving) return;
    saving = true;
    const changed = eventType !== draft.eventType;
    try {
      const updated = draftEdits.change(draft, newest => ({ ...newest, eventType, lastActivityAt: new Date().toISOString() }));
      if (!updated) return;
      await draftEdits.flush();
      // A new Event placed by direction asks its own question on the dial in place of Co, so Dalej still returns to Sprawdź.
      if (editing && asksDirection(updated) && changed) show('where', '', true);
      else if (editing) { editing = false; goBack(); }
      else show('when');
    } catch (cause) { storageError(cause); }
    finally { saving = false; }
  }
  async function save() {
    if (!draft || saving) return;
    if (blockingIssues.length) { triedSave = true; focusIssue(blockingIssues[0]); return; }
    saving = true;
    try {
      // Saving under the map of the kept area is its confirmation; a failed save leaves the Draft unconfirmed.
      const local = await draftEdits.saveAsReport(draft, keptArea);
      savedDrafts.add(draft.id);
      // Sprawdź stays drawn until the screen change takes its picture; display() lets the Draft go.
      report = local;
      show('report', '', true);
      announcement = t('Zgłoszenie zapisane na urządzeniu.');
      // The screen change is the crossfade here; a second one would skip it and cut to the Report.
      try { await refresh(false); } catch (cause) { storageError(cause); }
      // The Draft is a Report now, so nothing reminds about it any more.
      void updateReminders();
      void sync?.wake();
      if (!isAndroidApp) {
        // Firefox can leave its question unanswered for as long as it likes; the save must not wait on it.
        void keepStorage().then(kept => { storageWarning = !kept; });
      }
    } catch (cause) {
      if (cause instanceof DraftValidationError) { triedSave = true; focusIssue(cause.issue); error = issueText(cause.issue, draft!); }
      else if (cause instanceof DraftClosedError) {
        // Another tab already saved or deleted this Draft; show what exists instead of a second Report.
        draft = undefined;
        show('home', '', true);
        try { await refresh(false); } catch (refreshCause) { storageError(refreshCause); }
      }
      else storageError(cause);
    }
    finally { saving = false; }
  }
  function resume() { if (document.visibilityState === 'visible') { theme(); void refresh().catch(storageError); void sync?.wake(); } else { sync?.pause(); void draftEdits.flush(true).catch(() => {}); if (screen === 'camera') { stopCamera(); show('details', '', true); } } }
</script>

{#snippet eventGlyph(index: number | null, fallback = 'map-pin')}
  <span class="event-icon">{@html svg(index === null ? fallback : events[index][1])}</span>
{/snippet}
{#snippet withdrawalResult()}
  {@const pending = withdrawals.some(item => item.id === withdrawnReportId)}
  <!-- Stays until the Reporter leaves. When the server confirms, the line keeps its place and its text crossfades. -->
  <p id="withdrawal-result" class="result-line" role="status" tabindex="-1"><span class="result-copy" use:followHeight><span class="result-stack">{#key pending}<span in:receiptIn out:receiptOut>{t(pending ? 'Zgłoszenie wycofane z telefonu. Usunięcie z serwera potwierdzimy, gdy będzie połączenie.' : 'Zgłoszenie wycofane. Dane usunięto z telefonu i serwera.')}</span>{/key}</span></span></p>
{/snippet}
{#snippet databaseNotice()}
  <div class="database-notice" transition:reveal={unfold}>
    <p role="alert">{t(oldVersionCopy)}</p>
    <button class="wide" disabled={restarting} onclick={() => void restartApp()}>{t('Uruchom nową wersję')}</button>
  </div>
{/snippet}
{#snippet taskRow(task: Task, id?: string, describedBy?: string)}
  {@const copy = taskCopy(task)}
  <button {id} class="record-main task-row" aria-describedby={describedBy} onclick={() => openTask(task)}>{#if task.kind === 'draft'}{@render eventGlyph(task.item.eventType)}{:else if task.kind === 'refused'}{@render eventGlyph(eventTypes.indexOf(task.item.report.event_type))}{:else}{@render eventGlyph(null, task.kind === 'confirm' ? 'mail' : 'clock-3')}{/if}<span class="record-copy"><strong id={id && `title-${id}`}>{copy.title}</strong><small id={id && `time-${id}`}>{copy.sub}</small></span>{@html svg('chevron-right')}</button>
{/snippet}
{#snippet eventRows(onChoose: (index: number) => void)}
  <div class="event-rows">
    {#each events as event, index (event[0])}
      <button class="event-row" onclick={() => onChoose(index)} disabled={saving}>
        {@render eventGlyph(index)}
        <span class="event-copy">{t(event[0])}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet stageHead(current: Stage)}
  {@const stages = draft ? draftStages(draft) : []}
  {@const position = stages.indexOf(current)}
  <div class="stage-head">
    <button class="back-inline" aria-label={t('Wróć')} onclick={goBack}>{@html svg('arrow-left')}</button>
    <ol class="steps" aria-label={t('Kroki')}>
      {#each stages as stage, index (stage)}
        <li class:done={index < position} class:now={index === position} aria-current={index === position ? 'step' : undefined}>{t(stageNames[stage])}</li>
      {/each}
    </ol>
  </div>
{/snippet}
{#snippet preparationHead(current: 'recipients' | 'signature')}
  <div class="stage-head">
    <button class="back-inline" aria-label={t('Wróć')} onclick={goBack}>{@html svg('arrow-left')}</button>
    <ol class="steps" aria-label={t('Kroki')}>
      <li class:done={current === 'signature'} class:now={current === 'recipients'} aria-current={current === 'recipients' ? 'step' : undefined}>{t('Odbiorcy')}</li>
      <li class:now={current === 'signature'} aria-current={current === 'signature' ? 'step' : undefined}>{t('Podpis')}</li>
    </ol>
  </div>
{/snippet}
{#snippet recipientExtras(foot: boolean)}
        {#if recipientsDeferred && selectedRecipients.length}
          <div class="foot-quiet" transition:reveal><button disabled={catalogMissing || gminaUnanswered} onclick={() => void openSignature()}>{t('Dalej: podpis')}</button></div>
        {:else if !recipientsDeferred}
          <div class="foot-quiet" transition:reveal><button class="quiet" onclick={() => show('report')}>{t('Dokończę później')}</button></div>
        {/if}
        {#if recipientReason}<small id={foot ? 'recipients-reason' : undefined} aria-live="polite" class:pressed={blockedPress} transition:reveal>{recipientReason === 'gmina' ? t('Odpowiedz, w której gminie to było.') : t('Zaznacz co najmniej jeden urząd.')}</small>{/if}
{/snippet}
{#snippet scrollExtras()}
  {#if ['choose-event', 'when', 'where', 'details'].includes(screen) && draft}
    {#if screen === 'where' && whereView === 'map' && choosesPoint(draft) && !manualPoint(draft)}<p class="draft-next">{t('Wskaż miejsce, aby przejść dalej.')}</p>{/if}
    {#if screen === 'details' && blockingIssues.length}<p class="draft-next">{issueText(blockingIssues[0], draft)}</p>{/if}
    {#if screen === 'details'}<p class="no-help">{t('Zgłoszenie nie sprowadza pomocy.')}</p>{/if}
    <button class="quiet" onclick={finishLater}>{t('Dokończę później')}</button>
  {:else if screen === 'recipients' && report}{@render recipientExtras(false)}
  {:else if screen === 'signature' && report}
    <button class="quiet" onclick={() => show('report')}>{t('Dokończę później')}</button>
    {#if preparationPending}<small role="status">{t('Zapisywanie…')}</small>{:else if signatureBlocked}<small aria-live="polite" class:pressed={blockedPress}>{t('Podaj imię, nazwisko i adres do korespondencji.')}</small>{/if}
  {/if}
{/snippet}

{#snippet later()}<div class="foot-quiet footer-extras"><button class="quiet" onclick={finishLater}>{t('Dokończę później')}</button></div>{/snippet}

{#snippet photoFeedback(item: LocalDraft)}
  {#if cameraDeniedDraft === item.id}<p id="camera-denial-feedback" class="camera-feedback" role="alert">{t('Brak dostępu do aparatu. Szkic jest zapisany. Możesz wybrać zdjęcie z urządzenia albo dokończyć później.')}</p>
  {:else if galleryRejectedDraft === item.id}<p id="gallery-import-feedback" role="alert">{t('Nie udało się odczytać zdjęcia. Wybierz inny plik.')}</p>{/if}
{/snippet}

<!-- Inside a role group the heading already names the role, so the row gives only gmina detail. -->
{#snippet photoControls(item: LocalDraft)}
  <div class="photo-controls">
  {#if item.eventType !== 2}<p>{t('Zdjęcia zostają na telefonie. Dołączysz je do powiadomienia.')}</p>{/if}
  <div class="photo-tiles">
    {#each item.photos ?? [] as photo, index (photo.id)}
      <div class="photo-tile"><img src={photoUrls[photo.id]} alt={`${t('Zdjęcie ')}${index + 1}`} /><button type="button" aria-label={`${t('Usuń zdjęcie ')}${index + 1}`} onclick={() => removePhoto(photo.id)}>{t('Usuń')}</button></div>
    {/each}
  </div>
  {#if item.eventType !== 0 && (item.photos?.length ?? 0) < 3}
    <div class="photo-actions">
      <button type="button" aria-describedby={cameraDeniedDraft === item.id ? 'camera-denial-feedback' : undefined} onclick={() => void openCamera()} disabled={cameraOpening}>{t('Zrób zdjęcie')}</button>
      <label class="file-button">{t('Z galerii')}<input type="file" accept="image/*" aria-describedby={galleryRejectedDraft === item.id ? 'gallery-import-feedback' : cameraDeniedDraft === item.id ? 'camera-denial-feedback' : undefined} onchange={selectPhoto} /></label>
    </div>
  {/if}
  {#if item.photos?.length}<small>{item.photos.length}{t(' z 3 zdjęć')}</small>{/if}
  {@render photoFeedback(item)}
  </div>
{/snippet}

{#snippet recipientChoice(choice: { unit: RecipientUnit; selected: boolean }, underRoleHeading: boolean)}
  {@const detail = underRoleHeading ? gminaDetail(choice.unit) : unitDetail(choice.unit)}
  <label class="recipient-choice">
    <input type="checkbox" checked={choice.selected} onchange={() => toggleRecipient(choice.unit)} />
    <span><strong>{choice.unit.name}</strong>{#if detail}<small>{detail}</small>{/if}
      {#if !handoffRecipient(choice.unit.email)}<small class="missing-address">{t('Brak potwierdzonego adresu e-mail. Sprawdź stronę urzędu.')}</small>{/if}
    </span>
  </label>
{/snippet}
{#snippet recipientGroup(role: RecipientSuggestion['roles'][number])}
  <fieldset class="recipient-group">
    <legend class:sr-only={!role.ambiguous || role.kind === 'gmina'}>{kindLabel(role.kind)}{role.kind === 'gmina' ? ` · ${t('informacyjnie')}` : ''}</legend>
    {#if role.ambiguous && role.kind !== 'gmina'}<small>{t('type' in report!.report.incident_location ? 'Obszar leży na terenie kilku jednostek. Zaznacz, do której chcesz napisać.' : 'Miejsce leży na granicy jednostek. Zaznacz, do której chcesz napisać.')}</small>{/if}
    {#each recipientChoices.filter(choice => choice.unit.kind === role.kind && suggestedKeys.has(`${choice.unit.kind}:${choice.unit.id}`)) as choice (choice.unit.id)}
      {@render recipientChoice(choice, true)}
    {/each}
  </fieldset>
{/snippet}
{#snippet recipientSearch()}
  {#if !recipientFallback}<button id="recipient-search-open" class="wide" onclick={() => void openRecipientSearch()}>{t(recipientsDeferred || recipientSearchFirst ? 'Wybierz jednostkę po nazwie' : 'Wybierz inną jednostkę po nazwie')}</button>{/if}
  {#if recipientFallback}
    <div class="recipient-search-panel" transition:reveal onintroend={showRecipientSearchFocus}>
      <h2>{t('Znajdź jednostkę')}</h2>
      <label class="recipient-search">{t('Rodzaj urzędu')}
        <select value={recipientSearchKind} onchange={event => { recipientSearchKind = event.currentTarget.value as RecipientKind; }}>
          {#each recipientKinds as [kind, label] (kind)}<option value={kind}>{t(label)}</option>{/each}
        </select>
      </label>
      <label class="recipient-search">{t('Nazwa lub miejscowość')}
        <input bind:this={recipientSearchInput} type="search" value={recipientQuery} oninput={event => recipientQuery = event.currentTarget.value} autocomplete="off"
          aria-describedby="recipient-result-count" />
      </label>
      <p id="recipient-result-count" class="result-count" role="status">{recipientQuery.trim().length < 2 ? t('Wpisz co najmniej dwie litery.')
        : !recipientResults.total ? t('Nie znaleziono jednostki. Spróbuj innej nazwy.')
        : recipientResults.total > recipientResults.units.length
          ? `${t('Znaleziono')}: ${recipientResults.total}. ${t('Pokazuję pierwsze')} ${recipientResults.units.length}. ${t('Wpisz więcej liter, żeby zawęzić.')}`
          : `${t('Znaleziono')}: ${recipientResults.total}.`}</p>
      {#if recipientResults.units.length}
        <ul class="recipient-results">
          {#each recipientResults.units as unit (`${unit.kind}:${unit.id}`)}
            {@const chosen = recipientChoices.some(choice => choice.selected && choice.unit.kind === unit.kind && choice.unit.id === unit.id)}
            <li><button class="recipient-result" aria-pressed={chosen} onclick={() => toggleRecipient(unit)}>
              <strong>{unit.name}</strong><small>{unitDetail(unit)}</small>
              <small class={handoffRecipient(unit.email) ? '' : 'missing-address'}>{handoffRecipient(unit.email) ?? t('Brak potwierdzonego adresu e-mail')}</small>
              {#if chosen}<small class="chosen">{t('Wybrano. Naciśnij, aby usunąć.')}</small>{/if}
            </button></li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
{/snippet}
{#snippet mailAction(notice: LocalNotice, kind: string)}
  {#if isAndroidApp && noticeText && handoffRecipient(notice.recipient.email)}<button class={kind} disabled={mailOpening} onclick={() => void handoffAndroid(notice)}>{t('Otwórz w poczcie')}</button>
  {:else if handoff}<a class={kind || 'button-link'} href={handoff.href} onclick={event => void handoffWeb(event, notice)}>{t('Otwórz w poczcie')}</a>
  {:else}<button class={kind} disabled>{t('Otwórz w poczcie')}</button>{/if}
{/snippet}
{#snippet filingGuide()}
  <details class="disclosure" use:disclosure>
    <summary>{t('Jak złożyć przez ePUAP lub e-Doręczenia?')}</summary>
    <div class="disclosure-body official-filing">
      <p>{t('Zaloguj się samodzielnie w serwisie urzędowym. Sprawdź, czy urząd przyjmuje tam Twoją sprawę i czy wymaga osobnego formularza. Aplikacja nie składa pisma za Ciebie.')}</p>
      <h2>ePUAP</h2>
      <p>{t('Otwórz usługę pisma ogólnego i wybierz właściwy urząd. Dla Policji dostępna jest ścieżka ePUAP: przy wyborze skrzynki wybierz „Anuluj i wybierz ePUAP”. Dołącz PDF, podpisz pismo i wyślij je w serwisie. Zachowaj Urzędowe Poświadczenie Przedłożenia (UPP).')}</p>
      <a href="https://www.gov.pl/web/gov/wyslij-pismo-ogolne" target="_blank" rel="noreferrer">{t('Otwórz instrukcję ePUAP')}</a>
      <h2>e-Doręczenia</h2>
      <p>{t('Jeśli urząd korzysta z e-Doręczeń, wybierz jego adres do doręczeń elektronicznych w oficjalnej wyszukiwarce. To inny adres niż e-mail. Podpisz dokument elektronicznie, dołącz go do wiadomości i wyślij w serwisie. Samo zalogowanie nie podpisuje załącznika. Zachowaj dowody wysłania i otrzymania.')}</p>
      <a href="https://www.gov.pl/web/e-doreczenia" target="_blank" rel="noreferrer">{t('Otwórz e-Doręczenia')}</a>
      <p><a href="https://www.gov.pl/web/gov/podpisz-dokument-elektronicznie-wykorzystaj-podpis-zaufany" target="_blank" rel="noreferrer">{t('Podpisz dokument elektronicznie')}</a></p>
      {#if report?.photos?.length}<p>{t('Zdjęć nie ma w PDF. Możesz je pobrać w „Inne sposoby przekazania” i dołączyć, jeśli serwis na to pozwala.')}</p>{/if}
    </div>
  </details>
{/snippet}
{#snippet signerFields(details: SignedDetails)}
  <label class="recipient-search">{t('Imię i nazwisko')}<input bind:value={details.name} autocomplete="name" aria-invalid={blockedPress && screen === 'signature' && !details.name.trim() ? 'true' : undefined} /></label>
  <label class="recipient-search">{t('Adres do korespondencji')}<input bind:value={details.address} autocomplete="street-address" aria-invalid={blockedPress && screen === 'signature' && !details.address.trim() ? 'true' : undefined} /></label>
  <label class="recipient-search">{t('Telefon (opcjonalnie)')}<input bind:value={details.phone} autocomplete="tel" inputmode="tel" /></label>
{/snippet}

<svelte:window onkeydown={event => { if (event.key !== 'Escape' || document.querySelector('dialog:modal')) return; if (confirmingWithdrawal) { event.preventDefault(); cancelWithdrawal(); } else if (confirmingHome) { event.preventDefault(); cancelHome(); } else if (confirmingSigner) { event.preventDefault(); cancelSigner(); } }} ononline={() => { online = true; void sync?.wake(); void offlineReadiness?.prepare(); }} onoffline={() => { online = false; sync?.pause(); }} onbeforeunload={() => { void draftEdits.flush(true).catch(() => {}); }} onpagehide={() => { void draftEdits.flush(true).catch(() => {}); }} />
<!-- Which input moved the Reporter last decides whether a focused heading shows the keyboard ring (page.css).
     An on-screen keyboard's keys (composing, or reported as 229) belong to a touch user and do not count. -->
<svelte:document onvisibilitychange={resume} onkeydowncapture={event => { if (!event.isComposing && event.keyCode !== 229) inputMode('keyboard'); }} onpointerdowncapture={() => inputMode('pointer')} />

<div class="workspace"><div class="app-shell" class:camera-active={screen === 'camera'}>
  <header class="masthead"><button aria-label={t('Bór czuwa')} class="brand" onclick={() => show(screen === 'welcome' ? 'welcome' : 'home')}><span class="brand-mark" aria-hidden="true">{@html brandMark}</span><span class="brand-name">{t('Bór czuwa')}</span></button>{#if screen !== 'welcome' && screen !== 'loading'}<div class="masthead-actions"><button aria-label={t('Moje zapisy')} class="library-entry" aria-describedby={taskCount ? 'pending-work-description' : undefined} onclick={() => show('library')}><span class="library-icon" aria-hidden="true">{@html svg('folder-open')}</span><span class="library-label">{t('Moje zapisy')}</span>{#if taskCount}<span class="task-count" aria-hidden="true" transition:reveal>{taskCount}</span>{/if}</button><button onclick={() => show('menu')}>{t('Menu')}</button></div>{/if}
  <span id="pending-work-description" class="sr-only">{taskCount ? fill(t('{count} do zrobienia'), { count: String(taskCount) }) : ''}</span></header>
  {#if demoTestRecipient}<p class="demo-status">{t('TEST · tylko fikcyjne zgłoszenia')}</p>{/if}
  <main aria-label={t('Zgłoszenie')}>
    <div class="screen-body" onscroll={() => navigation?.saveScroll()}>
      <!-- Present from the first paint so the line is announced when it arrives; it leaves with the screen change. -->
      {#if screen === 'loading'}<p class="calm startup-status" role="status">{#if startupLine && !error}<span in:textIn out:lineOut>{t(startupLine)}</span>{/if}</p>{/if}
      {#if screen === 'welcome' || screen === 'menu' || screen === 'recipients' || screen === 'signature' || screen === 'notice'}<DemoNotice {language} />{/if}
      {#if screen === 'welcome'}
        <!-- Language is shown first, above the heading, so whoever cannot read Polish finds it without
             scrolling. It follows the heading in the document, so the first Tab from the focused heading
             reaches it and a screen reader hears the heading first. -->
        <div class="welcome-head">
          <h1 tabindex="-1">{t('Zanim zaczniesz')}</h1>
          <div class="language-switch welcome-language" role="group" aria-label={t('Język interfejsu')}><button aria-pressed={language === 'pl'} lang="pl" onclick={event => void setWelcomeLanguage('pl', event.currentTarget)}>Polski</button><button aria-pressed={language === 'en'} lang="en" onclick={event => void setWelcomeLanguage('en', event.currentTarget)}>English</button></div>
        </div>
        <p>{t(demoTestRecipient ? 'Przećwicz zapis fikcyjnego zdarzenia i przygotowanie powiadomienia do skrzynki testowej.' : 'Zapisz, co widzisz lub słyszysz w terenie, i przygotuj powiadomienie do właściwego urzędu.')}</p>
        <p>{t('Bór czuwa to niezależny projekt. Nie prowadzi go państwo ani żaden urząd.')}</p>
        <p><strong>{t('Zgłoszenie nie sprowadza pomocy.')}</strong></p>
        <div class="welcome-location">
          <p>{t('GPS zapisze pozycję telefonu przy zdarzeniu. Bez dostępu do lokalizacji wskażesz miejsce na mapie.')}</p>
          <p class="muted">{t('Pozycja zostaje na telefonie, dopóki nie zapiszesz zgłoszenia.')}</p>
        </div>
        <details use:disclosure class="welcome-details">
          <summary>{t('Co dzieje się ze zgłoszeniem')}</summary>
          <p>{t('Zgłoszenia będą publikowane na publicznej mapie z przybliżonym miejscem i datą.')}</p>
          <p>{t('Świadomie fałszywe zgłoszenie jest przestępstwem. Zgłoszenie w dobrej wierze nim nie jest, nawet jeśli nie doszło do naruszenia.')}</p>
        </details>
        <nav class="welcome-links" aria-label={t('Dokumenty')}>
          <a href={privacyPolicyUrl}>{t('Polityka prywatności')}</a>
          <a href={termsOfUseUrl}>{t('Regulamin serwisu')}</a>
        </nav>
      {:else if screen === 'menu'}
        <h1 tabindex="-1">{t('Menu')}</h1>
        {#if demoTestRecipient && isAndroidApp}<DemoAccess {language} onconnected={() => { void sync?.wake(); }} />{/if}
        <h2 id="language-heading">{t('Język')}</h2>
        <div class="language-switch" role="group" aria-labelledby="language-heading"><button aria-pressed={language === 'pl'} lang="pl" onclick={() => setLanguage('pl')}>Polski</button><button aria-pressed={language === 'en'} lang="en" onclick={() => setLanguage('en')}>English</button></div>
        {#if language === 'en'}<p class="muted">{t('Powiadomienia do polskich organów są zawsze po polsku.')}</p>{/if}
        <section aria-labelledby="offline-heading">
          <h2 id="offline-heading" class="sr-only">{t('Bez internetu')}</h2>
          <div class="menu-status" role="status"><div class="menu-status-copy">{#key offlineSummary}<div transition:reveal><strong>{t(offlineSummary)}</strong>
            {#if offlineMissing}<small>{t(online ? 'Pobierz brakujące pliki, póki masz zasięg.' : 'Pliki pobiorą się same, gdy wróci internet.')}</small>
            {:else if !offlineReady && offlineStatus?.shell === 'ready'}<small>{t('Zapis zgłoszeń już działa bez internetu.')}</small>{/if}
          </div>{/key}</div></div>
          {#if offlineMissing && online}<div transition:reveal><button class="wide" onclick={() => void offlineReadiness?.prepare()}>{t('Pobierz brakujące pliki')}</button></div>{/if}
        </section>
        {#if appUpdate}
          <section class="version-status" aria-labelledby="version-heading"><div transition:reveal>
            <h2 id="version-heading" class="sr-only">{t('Wersja aplikacji')}</h2>
            <div class="menu-status"><div><strong>{t('Nowa wersja czeka')}</strong><small>{t('Uruchomi się sama, gdy następnym razem otworzysz aplikację.')}</small></div></div>
            <button class="wide" disabled={restarting} onclick={() => void restartApp()}>{t('Uruchom nową wersję')}</button>
          </div></section>
        {/if}
        {#if homePreset}
          <section class="home-saved" aria-labelledby="home-heading" transition:reveal>
            <div class="menu-status home-row"><div><strong id="home-heading">{t('Twój dom')}</strong><small>{t('Telefon pamięta Twój dom, żeby zgłoszenia z domu pokazywały tylko przybliżony obszar. Dom nie opuszcza telefonu.')}</small></div>
              <button bind:this={homeRemoveButton} class="home-remove" aria-expanded={confirmingHome} onclick={() => confirmingHome ? cancelHome() : askHome()}>{t('Usuń')}<span class="sr-only">{t(' zapisany dom')}</span></button></div>
            {#if confirmingHome}
              <div class="home-confirm" role="group" aria-labelledby="home-confirm-title" transition:reveal>
                <p id="home-confirm-title"><strong>{t('Usunąć zapisany dom?')}</strong></p>
                <p>{t('Zapisane zgłoszenia się nie zmienią. Przy następnym zgłoszeniu z domu telefon zapamięta go znowu.')}</p>
                <div class="withdrawal-confirm-actions"><button bind:this={homeCancel} onclick={cancelHome}>{t('Anuluj')}</button><button class="destructive" onclick={() => void removeHome()}>{t('Usuń')}</button></div>
              </div>
            {/if}
          </section>
        {:else if homeRemoved}
          <p id="home-result" class="result-line home-result" role="status" tabindex="-1" transition:reveal><span>{t('Dom usunięty z tego telefonu.')}</span></p>
        {/if}
        {#if signerSaved}
          <section class="home-saved" aria-labelledby="signer-heading" transition:reveal>
            <div class="menu-status home-row"><div><strong id="signer-heading">{t('Zapamiętane dane podpisu')}</strong></div>
              <button bind:this={signerRemoveButton} class="home-remove" aria-expanded={confirmingSigner} onclick={() => confirmingSigner ? cancelSigner() : askSigner()}>{t('Usuń')}<span class="sr-only">{t(' zapamiętane dane podpisu')}</span></button></div>
            {#if confirmingSigner}
              <div class="home-confirm signer-confirm" role="group" aria-labelledby="signer-confirm-title" transition:reveal>
                <p id="signer-confirm-title"><strong>{t('Usunąć zapamiętane dane podpisu?')}</strong></p>
                <p>{t('Zapisane zgłoszenia się nie zmienią. Dane wpiszesz znowu przy następnym podpisie.')}</p>
                <div class="withdrawal-confirm-actions"><button bind:this={signerCancel} onclick={cancelSigner}>{t('Anuluj')}</button><button class="destructive" onclick={() => void removeSigner()}>{t('Usuń')}</button></div>
              </div>
            {/if}
          </section>
        {:else if signerRemoved}
          <p id="signer-result" class="result-line home-result" role="status" tabindex="-1" transition:reveal><span>{t('Dane podpisu usunięte z tego telefonu.')}</span></p>
        {/if}
        {#if storageWarning}<div class="menu-status"><div><strong>{t('Telefon może usunąć zapisy, gdy zabraknie miejsca')}</strong><small>{t('Szkice i szczegóły zgłoszeń są tylko na tym telefonie.')}</small></div></div>{/if}
        <section class="reminder-settings" aria-labelledby="direction-map-label">
          <label class="choice reminder-switch"><input type="checkbox" role="switch" checked={directionMap} onchange={event => setDirectionMap(event.currentTarget.checked)} /><span><span id="direction-map-label">{t('Mapa pod tarczą kierunku')}</span><small>{t('Wczytywana z OpenStreetMap, gdy jest internet.')}</small></span></label>
        </section>
        {#if isAndroidApp}
          <section class="reminder-settings" aria-labelledby="reminders-label">
            <label class="choice reminder-switch"><input type="checkbox" role="switch" checked={draftReminders} onchange={event => void setDraftReminders(event.currentTarget.checked)} /><span><span id="reminders-label">{t('Przypomnienia o szkicach')}</span><small>{t('Następnego dnia po zapisaniu szkicu i trzy dni po nim, o 10:00.')}</small></span></label>
            {#if draftReminders && drafts.length && reminderIssue === 'exact'}
              <div transition:reveal>
                <div class="menu-status"><div><strong>{t('Przypomnienie może się spóźnić')}</strong><small>{t('Android może opóźnić przypomnienie. Włącz dokładne alarmy, żeby dostać je o 10:00.')}</small></div></div>
                <button class="wide" onclick={() => void turnOnExactReminders()}>{t('Włącz dokładne alarmy')}</button>
              </div>
            {:else if draftReminders && drafts.length && reminderIssue === 'notifications'}
              <div transition:reveal><div class="note"><p>{t('Nie udało się ustawić przypomnienia. Sprawdź uprawnienie do powiadomień.')}</p><button onclick={() => void retryReminders()}>{t('Spróbuj ponownie')}</button></div></div>
            {/if}
          </section>
        {/if}
        <div class="menu-list">
          <button onclick={() => show('welcome')}>{t('Informacje na początek')}</button>
          <a href={privacyPolicyUrl}>{t('Polityka prywatności')}</a>
          <a href={termsOfUseUrl}>{t('Regulamin serwisu')}</a>
        </div>
        <p class="muted">{t('Bór czuwa to niezależny projekt. Nie prowadzi go państwo ani żaden urząd.')}</p>
        {#if androidWeb}<p class="muted">{t('Aplikacja na Androida dodaje załączniki zdjęć do wiadomości i przypomina o szkicu następnego dnia i trzy dni po jego zapisaniu.')}</p>{/if}
      {:else if screen === 'home'}
        {#if storageBlocked}<p id="storage-blocked" class="note storage-blocked" role="status" tabindex="-1" transition:reveal>{t(storageBlockedCopy)}</p>{/if}
        {#if homeTask}
          {@const task = homeTask}
          <!-- One surface: a newer task crossfades its row in place instead of replacing the card. -->
          <div class="continuation record-card" transition:reveal use:followHeight><div class="task-stack">{#key task.id}<div class="task-slot" in:receiptIn out:receiptOut>{@render taskRow(task, undefined, cameraDeniedDraft === task.id ? 'camera-denial-feedback' : undefined)}</div>{/key}</div>{#if task.kind === 'draft'}{@render photoFeedback(task.item)}{/if}</div>
        {:else if work.automatic.length}
          <!-- The app's own work says something only when the Reporter would wonder: an upload waiting for signal. -->
          {#if queuedUploads && !online}<p class="calm" role="status" transition:reveal>{t(queuedUploads > 1 ? 'Zapisane zgłoszenia trafią na serwer, gdy będzie internet.' : 'Zapisane zgłoszenie trafi na serwer, gdy będzie internet.')}</p>{/if}
        {/if}
        <h1 tabindex="-1">{t('Co się stało?')}</h1>
        {@render eventRows(index => void capture(index))}
      {:else if screen === 'choose-event' && draft && coIsReceipt}
        <div id="receipt" class="receipt compact" role="status" tabindex="-1"><div class="receipt-copy">
          {#key !!draft.fix}<span class="receipt-state" in:receiptIn out:receiptOut><strong>{draft.fix ? t('Miejsce i czas zapisane') : t('Czas zapisany')}</strong><small>{capturedWhen(draft.capturedAt)} · {draft.fix ? `${t('Dokładność ')}${Math.round(draft.fix.accuracy_m)} m` : t('miejsce wskażesz później')}</small></span>{/key}
          {#if freshCapture === draft.id}<p>{t('Możesz już odejść. Wrócisz do tego zapisu, gdy będzie bezpiecznie.')}</p>{/if}
        </div></div>
        <h1 tabindex="-1" class="receipt-question">{t('Co się stało?')}</h1>
        {@render eventRows(index => void chooseEvent(index))}
      {:else if screen === 'choose-event' && draft}
        {@render stageHead('choose-event')}
        <h1 tabindex="-1">{t('Co się stało?')}</h1>
        {@render eventRows(index => void chooseEvent(index))}
      {:else if screen === 'camera'}
        <button class="back" onclick={goBack}>{@html svg('arrow-left')} {t('Wróć')}</button>
        <h1 tabindex="-1">{t('Zrób zdjęcie')}</h1>
        <p>{t('Fotografuj tylko to, co możesz bezpiecznie zobaczyć z miejsca, w którym jesteś.')}</p>
        <video class="camera-preview" use:attachCamera autoplay muted playsinline aria-label={t('Podgląd aparatu')}></video>
      {:else if screen === 'when' && draft}
        {@render stageHead('when')}
        <h1 tabindex="-1">{t('Kiedy to się stało?')}</h1>
        <!-- Show the safety note on the first present-tense visit in this session. -->
        {#if showSafety && (!draft.occurredMode || draft.occurredMode === 'now')}<div class="note when-note" transition:reveal>{t('Nie podchodź ani nie przeszkadzaj. Broń stwarza zagrożenie, a przeszkadzanie w polowaniu może mieć konsekwencje prawne.')}</div>{/if}
        <div class="answers" role="group" aria-label={t('Kiedy to się stało?')}>
          <button class="answer" aria-pressed={draft.occurredMode === 'now'} onclick={() => chooseWhen('now')}><span class="answer-text">{t('Teraz')}<small>{fill(t('zapisano o {time}'), { time: new Date(draft.capturedAt).toLocaleTimeString(language === 'en' ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' }) })}</small></span></button>
          <button class="answer" aria-pressed={draft.occurredMode === 'within_hours'} onclick={() => chooseWhen('within_hours')}><span>{t('Kilka godzin temu')}</span></button>
          <button class="answer" aria-pressed={draft.occurredMode === 'date_only'} onclick={() => chooseWhen('date_only')}><span>{t('Innego dnia')}</span></button>
        </div>
        {#if draft.occurredMode === 'within_hours'}
          <div transition:reveal><HourWheel value={draft.hoursAgo ?? 1} label={t('Ile godzin temu?')} onchange={hours => updateDraft({ hoursAgo: hours })} {t} /></div>
        {:else if draft.occurredMode === 'date_only'}
          <label class="field" transition:reveal>{t('Którego dnia?')}
            <input id="when-detail" type="date" max={warsawDate(new Date(draft.capturedAt))} value={draft.occurredDate ?? ''}
              aria-invalid={triedSave && draftIssues.includes('occurrence')} aria-describedby={triedSave && draftIssues.includes('occurrence') ? 'when-error' : undefined}
              oninput={event => updateDraft({ occurredDate: event.currentTarget.value })} />
            {#if triedSave && draftIssues.includes('occurrence')}<small id="when-error" class="field-error" role="alert">{t('Wybierz dzień, który już minął albo jest dzisiaj.')}</small>{/if}
          </label>
        {/if}
      {:else if screen === 'where' && draft}
        {@render stageHead('where')}
        <h1 tabindex="-1">{t(whereView === 'compass' ? directionCopy[draft.eventType ?? 0][0] : draft.eventType === 0 ? 'Skąd padł strzał?' : 'Gdzie to było?')}</h1>
        {#if !draft.occurredMode || draft.occurredMode === 'now'}
          <div class="location-methods" role="group" aria-label={t('Jak wskazać miejsce')}>
            <button type="button" aria-pressed={whereView !== 'map'} aria-disabled={!draft.fix} aria-describedby={draft.fix ? undefined : 'gps-status'}
              onclick={() => chooseLocationMethod('reporter')}>{t(draft.eventType === 2 ? 'Moje miejsce' : 'Kierunek')}</button>
            <button type="button" aria-pressed={whereView === 'map'} onclick={() => chooseLocationMethod('map')}>{t('Wskaż miejsce')}</button>
          </div>
          <!-- Only a missing fix needs saying; the buttons above already show what is possible. -->
          {#if !draft.fix}<p id="gps-status" class="location-status muted" role="status" transition:reveal>{t(locationDenied ? 'Brak zgody na lokalizację.' : 'Brak pozycji GPS.')}</p>{/if}
        {/if}
        <div class="location-panel"><div>
        {#key whereView}
        <div class="location-method-content">
        {#if whereView === 'compass'}
          {@const distance = hearingDistance(draft)}
          {@const [, hint] = directionCopy[draft.eventType ?? 0]}
          <p class="muted">{t(hint)}</p>
          <DirectionTarget {t} {distanceText} bearing={draft.hearingBearing} {distance} centre={draft.fix}
            onchange={next => updateDraft({ hearingBearing: next.bearing, hearingDistanceM: next.distance, hearingDistanceBand: undefined })} />
        {:else if whereView === 'reporter'}
          <p>{t('Miejsce zdarzenia to zapisana pozycja GPS. Jeśli było gdzie indziej, wybierz „Wskaż miejsce”.')}</p>
        {:else}
          <div class="location-selection" role="status">
            <strong>{t(manualPoint(draft) ? 'Miejsce wskazane' : 'Miejsce niewskazane')}</strong>
            {#if manualPoint(draft)}<p>{draftPlaceWords(draft, t, distanceText)}</p>{/if}
            <p class="muted">{t(manualPoint(draft) ? 'Popraw miejsce poniżej: względem znanego miejsca, współrzędnymi albo na mapie.' : 'Wskaż miejsce, aby przejść dalej.')}</p>
          </div>
          {#if triedSave && !manualPoint(draft)}<p class="field-error" role="alert">{t('Wskaż miejsce, aby przejść dalej.')}</p>{/if}
          <LocationPicker bind:open={mapOpen} initialLocation={draft.fix} selectedLocation={manualPoint(draft) ?? undefined} selectedReference={draft.manualReference}
            radiusM={manualPoint(draft) ? draft.pointRadiusM ?? defaultPointRadiusM : undefined}
            label={t('Mapa: dotknij miejsca zdarzenia')} onselect={chooseLocation} {t} />
          {#if manualPoint(draft)}
            {@const radius = draft.pointRadiusM ?? defaultPointRadiusM}
            {@const radiusText = radius ? fill(t('w promieniu około {distance}'), { distance: distanceText(radius) }) : t('dokładnie w tym miejscu')}
            <!-- Placed under the map with the radius, so a tap never moves the map under the finger. -->
            <div class="range" transition:reveal>
              <p class="location-selection"><strong>{t('Miejsce wskazane')}</strong></p>
              <label for="point-radius"><strong>{t('Jak dokładnie?')}</strong> <span>{radiusText}</span></label>
              <input id="point-radius" type="range" min="0" max={radiusSteps.length - 1} step="1"
                value={Math.max(0, radiusSteps.findIndex(step => step >= radius))} aria-valuetext={radiusText}
                oninput={event => updateDraft({ pointRadiusM: radiusSteps[Number(event.currentTarget.value)] })} />
              <div class="range-ends" aria-hidden="true"><span>{t('dokładnie')}</span><span>3 km</span></div>
            </div>
          {/if}
          <!-- Nothing while the phone is still trying; a refusal is named without offering a retry that cannot work. -->
          {#if !draft.fix && draft.occurredMode === 'now' && locating !== draft.id}
            <div class="location-problem" transition:reveal>
              {#if locationError}<p role="alert">{locationError}</p>{/if}
              {#if locationDenied}
                <p>{t(isAndroidApp
                  ? 'Aby włączyć GPS, otwórz Ustawienia telefonu → Aplikacje → Bór czuwa → Uprawnienia → Lokalizacja. Zezwól na dostęp i wróć do aplikacji.'
                  : 'Aby włączyć GPS, otwórz ustawienia uprawnień tej strony w przeglądarce i zezwól na lokalizację. Potem wróć do aplikacji.')}</p>
              {:else}<button type="button" class="quiet" onclick={() => retryLocation(draft!)}>{t('Spróbuj ustalić miejsce ponownie')}</button>{/if}
            </div>
          {/if}
        {/if}
        </div>
        {/key}
        </div></div>
      {:else if screen === 'details' && draft}
        {#key draft.id}
        {@const origin = placeOrigin(draft)}
        {@const decided = resolvedHome({ ...draft, fromHome: undefined }, homePreset)}
        {@const home = resolvedHome(draft, homePreset)}
        {@const placeProblem = triedSave ? blockingIssues.find(issue => issue === 'manual_point') : undefined}
        {@render stageHead('details')}
        <h1 tabindex="-1">{t('Sprawdź i zapisz')}</h1>
        <div class="review-rows">
          <div class="review-row"><div><strong>{t('Co')}</strong><span class="value">{t(events[draft.eventType ?? 0][0])}</span></div><button type="button" aria-label={`${t('Zmień')}: ${t('Co')}`} onclick={() => edit('choose-event')}>{t('Zmień')}</button></div>
          <div id="when-row" class="review-row" class:missing={draftIssues.includes('occurrence')}><div><strong>{t('Kiedy')}</strong><span class="value">{draftIssues.includes('occurrence') ? t('Popraw czas zdarzenia.') : whenWords(draft)}</span></div><button type="button" aria-label={`${t('Zmień')}: ${t('Kiedy')}`} onclick={() => edit('when')}>{t('Zmień')}</button></div>
          <div id="place-row" class="review-row" class:missing={!origin || !!placeProblem}><div><strong>{t('Gdzie')}</strong><span class="value">{draftPlaceWords(resolved!, t, distanceText)}</span>
            {#if placeProblem}<small class="field-error" role="alert">{issueText(placeProblem, draft)}</small>{/if}</div>
            <button type="button" aria-label={`${t('Zmień')}: ${t('Gdzie')}`} onclick={() => edit('where')}>{t('Zmień')}</button></div>
        </div>
        {#if origin && ((decided === undefined && draft.fromHome === undefined) || draftIssues.includes('near_home') || draftIssues.includes('moved_point'))}
          {@const problem = draftIssues.find(issue => issue === 'home' || issue === 'near_home' || issue === 'moved_point')}
          <fieldset id="home-check" class="home-check" class:missing={triedSave && !!problem} transition:reveal>
            <legend>{t(choosesPoint(draft) ? 'Czy to Twój dom lub podwórko?' : 'Czy jesteś w domu lub na podwórku?')}</legend>
            <div class="segmented">
              <button type="button" aria-pressed={draft.fromHome === true} onclick={() => updateDraft({ fromHome: true })}>{t('Tak')}</button>
              <button type="button" aria-pressed={draft.fromHome === false} onclick={() => updateDraft({ fromHome: false })}>{t('Nie')}</button>
            </div>
            {#if triedSave && problem && problem !== 'home'}<small class="field-error" role="alert">{issueText(problem, draft)}</small>
            {:else}<small>{t('Jeśli tak, nie pokażemy, gdzie mieszkasz.')}</small>{/if}
          </fieldset>
        {/if}
        {#if draft.eventType === 2}
          <section id="photo-required" class="required-photo" class:missing={triedSave && draftIssues.includes('photo')} aria-labelledby="photo-required-title">
            <h2 id="photo-required-title">{t('Zdjęcie szczątków')} <small>{t('wymagane')}</small></h2>
            {#if !draft.photos?.length}<p class="muted">{t('Fotografuj tylko to, co widzisz z miejsca, w którym jesteś.')}</p>{/if}
            {@render photoControls(draft)}
          </section>
        {/if}
        {#if origin && home !== undefined}
          <div class="kept-place" transition:reveal>
            <MapDisclosure bind:open={mapOpen} {t}>
            <KeptArea area={keptArea} point={origin} mark={keptArea && draft.fix && !choosesPoint(draft) ? { at: draft.fix, label: t(home ? 'Dom' : 'Ty') } : undefined} {t} />
            </MapDisclosure>
            <div class="privacy"><div><p>{draftPrivacyLine(resolved!, t)}</p>{#if draft.fromHome === undefined && home}<button type="button" class="quiet" onclick={() => updateDraft({ fromHome: false })}>{t('Nie jestem w domu')}</button>
              {:else if draft.fromHome !== undefined}<button type="button" class="quiet" onclick={() => updateDraft({ fromHome: undefined })}>{t('Zmień odpowiedź')}</button>{/if}</div></div>
          </div>
        {/if}
        <h2 class="section-label">{t('Możesz dodać')}</h2>
        {#if draft.eventType === 2 || draft.eventType === 3}<SpeciesChoice value={draft.species} onchange={species => updateDraft({ species })} {t} />{/if}
        {#if draft.eventType === 0 && draft.photos?.length}
          <fieldset class="choice-reveal"><legend>{t('Zdjęcia')} <small>{t('usuń przed zapisaniem')}</small></legend>
            {@render photoControls(draft)}
          </fieldset>
        {:else if draft.eventType !== 0 && draft.eventType !== 2}
          <details class="disclosure" use:disclosure={!!draft?.photos?.length}>
            <summary>{t('Zdjęcia')} <small>{draft.photos?.length ? `${draft.photos.length}${t(' z 3 zdjęć')}` : t('najwyżej 3')}</small></summary>
            <div class="choice-reveal disclosure-body">
              {#if draft.eventType === 1}<p>{t('Zdjęcie osoby nie jest potrzebne. Możesz pokazać miejsce lub ślady, jeśli masz je już bezpiecznie.')}</p>{/if}
              {@render photoControls(draft)}
            </div>
          </details>
        {/if}
        <details class="disclosure" use:disclosure={!!draft?.note}>
          <summary>{t('Notatka')}{#if draft.note?.trim()} <small>{draft.note.length}{t(' z 500 znaków')}</small>{/if}</summary>
          <div class="choice-reveal disclosure-body">
            <label for="report-note">{t('Co jeszcze chcesz przekazać?')}</label>
            <textarea id="report-note" maxlength="500" value={draft.note ?? ''} oninput={event => updateDraft({ note: event.currentTarget.value }, { wait: 400 })}></textarea>
            <small>{t('Notatka zostaje na telefonie. Zobaczą ją tylko urzędy, do których napiszesz.')}</small>
          </div>
        </details>
        {/key}
      {:else if screen === 'library'}
        <RecordLibrary tasks={work.tasks} {reports} {withdrawals} {t} when={libraryWhen} reportRow={libraryRow} {taskRow} {openReport} {removeDraft} result={withdrawnReportId ? withdrawalResult : undefined} notice={newerDatabase ? databaseNotice : undefined} bind:confirming={confirmingDelete} bind:this={library} />
      {:else if screen === 'report' && report}
        {@const synced = isSynced(report)}
        {@const syncLine = syncState(report)}
        {@const estimated = estimatedPlace(report.report.incident_location)}
        <button class="back" onclick={goBack}>{@html svg('arrow-left')} {t('Wróć')}</button>
        <h1 tabindex="-1">{t('Zgłoszenie')}</h1>
        <!-- The reference strip, as at the head of a field-book page: the Event and its time, and the record's number. -->
        <div class="ref-strip">
          <p class="ref-event">{@render eventGlyph(eventTypes.indexOf(report.report.event_type))}<span><strong class="ref-title">{eventLabel(report.report.event_type)}</strong><small>{date(report.report.occurred_at.at)}</small></span></p>
          <p class="ref-no"><small>{t('Nr zapisu')}</small><b>{recordNumber(report.report.id)}</b></p>
        </div>
        <!-- Confirmation, then the one thing to do next, then what the Report established. -->
        <ul class="report-status" aria-label={t('Stan zgłoszenia')}>
          <li><div><small role={report.sync_error ? 'alert' : 'status'}><span class="result-copy" use:followHeight><span class="result-stack">{#key syncLine}<span in:receiptIn out:lineOut>{syncLine}</span>{/key}</span></span></small>
            {#if report.retry_at && report.retry_stage === 'report' && report.retry_reason !== 'rate_limit' && online}<div transition:reveal><button class="quiet" onclick={() => void retrySync(report!)}>{t('Spróbuj teraz')}</button></div>{/if}
          </div></li>
        </ul>
        <div class="report-action">
          <button class="primary wide" onclick={() => report?.notices?.length ? void openNotice(report.notices[0]) : openRecipients()}>{t(report.notices?.length ? 'Powiadomienia do urzędów' : 'Przygotuj powiadomienie')}</button>
          {#if report.notices?.length}
            <p class="report-action-note">{fill(t('Przekazano {n} z {m}.'), { n: String(report.notices.filter(item => noticeState(item) === 'confirmed_by_reporter').length), m: String(report.notices.length) })}</p>
            <div class="rows report-notices">
              {#each report.notices as notice (notice.id)}
                <button class="row" onclick={() => void openNotice(notice)}><span><strong>{notice.recipient.name}</strong>{#if noticeState(notice) !== 'not_notified'}<small>{t(noticeStates[noticeState(notice)])}</small>{/if}{#if notice.outcomes?.length}<small>{t('Zgłoszony przez Ciebie wynik')}: {t(outcomeLabels[notice.outcomes.at(-1)!.outcome])}</small>{/if}</span>{@html svg('chevron-right')}</button>
              {/each}
            </div>
            <button class="quiet" onclick={openRecipients}>{t('Dodaj powiadomienie')}</button>
          {:else}<p class="report-action-note">{t('Powiadomienie jest opcjonalne. Nie musisz czekać na pomiary.')}</p>{/if}
        </div>
        <FindingsSummary report={report.report} findings={report.findings} rule={findingRules} {language} waiting={findingsState(report)}
          retry={report.retry_at && report.retry_stage === 'findings' && report.retry_reason !== 'rate_limit' && online ? () => void retrySync(report!) : undefined}
          ambonaHref={report.findings.status === 'computed' ? apiUrl(`/api/geodata/${report.findings.geodata_snapshot_id}/ambony`) : ''}
          ambonaDisabled={geodataDownloading}
          ambonaError={geodataError}
          onambona={event => { if (nativeDemoAccessEnabled()) { event.preventDefault(); void downloadDemoGeodata(report!.findings.status === 'computed' ? report!.findings.geodata_snapshot_id : ''); } }} />
        <details class="disclosure" use:disclosure={{ easing: 'ease-in-out' }}><summary>{t('Szczegóły zgłoszenia')}</summary><div class="disclosure-body">
        {#if report.note}<p class="local-note">{report.note}</p>{/if}
        {#each report.photos ?? [] as photo, index (photo.id)}<button disabled={fileSaving} onclick={() => void downloadPhoto(photo, index)}>{t('Pobierz zdjęcie')} {index + 1}</button>{/each}
        <dl class="facts"><div><dt>{t('Miejsce zdarzenia')}</dt><dd>{reportPlaceSentence(report.report.incident_location, report.report.event_type, t)}<small>{estimated ? t('Odległość od zabudowań podają pomiary powyżej.') : reportPlaceDetail(report.report, t)}</small></dd></div></dl>
        {#if 'type' in report.report.incident_location && (report.report.event_type === 'shot' || report.report.incident_location.basis === 'estimated_from_sighting')}
          <details use:disclosure={{ easing: 'ease-in-out' }}><summary>{t('Opis miejsca do powiadomienia')}</summary><p>{incidentAreaDescription(report.report.incident_location, report.report.event_type, t)}</p></details>
        {/if}
        </div></details>

        <div class="withdrawal">
          <button class="quiet withdrawal-action" bind:this={withdrawalButton} aria-expanded={confirmingWithdrawal} disabled={saving} onclick={() => confirmingWithdrawal ? cancelWithdrawal() : askWithdrawal()}>{t('Wycofaj zgłoszenie')}</button>
          {#if confirmingWithdrawal}
            <!-- The Draft delete pattern: it unfolds under its action while the screen glides it into view. -->
            <section class="withdrawal-confirm" role="group" aria-labelledby="withdrawal-title" transition:reveal={unfold}>
              <h2 id="withdrawal-title">{t('Wycofać to zgłoszenie?')}</h2>
              <p>{t('Dane znikną z tego telefonu. Usunięcie z serwera może potrwać. Wysłanych powiadomień to nie cofa.')}</p>
              <p>{t('Wycofać zgłoszenie można tylko z tego telefonu. Po usunięciu aplikacji lub danych przeglądarki nie da się go już wycofać.')}</p>
              <div class="withdrawal-confirm-actions"><button bind:this={withdrawalCancel} disabled={saving} onclick={cancelWithdrawal}>{t('Anuluj')}</button><button class="destructive" disabled={saving} onclick={() => void withdraw(report!)}>{t('Wycofaj')}</button></div>
            </section>
          {/if}
        </div>
        <button class="wide report-done" onclick={() => show('home')}>{t('Gotowe, wróć do początku')}</button>
      {:else if screen === 'recipients' && report}
        {@render preparationHead('recipients')}
        <h1 tabindex="-1">{t('Do kogo napisać?')}</h1>
        {#if recipientBusy}<p role="status">{t('Sprawdzam właściwe urzędy…')}</p>{/if}
        <!-- With nothing suggested, choosing by name is the step, so its opener follows the status sentence;
             in short landscape the two sit side by side so both fit above the footer. The search keeps
             this place while the sentence changes (offline, retry), so an open search is never dropped. -->
        <div class="recipient-gap">
          <div class="recipient-gap-status">
          {#if recipientsOffline}
            <div class="note" role="status" transition:reveal>{t('Podpowiedzi urzędów dla tego miejsca wymagają połączenia z internetem.')}</div>
          {:else if recipientIssue === 'unavailable'}
            <div class="note" role="status" transition:reveal>{t('Nie udało się pobrać podpowiedzi urzędów. Spróbuj ponownie lub dokończ później.')}</div>
          {:else if recipientIssue === 'unresolved'}
            <div class="note" role="status" transition:reveal>{t(recipientSuggestion?.roles.length
              ? 'Nie znaleziono części właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.'
              : 'Nie znaleziono właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.')}</div>
          {/if}
          </div>
          {#if recipientSearchFirst && recipientCatalog && !catalogMissing}<div class="recipient-gap-search" transition:reveal>{@render recipientSearch()}</div>{/if}
        </div>
        {#if online && (recipientIssue === 'unavailable' || recipientIssue === 'offline') && !catalogMissing}
          <div transition:reveal><button class="wide" onclick={() => void loadRecipients()}>{t('Spróbuj ponownie')}</button></div>
        {/if}
        {#if catalogMissing}
          {#if gminaAnswer !== undefined}<p class="recipient-place"><strong>{recipientPlaces?.gmina ?? t('Nie ustalono')}</strong>
            {#if selectedGmina}<small>{gminaDetail(selectedGmina)}</small>{/if}</p>{/if}
          <div class="note" role="alert"><strong>{t('Nie udało się wczytać katalogu urzędów.')}</strong>
            <p>{t('Połącz się z internetem i spróbuj ponownie. Zgłoszenie jest zapisane.')}</p></div>
          <button class="wide" onclick={() => void loadRecipients()}>{t('Spróbuj ponownie')}</button>
        {:else if recipientCatalog}
          {@const isArea = 'type' in report.report.incident_location}
          <section class="notice-place" aria-labelledby="notice-place-title">
            <h2 id="notice-place-title">{t('Miejsce w powiadomieniu')}</h2>
            <p class="recipient-place" aria-live="polite"><strong>{recipientPlaces?.gmina ?? t('Nie ustalono')}</strong>
              {#if selectedGmina}<small>{gminaDetail(selectedGmina)}</small>{/if}
            </p>
            <small>{t('Wybór gminy zmienia tylko treść powiadomienia. Miejsce na mapie i odbiorców wybierasz osobno.')}</small>
            {#if recipientSuggestion?.gminaQuestion}
              <fieldset class="choices incident-gmina" class:missing={blockedPress && gminaUnanswered}>
                <legend>{isArea ? t('Obszar obejmuje kilka gmin. W której gminie to było?') : t('Miejsce leży na granicy gmin. W której gminie to było?')}</legend>
                {#each recipientSuggestion.gminy as gmina (gmina.id)}
                  <label class="choice"><input type="radio" name="incident-gmina" checked={gminaAnswer === gmina.id} onchange={() => void chooseGmina(gmina.id)} />
                    <span><strong>{gmina.place ?? gmina.name}</strong><small>{gminaDetail(gmina)}</small></span></label>
                {/each}
                <label class="choice"><input type="radio" name="incident-gmina" checked={gminaAnswer === null} onchange={() => void chooseGmina(null)} />
                  <span><strong>{t('Nie wiem')}</strong></span></label>
              </fieldset>
            {/if}
            {#if gminaAnswer === null}<small>{t('Powiadomienie poda, że gminy nie ustalono.')}</small>{/if}
            {#if gminaCorrection}<small>{t('Gmina wskazana przez Ciebie. Sprawdź osobno, czy wybrane urzędy zajmują się tą sprawą.')}</small>{/if}
            <button class="wide" bind:this={placeChangeButton} aria-expanded={placeSearchOpen} onclick={() => void openPlaceSearch()}>{t('Zmień gminę')}</button>
            {#if placeSearchOpen}
              <div class="recipient-search-panel">
                <label class="recipient-search">{t('Nazwa gminy')}<input type="search" bind:this={placeSearchInput} bind:value={placeQuery} autocomplete="off" aria-describedby="place-result-count" /></label>
                <p id="place-result-count" class="result-count" role="status">{placeQuery.trim().length < 2 ? t('Wpisz co najmniej dwie litery.')
                  : !placeResults.total ? t('Nie znaleziono gminy. Spróbuj innej nazwy.')
                  : placeResults.total > placeResults.units.length
                    ? `${t('Znaleziono')}: ${placeResults.total}. ${t('Pokazuję pierwsze')} ${placeResults.units.length}. ${t('Wpisz więcej liter, żeby zawęzić.')}`
                    : `${t('Znaleziono')}: ${placeResults.total}.`}</p>
                <ul class="recipient-results">
                  {#each placeResults.units as unit (unit.id)}
                    <li><button class="recipient-result" onclick={() => void chooseGmina(unit.id, unit, true)}><strong>{unit.place ?? unit.name}</strong><small>{gminaDetail(unit)}</small></button></li>
                  {/each}
                </ul>
                <button class="wide" onclick={async () => { placeSearchOpen = false; await tick(); placeChangeButton?.focus(); }}>{t('Zamknij wyszukiwanie')}</button>
              </div>
            {/if}
            {#if gminaAnswer !== null && !gminaUnanswered}<button class="wide quiet" onclick={() => void chooseGmina(null, undefined, true)}>{t('Nie wiem, która gmina')}</button>{/if}
            {#if gminaAnswer !== undefined && (recipientSuggestion?.gminy.length || recipientSuggestion?.places)}<button class="wide quiet" onclick={() => void chooseGmina(undefined, undefined, true)}>{t('Przywróć podpowiedź z miejsca zdarzenia')}</button>{/if}
          </section>
          {#if isArea && !recipientIssue && !recipientsOffline}<small>{t('Przybliżony obszar. Sprawdź proponowane urzędy.')}</small>{/if}
          {#if recipientSuggestion?.roles.length}<h2 class="sr-only">{t('Proponowane urzędy')}</h2>{/if}
          {#each recipientSuggestion?.roles ?? [] as role (role.kind)}
            {#if role.kind === 'gmina'}
              <details class="disclosure" use:disclosure><summary>{fill(t('Gmina (do wiadomości): {selection}'), { selection: recipientChoices.some(choice => choice.unit.kind === 'gmina' && choice.selected) ? fill(t('wybrano {n}'), { n: String(recipientChoices.filter(choice => choice.unit.kind === 'gmina' && choice.selected).length) }) : t('nie wybrano') })}</summary>
                {@render recipientGroup(role)}
              </details>
            {:else}{@render recipientGroup(role)}{/if}
          {/each}
          {@const added = recipientChoices.filter(choice => !suggestedKeys.has(`${choice.unit.kind}:${choice.unit.id}`))}
          {#if added.length}
            <fieldset class="recipient-group"><legend>{t('Wybrane po nazwie')}</legend>
              {#each added as choice (`${choice.unit.kind}:${choice.unit.id}`)}{@render recipientChoice(choice, false)}{/each}
            </fieldset>
          {/if}
          {#if recipientSuggestion?.provenance}
            <details class="disclosure" use:disclosure><summary>{t('Źródła urzędów')}</summary>
              <p class="provenance"><small>{t('Granice jednostek według migawki danych')} {recipientSuggestion.provenance.snapshot_id}, {t('katalog urzędów z')} {recipientSuggestion.provenance.directory_version}.</small></p>
              {#each recipientSuggestion.gminy as gmina (gmina.id)}<p><strong>{gmina.place ?? gmina.name}</strong><small>{gminaDetail(gmina)}</small></p>{/each}
            </details>
          {/if}
          {#if !recipientSearchFirst}<div transition:reveal>{@render recipientSearch()}</div>{/if}
        {/if}
      {:else if screen === 'signature' && report}
        {@render preparationHead('signature')}
        <h1 tabindex="-1">{t('Jak chcesz się podpisać?')}</h1>
        {#if language !== 'pl'}<p>{t('Treść po polsku.')}</p>{/if}
        {#if report.findings.status !== 'computed'}<div class="note">{t('Pomiary nie są jeszcze dostępne. Powiadomienie poinformuje, że ich brakuje.')}</div>{/if}
        <fieldset class="choices"><legend class="sr-only">{t('Podpis powiadomienia')}</legend>
          <label class="choice"><input type="radio" name="signature" aria-label={t('Z podpisem')} aria-describedby="signed-choice-help" checked={noticeVariant === 'signed'} onchange={() => chooseSignature('signed')} /> <span><strong>{t('Z podpisem')}</strong><small id="signed-choice-help">{t('Odbiorca zobaczy Twoje imię, nazwisko, adres do korespondencji i telefon, jeśli go podasz. Nie wysyłamy tych danych na nasz serwer.')}</small></span></label>
          <label class="choice"><input type="radio" name="signature" aria-label={t('Bez podpisu')} aria-describedby="unsigned-choice-help" checked={noticeVariant === 'unsigned'} onchange={() => chooseSignature('unsigned')} /> <span><strong>{t('Bez podpisu')}</strong><small id="unsigned-choice-help">{t('Odbiorca zobaczy adres Twojej poczty. Możesz nie otrzymać odpowiedzi.')}</small></span></label>
        </fieldset>
        {#if noticeVariant === 'signed'}
          <div class="choice-detail signature-fields" transition:reveal>
            {@render signerFields(signer)}
            <label class="choice"><input type="checkbox" bind:checked={rememberDetails} /> <span>{t('Zapamiętaj te dane na tym telefonie')}</span></label>
          </div>
        {/if}
      {:else if screen === 'notices' && report}
        {@const confirmedCount = (report.notices ?? []).filter(item => noticeState(item) === 'confirmed_by_reporter').length}
        <button class="back" onclick={goBack}>{@html svg('arrow-left')} {t('Wróć')}</button>
        <h1 tabindex="-1">{t('Powiadomienia do urzędów')}</h1>
        <p><span class="badge">{fill(t('Przekazano {n} z {m}.'), { n: String(confirmedCount), m: String(report.notices?.length ?? 0) })}</span></p>
        <div class="rows">
          {#each report.notices ?? [] as notice (notice.id)}
            {@const checkInAt = signedNoticeCheckInAt(notice)}
            <button class="row" onclick={() => void openNotice(notice)}><span><strong>{notice.recipient.name}</strong>{#if noticeState(notice) !== 'not_notified'}<span class="badge">{t(noticeStates[noticeState(notice)])}</span>{/if}{#if notice.outcomes?.length}<small>{t('Zgłoszony przez Ciebie wynik')}: {t(outcomeLabels[notice.outcomes.at(-1)!.outcome])}</small>{/if}{#if checkInEnabled && checkInAt && checkInAt.getTime() <= clockNow}<small>{t('Sprawdź, czy urząd odpowiedział.')}</small>{/if}</span>{@html svg('chevron-right')}</button>
          {/each}
        </div>
        <button class="quiet" onclick={openRecipients}>{t('Dodaj powiadomienie')}</button>
      {:else if screen === 'notice' && report && currentNotice}
        {@const notice = currentNotice}
        {@const state = noticeState(notice)}
        {@const route = noticeRoute(notice)}
        {@const asking = !!notice.askHandoff && state !== 'confirmed_by_reporter'}
        {@const signerMissing = notice.variant === 'signed' && !signedReady(signedByNotice[notice.id])}
        <!-- Keyed so a disclosure opened on one Notice is not open on the next. -->
        {#key notice.id}
        <button class="back" onclick={goBack}>{@html svg('arrow-left')} {t('Wróć')}</button>
        <p class="notice-position">{#if (report.notices?.length ?? 0) > 1}<span>{fill(t('Powiadomienie {n} z {m}'), { n: String((report.notices ?? []).findIndex(item => item.id === notice.id) + 1), m: String(report.notices?.length ?? 0) })}</span>{/if}<span>{notice.variant === 'signed' ? t('Z podpisem') : t('Bez podpisu')}</span></p>
        <h1 tabindex="-1" lang="pl">{notice.recipient.name}</h1>
        <!-- The name already says what the authority is; a state shows once something has happened. -->
        {#if state !== 'not_notified'}<p class="notice-recipient"><span class="badge">{t(noticeStates[state])}</span></p>{/if}
        {#if notice.variant === 'signed' && needsSignerEntry[notice.id] && signedByNotice[notice.id]}
          <div class="signer-again">
            <p>{t('Dane podpisu nie zostały zapamiętane. Wpisz je ponownie dla tego powiadomienia.')}</p>
            {@render signerFields(signedByNotice[notice.id])}
          </div>
        {/if}
        {#if state !== 'confirmed_by_reporter' && !asking}
          {#if route === 'mail'}
            <div class="handoff-route"><div><strong>{t('Wyślesz ze swojej poczty')}</strong><p class="route-address">{#each currentRecipient!.split(/(?<=[@.])/) as part, index (index)}{#if index}<wbr />{/if}{part}{/each}</p>
              {#if report.photos?.length}<p class="muted"><small>{t(isAndroidApp ? 'Zdjęcia są tylko na tym urządzeniu. Otwórz pocztę i sprawdź adres, temat, treść oraz załączniki przed wysłaniem.' : 'Zdjęcia są tylko na tym urządzeniu. Wybierz aplikację pocztową i sprawdź adres, temat, treść oraz załączniki przed wysłaniem. Jeśli nie możesz udostępnić zdjęć, pobierz je i dodaj ręcznie.')}</small></p>{/if}</div></div>
            {#if noticeText && !isAndroidApp && handoff && !handoff.withBody}<div class="note">{t('Treść skopiujemy do schowka. Wklej ją do wiadomości.')}</div>{/if}
            {#if notice.variant === 'signed'}<p class="route-switch"><button class="quiet" onclick={() => { pdfChosen = { ...pdfChosen, [notice.id]: true }; }}>{t(demoTestRecipient ? 'Pobierz testowy PDF' : 'Złóż PDF w serwisie urzędowym')}</button></p>{/if}
          {:else if route === 'pdf'}
            <div class="handoff-route"><div><strong>{t(demoTestRecipient ? 'Testowy PDF do przejrzenia' : 'Złożysz PDF w serwisie urzędowym')}</strong>
              <p class="muted"><small>{t('PDF zostaje na tym telefonie. Wpisane dane nie są podpisem elektronicznym.')}</small></p></div></div>
            {#if pdfOffline}<p id="pdf-offline" class="note">{t('Bez internetu PDF jeszcze nie działa. Po połączeniu aplikacja pobierze potrzebne pliki.')}</p>{/if}
            {#if pdfText}<details class="disclosure" use:disclosure><summary>{t('Przejrzyj PDF')}</summary><div class="disclosure-body" lang="pl"><p>{handoffText(notice.recipient.name)}</p><p>{pdfText.subject}</p><pre class="pdf-body">{pdfText.body}</pre></div></details>{/if}
          {:else}
            <div class="handoff-route"><div><strong>{t('Brak potwierdzonego adresu')}</strong>
              <p class="muted"><small>{t('Skopiuj treść i wklej ją do wiadomości albo formularza urzędu.')}</small></p></div></div>
            {#if !demoTestRecipient && notice.recipient.sourceUrl}<a class="wide-link" href={notice.recipient.sourceUrl} target="_blank" rel="noreferrer">{@html svg('external-link')} {t('Otwórz stronę urzędu')}</a>{/if}
          {/if}
        {/if}
        {#if route === 'pdf' && state !== 'confirmed_by_reporter'}
          {#if demoTestRecipient}<p class="note">{t('PDF i zdjęcia przekazuj tylko do skrzynki testowej. Nie korzystaj z serwisów urzędowych.')}</p>
          {:else}{@render filingGuide()}{/if}
        {/if}
        {#if asking}
          <section class="handoff-question" aria-labelledby="handoff-question">
            <h2 id="handoff-question" tabindex="-1">{t('Udało się wysłać?')}</h2>
            <p>{t(demoTestRecipient && notice.handoffRoute === 'pdf' ? 'Pobranie PDF nie potwierdza wysłania do skrzynki testowej.' : notice.handoffRoute === 'pdf' ? 'Pobranie PDF ani otwarcie serwisu nie potwierdza złożenia lub doręczenia.' : 'Nie widzimy, co stało się w Twojej poczcie. Zapiszemy tylko Twoją odpowiedź.')}</p>
            <div class="stack">
              <button class="primary" disabled={saving} onclick={() => void noticeStep(notice, 'confirmed_by_reporter')}>{t(!demoTestRecipient && notice.handoffRoute === 'pdf' ? 'Potwierdzam przekazanie przez serwis urzędowy' : 'Potwierdzam przekazanie')}</button>
              <button onclick={() => void noticeStep(notice, 'not_yet')}>{t('Jeszcze nie')}</button>
            </div>
          </section>
        {/if}
        {#if !noticeText && !signerMissing}<div class="note">{t('Nie można przygotować powiadomienia dla tego zdarzenia.')}</div>{/if}
        {#if state === 'confirmed_by_reporter'}
          <details class="disclosure" use:disclosure><summary>{t('Wynik zgłoszony przez Ciebie')}{#if notice.outcomes?.length}<small>{t(outcomeLabels[notice.outcomes.at(-1)!.outcome])}</small>{/if}</summary><div class="disclosure-body outcome-section">
            <p>{t('Wynik wpisujesz samodzielnie. Nie potwierdzamy odpowiedzi ani doręczenia.')}</p>
            {#if checkInEnabled && awaitingSignedNoticeReply(notice)}
              <p>{t('Przypomnienie o sprawdzeniu odpowiedzi przypada sześć tygodni po Twoim potwierdzeniu. To nie jest termin prawny.')}</p>
              {#if followUpReminderIssue && isAndroidApp}<p>{t('Android może opóźnić przypomnienie. Sprawdź ustawienia powiadomień.')}</p>{/if}
            {/if}
            {#if notice.outcomes?.length}
              <ol>
                {#each notice.outcomes as item (item.id)}
                  <li>{item.observed_on}: {t(outcomeLabels[item.outcome])} · {t('Zapisano')} {date(item.at)}</li>
                {/each}
              </ol>
            {/if}
            <label>{t('Odpowiedź urzędu')}
              <select value={outcomeCode ?? ''} onchange={event => outcomeCode = event.currentTarget.value as NoticeOutcome['outcome'] || undefined}>
                <option value="">{t('Wybierz wynik')}</option>
                {#each Object.entries(outcomeLabels) as [code, label] (code)}
                  <option value={code}>{t(label)}</option>
                {/each}
              </select>
            </label>
            <label>{t('Dzień wyniku')} <input type="date" max={warsawDate(new Date())} bind:value={outcomeDate} /></label>
            <button disabled={!outcomeCode || !outcomeDate || outcomeDate > warsawDate(new Date()) || saving} onclick={() => void saveOutcome(notice)}>{t(notice.outcomes?.length ? 'Zapisz korektę' : 'Zapisz wynik')}</button>
          </div></details>
          {#if !demoTestRecipient && notice.recipient.email}
            <details class="disclosure" use:disclosure><summary>{t('Adres urzędu nie działa?')}</summary><div class="disclosure-body">
              <p>{t('Jeśli poczta odrzuciła adres lub wiadomość wróciła, zgłoś adres do sprawdzenia. Przekażemy tylko identyfikator urzędu i dzień zgłoszenia, bez Twoich danych ani treści wiadomości.')}</p>
              <button class="wide" disabled={flaggingAddress || !!flaggedAddresses[notice.id]} onclick={() => void flagAddress(notice)}>{t(flaggedAddresses[notice.id] ? 'Adres zgłoszony do sprawdzenia' : 'Zgłoś adres do sprawdzenia')}</button>
            </div></details>
          {/if}
        {/if}
        {#if noticeText}
          {@const shown = noticeFindings(report, notice)}
          <!-- The PDF preview already shows this text on the PDF route. -->
          {#if !(route === 'pdf' && pdfText && state !== 'confirmed_by_reporter' && !asking)}<details class="disclosure" use:disclosure><summary>{t('Przejrzyj treść powiadomienia')}</summary><div class="disclosure-body"><p class="notice-subject" lang="pl">{noticeText.subject}</p><pre class="notice-body" lang="pl">{noticeText.body}</pre></div></details>{/if}
          <details class="disclosure" use:disclosure><summary>{t('Źródła danych i reguły')}</summary><div class="disclosure-body">
            {#if shown.status === 'computed'}
              <p><small>{t('Zestaw reguł:')} {shown.rule_set_id}</small></p>
              {#each shown.datasets as dataset (dataset.name)}
                <p><small>{dataset.name}</small></p>
              {/each}
            {:else}
              <p><small>{t('Zestaw reguł:')} {noticeRuleSet(report.report, shown).id}</small></p>
            {/if}
          </div></details>
          {#if state !== 'confirmed_by_reporter'}<details class="disclosure" use:disclosure><summary>{t('Inne sposoby przekazania')}</summary><div class="disclosure-body">
            <div class="stack">
              <!-- While the question is open, the route's own action stays here for a second try. -->
              {#if (route !== 'mail' || asking) && currentRecipient}{@render mailAction(notice, '')}{/if}
              {#if route === 'pdf' && asking}<button disabled={!pdfText || fileSaving || pdfOffline} onclick={() => void exportPdf()}>{t(fileSaving ? 'Zapisywanie pliku…' : 'Pobierz PDF')}</button>{/if}
              {#if currentRecipient}<button onclick={() => void copy(currentRecipient!, 'Adres skopiowany.')}>{t('Kopiuj adres')}</button>{/if}
              <button onclick={() => void copy(noticeText.subject, 'Temat skopiowany.')}>{t('Kopiuj temat')}</button>
              {#if route !== 'copy' || asking}<button onclick={() => void copy(noticeText.body, 'Treść skopiowana.')}>{t('Kopiuj treść')}</button>{/if}
              {#if report.photos?.length && !isAndroidApp && canSharePhotos(report.photos)}<button onclick={() => void sharePhotos(notice, report!.photos!)}>{t('Udostępnij zdjęcia')}</button>{/if}
              {#each report.photos ?? [] as photo, index (photo.id)}
                <button disabled={fileSaving} onclick={() => void downloadPhoto(photo, index)}>{t('Pobierz zdjęcie')} {index + 1}</button>
              {/each}
            </div>
          </div></details>{/if}
        {/if}
        {#if (report.notices?.length ?? 0) > 1}<button class="quiet" onclick={() => show('notices')}>{t('Wszystkie powiadomienia')}</button>{/if}
        {/key}
      {:else if screen === 'check-in' && report && currentNotice}
        {@const notice = currentNotice}
        {@const confirmedAt = notice.events.find(event => event.kind === 'confirmed_by_reporter')?.at}
        {@const dueAt = signedNoticeCheckInAt(notice)}
        {@const showSaved = !!answeredCheckIn && !checkInChanging && (checkInSaved || !dueAt || dueAt.getTime() > clockNow)}
        <button class="back" onclick={goBack}>{@html svg('arrow-left')} {t('Wróć')}</button>
        <p class="check-in-context">{eventLabel(report.report.event_type)}{#if confirmedAt}{` · ${t('przekazane')} ${shortDay(warsawDate(new Date(confirmedAt)))}`}{/if}</p>
        <!-- One heading in both states, so the saved answer's fade-out never leaves two on the page. -->
        <h1 id="check-in-question" class:sr-only={showSaved} tabindex="-1">{repliedQuestion(notice.recipient)}</h1>
        {#if showSaved && answeredCheckIn}
          <div id="check-in-saved" class="receipt compact" role="status" tabindex="-1" transition:reveal><div><strong>{t('Zapisano:')} {t(outcomeLabels[answeredCheckIn.outcome]).toLocaleLowerCase(language === 'en' ? 'en-GB' : 'pl-PL')}</strong>
            <small>{answeredCheckIn.outcome === 'no_answer_yet' ? t('Przypomnienie zostaje. Zapytamy znowu.') : `${t('Data:')} ${day(answeredCheckIn.observed_on)}`}</small></div></div>
          {#if checkInDateOpen && answeredCheckIn.outcome !== 'no_answer_yet'}
            <label class="check-in-date" transition:reveal>{t('Kiedy przyszła odpowiedź?')}<input type="date" max={warsawDate(new Date())} value={answeredCheckIn.observed_on}
              onchange={event => { const value = event.currentTarget.value; if (value && value !== answeredCheckIn?.observed_on) void answerCheckIn(notice, answeredCheckIn!.outcome, value); }} /></label>
          {/if}
          <div class="quiet-links">
            {#if answeredCheckIn.outcome !== 'no_answer_yet' && !checkInDateOpen}<button class="quiet" onclick={async () => { checkInDateOpen = true; await tick(); document.querySelector<HTMLElement>('.check-in-date input')?.focus(); }}>{t('Zmień datę')}</button>{/if}
            <button class="quiet" onclick={async () => { checkInChanging = true; checkInDateOpen = false; await tick(); document.getElementById('check-in-question')?.focus(); }}>{t('Zmień odpowiedź')}</button>
          </div>
        {:else}
          <div class="answers" role="group" aria-label={t('Odpowiedź urzędu')}>
            {#each checkInAnswers as [code, label] (code)}
              <button class="answer" disabled={saving} onclick={() => void answerCheckIn(notice, code)}>{t(label)}</button>
            {/each}
          </div>
          <p class="muted"><small>{t('Wynik wpisujesz samodzielnie. Nie potwierdzamy odpowiedzi ani doręczenia.')}</small></p>
        {/if}
        <button class="quiet" onclick={() => void openNotice(notice)}>{t('Pokaż powiadomienie i korespondencję')}</button>
      {/if}
      <div class="scroll-extras">{@render scrollExtras()}</div>
      <!-- Blocked storage is also why preferences are not kept, and the blocked line already says so. -->
      {#if preferenceError && !storageBlocked}<p role="alert">{preferenceError}</p>{/if}
      {#if error && !(screen === 'library' && newerDatabase && error === t(oldVersionCopy))}<p role="alert">{error}</p>
        {#if error === t(oldVersionCopy) || error === t(pdfLoadCopy)}<button class="wide" disabled={restarting} onclick={() => void restartApp()}>{t(error === t(oldVersionCopy) ? 'Uruchom nową wersję' : 'Uruchom aplikację ponownie')}</button>{/if}
      {/if}
    </div>
    {#if screen === 'welcome'}<footer class="screen-foot welcome-foot">{#if firstLaunch}<button class="primary" onclick={() => finishWelcome(true)}>{t('Zezwól na lokalizację')}</button><button onclick={() => finishWelcome(false)}>{t('Dalej bez lokalizacji')}</button>{:else}<button class="primary" onclick={goBack}>{t('Wróć do aplikacji')}</button>{/if}</footer>
    {:else if screen === 'menu'}<footer class="screen-foot"><button class="primary" onclick={goBack}>{t('Wróć do aplikacji')}</button></footer>
    {:else if screen === 'home'}<footer class="screen-foot"><button class="primary" onclick={() => void capture(null)} disabled={saving}>{t('Zapisz miejsce i czas')}</button></footer>
    {:else if screen === 'camera'}<footer class="screen-foot"><button class="primary" onclick={() => void takePhoto()} disabled={takingPhoto}>{t('Zrób zdjęcie')}</button></footer>
    {:else if screen === 'choose-event' && draft}<footer class="screen-foot">{@render later()}</footer>
    {:else if screen === 'when' && draft}<footer class="screen-foot">{#if draft.occurredMode && draft.occurredMode !== 'now'}<button class="primary" onclick={() => nextStage('when')}>{t('Dalej')}</button>{/if}{@render later()}</footer>
    {:else if screen === 'where' && draft}<footer class="screen-foot">{#if whereView === 'compass'}<button class="primary" onclick={() => nextStage('where')}>{draft.hearingBearing === undefined && hearingDistance(draft) === undefined ? t('Pomiń kierunek i odległość') : t('Dalej')}</button>
      {:else}{@const missing = choosesPoint(draft) && !manualPoint(draft)}{#if missing}<p id="where-next" class="draft-next" aria-live="polite"><strong>{t('Dalej:')}</strong> {t('Wskaż miejsce, aby przejść dalej.')}</p>{/if}<button class="primary" aria-disabled={missing} aria-describedby={missing ? 'where-next' : undefined} onclick={() => nextStage('where')}>{t('Dalej')}</button>{/if}{@render later()}</footer>
    {:else if screen === 'details' && draft}<footer class="screen-foot completion-foot">{#if blockingIssues.length}<p id="draft-next" class="draft-next" aria-live="polite"><strong>{t('Dalej:')}</strong> {issueText(blockingIssues[0], draft)}</p>{/if}<p class="no-help">{t('Zgłoszenie nie sprowadza pomocy.')}</p><button class="primary" onclick={save} disabled={saving} aria-disabled={!!blockingIssues.length} aria-describedby={blockingIssues.length ? 'draft-next' : undefined}>{saving ? t('Zapisywanie…') : t('Zapisz zgłoszenie')}</button>{@render later()}</footer>
    {:else if screen === 'library'}<footer class="screen-foot"><button onclick={() => show('home')}>{t('Wróć do ekranu głównego')}</button></footer>{/if}
    {#if screen === 'recipients' && report}
      <footer class="screen-foot">
        <button class="primary" disabled={!recipientsDeferred && (catalogMissing || recipientBusy)}
          aria-disabled={!recipientsDeferred && !catalogMissing && !recipientBusy && !!recipientReason} aria-describedby={!recipientsDeferred && !catalogMissing && !recipientBusy && recipientReason ? 'recipients-reason' : undefined}
          onclick={() => recipientsDeferred ? show('report') : recipientReason ? blockedRecipients() : void openSignature()}>{t(recipientsDeferred ? 'Dokończę później' : 'Dalej: podpis')}</button>
        <div class="footer-extras">{@render recipientExtras(true)}</div>
      </footer>
    {/if}
    {#if screen === 'signature' && report}<footer class="screen-foot"><button class="primary" disabled={preparationPending > 0 || !noticeVariant || saving} aria-disabled={signatureBlocked} aria-describedby={signatureBlocked && !preparationPending ? 'signature-reason' : undefined} onclick={() => signatureBlocked ? blockedSignature() : void prepareNotices()}>{t('Przygotuj powiadomienia')}</button><div class="foot-quiet"><button class="quiet" onclick={() => show('report')}>{t('Dokończę później')}</button></div>{#if preparationPending}<small role="status">{t('Zapisywanie…')}</small>{:else if signatureBlocked}<small id="signature-reason" aria-live="polite" class:pressed={blockedPress}>{t('Podaj imię, nazwisko i adres do korespondencji.')}</small>{/if}</footer>{/if}
    {#if screen === 'notices' && report}
      {@const next = report.notices?.find(item => noticeState(item) !== 'confirmed_by_reporter')}
      <footer class="screen-foot">{#if next}<button class="primary" onclick={() => void openNotice(next)}>{fill(t('Otwórz następne: {kind}'), { kind: kindLabel(next.recipient.kind) })}</button>{:else}<button class="primary" onclick={() => show('report')}>{t('Gotowe')}</button>{/if}</footer>
    {/if}
    {#if screen === 'notice' && report && currentNotice}
      {@const notice = currentNotice}
      {@const state = noticeState(notice)}
      {@const route = noticeRoute(notice)}
      {#if state === 'confirmed_by_reporter'}
        <footer class="screen-foot">{#if nextNotice}{@const next = nextNotice}<button class="primary" onclick={() => void openNotice(next)}>{fill(t('Następne: {kind}'), { kind: kindLabel(next.recipient.kind) })}</button>{:else}<button class="primary" onclick={() => show('report')}>{t('Gotowe')}</button>{/if}</footer>
      {:else if !notice.askHandoff}
        <footer class="screen-foot">{#if route === 'mail'}{@render mailAction(notice, 'primary')}
          {:else if route === 'pdf'}<button class="primary" disabled={!pdfText || fileSaving || pdfOffline} aria-describedby={pdfOffline ? 'pdf-offline' : undefined} onclick={() => void exportPdf()}>{t(fileSaving ? 'Zapisywanie pliku…' : 'Pobierz PDF')}</button>
          {:else}<button class="primary" disabled={!noticeText} onclick={() => { if (noticeText) void copyHandoff(notice, noticeText.body); }}>{t('Kopiuj treść')}</button>{/if}
          {#if notice.variant === 'signed' && !signedReady(signedByNotice[notice.id])}<small>{t('Podaj imię, nazwisko i adres do korespondencji.')}</small>{/if}</footer>
      {/if}
    {/if}
    {#if screen === 'check-in' && report && currentNotice && answeredCheckIn && !checkInChanging}<footer class="screen-foot"><button class="primary" onclick={() => show('home')}>{t('Gotowe')}</button></footer>{/if}
    {#if confirmation}{#key confirmation.id}<div class="brief-confirmation" aria-hidden="true" style:bottom="{confirmationBottom}px" in:briefIn|global out:briefOut|global><p><span>{confirmation.text}</span></p></div>{/key}{/if}
  </main>
  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
</div></div>
