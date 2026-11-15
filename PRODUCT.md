# Product

## Implementation and release status

The web app, Capacitor Android wrapper and server are implemented. Phase 1 closed on
2026-09-26 with unfinished production and human work transferred. The current
[phase-2 spec](.scratch/faza-2/spec.md) and [tickets](.scratch/faza-2/issues/README.md)
cover the [accepted audit](.scratch/audits/architecture-review-zglos-mysliwego-20260926-1755.html):
reporting interactions, privacy/reliability fixes, performance and production recovery.
Ticket evidence distinguishes implemented work from acceptance still pending.

The public map and analytics described as "phase 2" in older records remain future
work outside this audit phase. Publication needs its own specification and DPIA.
[Human/legal gates](.scratch/pre-production-human-steps/README.md),
[authority coverage](.scratch/faza-2/issues/29-directory-release-gate.md),
[production checks](.scratch/faza-2/evidence/28-production/verification.md) and
[final acceptance](.scratch/faza-2/issues/31-release-acceptance.md) remain open.
The 24 September approval in [DESIGN.md](DESIGN.md) applies to its browser prototype;
it does not approve later implementation, native behavior or production release.
Local planning/design links may be absent from a fresh clone; see
[repository tracking](DEVELOPMENT.md).

## Platform

web

One design for Android (Capacitor wrapper) and the browser. Android habits are borrowed where they
help one-handed use, such as actions at the bottom of the screen and the system back gesture, but
the app does not follow Material 3 as a grammar. Web and Android builds exist. The web is
canonical; self-hosted APK, IzzyOnDroid and Play distribution remain subject to
[human step 04](.scratch/pre-production-human-steps/issues/04-android-distribution.md).

## Stack

TypeScript, SvelteKit, Capacitor. A server computes Findings after sync (ADR-0004). iOS is out of
scope.

## Users

The central case is somebody who hears shooting behind their house at dawn. They are at home or in
the yard, they know the place, and they may be frightened or angry.

Also designed for:

- **Walkers in the forest**: grzybiarze, dog walkers, runners. Outdoors, usually with no signal,
  possibly close to the person with the gun, with cold hands and one hand on the phone.
- **Monitors**: people who watch polowania zbiorowe on purpose and file many Reports. They know the
  law better than the app does and want speed rather than explanation.

A Reporter is never identified to the project. There are no accounts.

## Product Purpose

No reporting channel for hunting exists in Poland. Państwowa Straż Łowiecka is split per
voivodeship with no national digital intake, Krajowa Mapa Zagrożeń Bezpieczeństwa takes poaching
pins and nothing else, and no NGO runs a tool for this.

The app records where and when something happened, measures the place against the law once the
Report syncs, and composes a Notice the Reporter sends from their own mail client to the gmina, the
police and Państwowa Straż Łowiecka. Every Report is counted centrally whether or not a Notice goes
out, so that a future public map can show the scale of the problem.

Success in phase 1 is a Report captured in the first seconds after a shot, by somebody who then
walks away and finishes it later.

## Positioning

Interface-register claim (historical draft from ticket 09; public wording in README.md): "Zgłoś strzały
przy domach, ludzi z bronią, szczątki, ranne zwierzęta i kłusownictwo: aplikacja zapisze miejsce i
czas, zmierzy odległość do zabudowań i przygotuje wiadomość do policji, gminy i Straży Łowieckiej."

What nobody else can say: the distance to the nearest zabudowania mieszkalne, with its Accuracy,
computed against a dated Rule set, attached to a Notice the Reporter sends themselves.

## Operating Context

- Offline is the normal case in a forest. Capture never needs a network; Findings arrive after sync.
- Withdrawal removes local Report details at once. The app shows remote deletion as pending until the server confirms it.
- Low light at dawn and dusk, bright sun at midday, cold or gloved hands, one hand free.
- The phone stays silent: no flash, no sound, no vibration. The camera runs in-app. The capture
  screen is dark during noc (ADR-0010).
- The Notice leaves through the Reporter's own mail client. The app never learns whether it arrived.

## Capabilities and Constraints

- Five Event types: strzał, człowiek z bronią, szczątki w lesie, ranne zwierzę, kłusownictwo.
- A photo is required for szczątki w lesie, absent for strzał, optional elsewhere, at most three.
- Quick capture saves a Draft with the device fix, when available, and the time before questions.
  Later edits retain Event choice, location/area and private details. A Draft stays on the phone,
  never counts and never expires.
- Findings state measurements with their Accuracy and never a verdict (ADR-0003, ADR-0007).
- Nothing in the flow asks the Reporter to get closer, stay put, wait for a GPS fix, or photograph
  a person (ADR-0010).
- No identity field, no accounts, no device identifier (ADR-0001, ticket 06).
- 112 is not mentioned anywhere. A Report is not a call for help.
- Vocabulary follows `CONTEXT.md`. The interface ships in Polish and English; a Notice is always in
  Polish.
- Notice composition and local Signed Notice PDF export exist. Approved legal fragments are
  still a release gate; current test wording is not legal approval.
- Each Notice has Reporter-confirmed handoff and self-reported outcomes. Signed Notices have
  a six-week check-in placeholder. The legal route and follow-up templates still need
  [human review](.scratch/pre-production-human-steps/README.md); the app cannot verify receipt.

## Brand Commitments

- Public name "Bór czuwa" in both interface languages. The mark (four grain lines parting around
  a round knot, from `brand/`) identifies the web and
  Android app. Domain selection remains separate release work.
- Interface copy is plain and on the Reporter's side. The public voice may be openly hostile to
  hunting; Notices and Findings stay flat (ADR-0009).
- "Niezależny projekt. Merytorycznie wspiera go Komitet Inicjatywy Uwaga! Polowanie." on the site
  and the about page. No komitet logo in the app chrome.
- Plain design. Good UX, no flourish, nothing like gender-diary's motion work. Plain still means
  nothing teleports and nothing appears at full opacity in one frame.

## Evidence on Hand

Legal and geodata research lives under `.scratch/zglos-mysliwego/research/`, decisions in
`docs/adr/`, integration fixtures in `data/fixtures/` and Notice golden texts in `tests/golden/`.
Implementation evidence lives with the phase-2 tickets; it does not substitute for legal
approval or user research. Prototype data is synthetic and must be labelled as such.

## Product Principles

1. Leaving first costs nothing. Every screen can be abandoned without losing the place and the time.
2. Facts, never verdicts. The app measures; the authority decides.
3. The Reporter is never asked to be braver than they chose to be.
4. The offline state is the normal state and must never look broken.
5. Nothing is ever called sent. The app hands off and says so.

## Draft completion

Quick capture leaves Event type unset. Its receipt is the Event choice: one screen says the place
and time are kept and asks what happened, so the first question is two taps from home. Resuming
that Draft opens the same screen, then keeps its id,
capture time, fix and private details. Each step names the next missing fact beside its action.
Trying to move on marks and focuses the first missing control. A failed device write leaves the
Draft in place and names the storage error without claiming the Report was saved.

Completion is three short steps, Kiedy, Gdzie and Sprawdź (Co first after quick capture), each
asking one thing. A shot heard now, and a person with a gun, an injured animal or poaching seen
now, are placed by direction and distance from the Reporter; leaving both unset keeps the phone's
position for the seen Events. Anything earlier, or without GPS, is placed by a point and radius on
the map. Remains happening now use the phone's position, since the Reporter photographs them
where they stand. Sprawdź says the place in words, asks the home question only when no saved home decides
it, shows the kept place on a map with one privacy sentence, and saving there confirms it.
Optional details never become a step of their own. Resuming opens Kiedy if it was never answered,
otherwise the first step with a missing fact.

Camera refusal keeps its existing explanation with that Draft's continuation on Home and its
photo actions. Home focuses that continuation while the feedback is active; a new photo action or
unrelated navigation clears it, then Home uses the usual latest-work order.

## Saved Report and optional Notices

A newly saved Report reads "Zgłoszenie zapisane"; reopening it reads "Zgłoszenie". Its status
separates local save, server sync, Findings and optional Notice preparation. Queued upload,
deferred retry, server refusal and terminal Findings failures retain their own explanations and
recovery actions. If the server loses a Report it already accepted, the phone saves it again on its
own, keeps its Findings readable meanwhile and says why it is saving again. Only a phone that
still holds the Report can bring it back. Preparing a Notice never waits for server acceptance or Findings. A concise
measurement includes location uncertainty; disclosures retain local details, independent
Findings, rules and provenance. Existing Notices show each recipient's state and latest reported
outcome on the Report. Its primary action opens those Notices when they exist; adding another
remains available as a quiet action.

An area dwelling result shows its closest distance and the share within the Rule set's
threshold, not a farthest distance. Exact zero and full shares read as 0% and 100%:
boundary contact is distinct from a whole area within the threshold. A positive sliver
never rounds to 0%, and an incomplete share never rounds to 100%. Spatial Findings
require coverage of the whole Incident area; time Findings remain independent.
The protected-area Sources explanation distinguishes point Accuracy from an Incident
area: an area-wide ban requires the whole area inside the boundary without touching it.
Protected-area and hunting-district shares use the same endpoint-safe wording; a
rounded percentage never establishes whole-area coverage. Escape closes Sources
before changing an underlying confirmation. Dataset-download failures are announced
inside the open Sources sheet, not only behind it.
The district summary groups disjoint source-year shares by district number. Sources
retains each original number/year entry so the selected data vintages remain visible.
A mapped stand within an Incident area, including its boundary, is shown as 0 m
within that area. A positive area-to-stand distance remains measured from the edge.

Preparation asks "Do kogo napisać?", then "Jak chcesz się podpisać?". A needed gmina question
comes first, including "Nie wiem". Gmina remains optional as a recipient; its folded group shows
how many are selected. Single valid police and PSŁ candidates may be proposed; ambiguous
jurisdictions need an explicit choice. Search supports
overrides, which delayed lookups preserve. Verified directory addresses and missing-address
states stay visible; a sources disclosure retains directory provenance and jurisdiction context.
A cached catalog works offline; without one, the app offers retry or return
later while keeping the Report.

Recipient choices, the gmina answer and the signature variant are saved locally with the Report.
Back preserves entered signer details in memory; only details explicitly remembered on this
phone survive restart. Signer identity is excluded from stored preparation and the project
server. Signed Notices require name and correspondence address. Unsigned choice explains that
the recipient sees the sending mailbox. Every Notice stays Polish. Preparing opens the first
selected Notice directly, with all Notices reachable from it. Repeating preparation reuses a
Notice for the same authority and signature variant. It updates recipient and place context and
uses the current signer details, while preserving the Notice ID, handoff events and outcomes.
Its editable text continues to use the latest Findings.

## Notice handoff

Each Notice has one route, chosen by its recipient and signature. With a verified email the
Reporter opens their mail client; a Signed Notice keeps "Złóż PDF w serwisie urzędowym" one tap
away. A Signed Notice without one is exported as a PDF to file on ePUAP or e-Doręczenia
themselves; an Unsigned one is copied and pasted into the authority's own form, with its site
linked. Opening mail, saving the PDF or copying the text each ask "Udało się wysłać?" and record
nothing more; only "Potwierdzam przekazanie" marks the Notice handed off, and "Jeszcze nie" brings
the route back. The question survives an interruption. Copying, photos and the other route stay
under "Inne sposoby przekazania". Outcome, follow-up guidance and the bounced-address report
appear only after a confirmed handoff, and the footer then offers the next Notice by authority
type. The Notice body stays available for review under the route.

A due six-week check-in opens one question, "Czy {urząd} odpowiedział?", with four answers. One
tap saves the answer dated today; the date and the answer can be changed afterwards, each change
kept in the outcome history. "Jeszcze nie" answers this check-in and asks again six weeks later.
It is never a legal deadline, and opening it answers nothing.

Withdrawal opens an inline confirmation in the app's own theme and names its consequences there,
with the safe choice focused. Cancel, Escape and Back leave the Report intact. Confirming removes
local details and opens Moje zapisy with a visible result line that distinguishes pending server
deletion from confirmed deletion and updates in place when the server confirms. Pending deletion
also shows as a status in history, never as a home task. It does not recall Notices already
handed off.

## Accessibility & Inclusion

WCAG 2.2 AA as the floor, plus rules for the real scene: touch targets of at least 56 px for cold
or gloved thumbs, primary actions within one-handed thumb reach, legible in low light and in direct
sun, and no meaning carried by colour alone.

## Unfinished work

Only what the Reporter can do counts as unfinished: a Draft, a handoff to confirm, a due
check-in, a refused Report. Home shows the newest of these as one row above the Event choices, and
the row opens that exact screen. A queued upload or a pending server deletion is the app's work: it
never takes the row or the count, and home says nothing about it unless an upload waits for signal.
Moje zapisy lists every task under "Do zrobienia" and keeps every record below it, grouped by month
and led by its day, each Report row naming
its Event, time, a place the Reporter has already seen and how far its Notices got; its masthead
entry shows how many tasks there are. A Report without an optional Notice does not need action for that reason.
Opening the library clears nothing. Recording an outcome answers a due check-in; "no reply yet"
asks again six weeks after the answer. None of this creates a legal deadline.
