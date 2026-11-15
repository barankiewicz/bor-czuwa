---
name: "Bór czuwa"
description: "Burnt orange on cool paper: an orange header band, filled controls, and every capture control marked in the action colour"
colors:
  ground: "#e9eae7"
  paper: "#f6f7f5"
  ink: "#1c1b18"
  muted: "#52544f"
  rule: "#c9ccc6"
  control-border: "#73766f"
  soft: "#ecedea"
  fill: "#e4e6e1"
  fill-hover: "#d8dbd4"
  action: "#9e4310"
  on-action: "#ffffff"
  alert: "#9e4310"
  band: "#9e4310"
  band-hover: "#873809"
  on-band: "#f6f7f5"
  focus: "#0b6874"
typography:
  measurement:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "3rem"
    fontWeight: 600
    lineHeight: 1.1
  headline:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.005em"
  section:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "1.35rem"
    fontWeight: 600
    lineHeight: 1.3
  record-title:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.45
  month-heading:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "1.1rem"
    fontWeight: 600
    lineHeight: 1.45
  day-number:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1
  status-title:
    fontFamily: "Atkinson Hyperlegible Next, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 600
    lineHeight: 1.25
  event-label:
    fontFamily: "Atkinson Hyperlegible Next, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 700
    lineHeight: 1.45
  row-title:
    fontFamily: "Atkinson Hyperlegible Next, sans-serif"
    fontSize: "1.03rem"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "Atkinson Hyperlegible Next, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Atkinson Hyperlegible Next, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.45
  aside:
    fontFamily: "Atkinson Hyperlegible Next, sans-serif"
    fontSize: "0.94rem"
    fontWeight: 400
    lineHeight: 1.45
  caption:
    fontFamily: "Atkinson Hyperlegible Next, sans-serif"
    fontSize: "0.88rem"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  control: "2px"
  surface: "0"
spacing:
  stack-gap: "10px"
  event-gap: "8px"
  control-block: "12px"
  control-inline: "16px"
  mobile-inline: "20px"
  content: "24px"
  workspace-gap: "40px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    typography: "{typography.label}"
  button-secondary:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
    typography: "{typography.label}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.action}"
    rounded: "{rounded.surface}"
    padding: "8px 0"
    typography: "{typography.label}"
  input:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px"
    typography: "{typography.body}"
  event-choice:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px 10px 10px"
    typography: "{typography.event-label}"
  event-mark:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.control}"
  choice-selected:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "14px"
  header:
    backgroundColor: "{colors.band}"
    textColor: "{colors.on-band}"
    rounded: "{rounded.surface}"
    padding: "8px 24px"
  message:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "14px 0"
---

# Design System: Bór czuwa

Faza-4 ticket 29 gave the app this language in two rounds. Round one built version 2 of the
[design-language map](.scratch/design-language/map.md), which Alicja picked on 2026-10-07 ("version
2", with her refinements), and the filler cuts she signed off on 2026-10-19 ("yes, good. go ahead.
signed off"). Shown that build on 2026-10-20, she wrote: "1. more color 2. the main screen needs to
look much better - the other categories of what happened. currently the whole app looks like a 90's
HTML page". Of three colour strategies prototyped over the real build she chose the second, the burnt
orange owning whole regions: "take 2 and make it better". Of the third, a yellow notebook cover in
yellow and black, she said "is just inpost app". Round two undoes two of her 2026-10-07 refinements, the current step and the chosen answer in ink,
because orange owning them is what option 2 was. This record describes round two as built; the
branch waits for her sign-off on rendered before/after crops before it reaches main.

Earlier approvals are history. The 2026-09-24 approval ("looks great, ready to merge") covered the
browser prototype in `prototypes/01-reporting-journey/`, whose look this language replaces; the later
sections below keep that prototype's interaction decisions, which still hold. Every UI change must
satisfy the [UI acceptance contract](.scratch/faza-2/spec.md#ui-acceptance-contract), including
visual review and physical Android proof for native behaviour. The
[final acceptance ticket](.scratch/faza-2/issues/31-release-acceptance.md) and
[human release gates](.scratch/pre-production-human-steps/README.md) remain separate. The future
public map is outside this phase and has no design approval here.

## Overview

**Creative North Star: "A witness record with one colour that means act"**

A Report is a witness record that goes to an authority. The page keeps a form's discipline: square
edges, rows on hairlines, headings in a text serif, dates in a column, status in words. One colour
carries the brand and the action: a burnt orange that bands the top of every screen, fills the
capture button, marks every Event and everything the Reporter has chosen. Controls are filled blocks,
never black outlines, and nothing that is a button looks like an underlined link.

It must never read as state-backed: no Polish red and white, no gov.pl or mObywatel blue, no
crest-like shape, no Lasy Państwowe green. It must not read as another Polish brand either: no
yellow and black, which is InPost's. The name stays in the header, and welcome and Menu say that
Bór czuwa is an independent project, not run by the state or by any authority.

The capture screen is the orange band, the question "Co się stało?", five filled Event rows each led
by its glyph on an orange square, and the orange capture button at the foot. A record opens with a
ruled reference strip: the Event's orange square, its name in the serif, its time and its number.

The target is Android and desktop browsers, in portrait and landscape. iOS is outside scope.

## Colors

These are the CSS properties in `src/routes/page.css`. Light is the root default; dark and noc
override it through `data-theme`. The camera borrows the dark set in light, and keeps noc's own in
noc.

| Property | Light | Dark | Noc | Job |
| --- | --- | --- | --- | --- |
| `--ground` | `#e9eae7` | `#121210` | `#0b0b0a` | outside the document |
| `--paper` | `#f6f7f5` | `#1b1a17` | `#121110` | the document, and the face of a chosen answer |
| `--ink` | `#1c1b18` | `#efece4` | `#c6c2b8` | text and structure |
| `--muted` | `#52544f` | `#b5b1a6` | `#9c988e` | secondary text |
| `--rule` | `#c9ccc6` | `#44413a` | `#35332e` | hairlines between rows |
| `--fill` | `#e4e6e1` | `#2b2a25` | `#1f1e1b` | filled buttons, rows, fields and tags |
| `--fill-hover` | `#d8dbd4` | `#35342e` | `#282722` | a filled control under the pointer |
| `--soft` | `#ecedea` | `#25241f` | `#1c1b18` | the fill of an unavailable button |
| `--control-border` | `#73766f` | `#8e8a80` | `#6e6a62` | range track, target rings and rim, "not set yet" dashes |
| `--action` | `#9e4310` | `#e88a4e` | `#bda276` | the main action, Event marks, chosen and current |
| `--on-action` | `#ffffff` | `#1b0d03` | `#14120c` | text and glyphs on the action colour |
| `--alert` | `#9e4310` | `#f0a274` | `#bda276` | alert rules and headings, field errors |
| `--band` | `#9e4310` | `#7a3412` | `#3a2c18` | the header band, and the legal pages' bar |
| `--band-hover` | `#873809` | `#8a3d17` | `#45351d` | a header control under the pointer |
| `--on-band` | `#f6f7f5` | `#f5ece4` | `#c6c2b8` | the mark, name, controls and focus ring on the band |
| `--focus` | `#0b6874` | `#63cfdb` | `#3e9ba6` | the keyboard focus ring, everywhere but the band |
| `--map-wood` | `#b9d0ac` | `#30422a` | `#212b1c` | forest under the direction target, the map's main shape |
| `--map-water` | `#afcede` | `#234556` | `#18303b` | lakes, ponds, rivers (1.8 px) and streams (1 px) |

The burnt orange does four jobs, all of them "this is yours to act on": the header band, the main
action, the square behind every Event glyph (an Event row captures just as the capture button
does), and whatever the Reporter has chosen or is on: a chosen answer's edge, the current step,
radios and checkboxes, the slider, the hour band, the direction mark, and the month rules and day
numbers in the history. Text actions ("Zmień", "Usuń", "Dokończę później") are bold orange words.
Ink carries text and structure. Teal is only the focus ring, and on the band the ring turns paper,
since teal disappears on orange. At night the band is a deep burnt brown in dark and a dim brown in
noc, so the top of the screen never glares. Noc is the dark structure dimmed for night use, with its
ink lowered to relative luminance 0.54 and the orange shifted to an ochre. No meaning rests on colour alone: a chosen answer also
changes its face and weight, an alert also has a heading. The direction mark is solid orange: a
ray from Ty, a point where the distance is known. The raster OpenStreetMap
tiles of the place picker and the Sprawdź map stay light in every theme, so overlays there use fixed
inks: the burnt orange for an area edge and its 14 to 18% fill, ink and paper for the Ty and Dom
marks. The map under the direction target is drawn by the app in the `--map-*` colours above, so the
target keeps its theme inks over it. It never uses the orange. Names over it use `--muted` on a
paper halo, 4.6:1 or more over both map fills in all three themes; roads, tracks, contours and rings
are `--ink` at reduced opacity.

Ticket 29 recomputed every pair from the tokens with
[`contrast.py`](.scratch/faza-4/evidence/29-design-language/contrast.py). All pass.

| Pair | Light | Dark | Noc | Needs |
| --- | --- | --- | --- | --- |
| ink on paper | 16.03 | 14.74 | 10.61 | 4.5 |
| muted on paper | 7.13 | 8.12 | 6.55 | 4.5 |
| ink on ground | 14.26 | 15.89 | 11.07 | 4.5 |
| ink on a fill | 13.70 | 12.18 | 9.37 | 4.5 |
| ink on a fill under the pointer | 12.30 | 10.58 | 8.41 | 4.5 |
| muted on a fill | 6.10 | 6.71 | 5.79 | 4.5 |
| muted on soft (unavailable button) | 6.52 | 7.26 | 5.98 | 4.5 |
| on-action on action (button, Event mark) | 6.43 | 7.40 | 7.66 | 4.5 |
| orange text on paper (text actions, current step) | 5.99 | 6.78 | 7.72 | 4.5 |
| orange text on a fill | 5.12 | 5.60 | 6.82 | 4.5 |
| on-band on the band (header, mark, focus ring) | 5.99 | 7.73 | 7.60 | 4.5 |
| on-band on the band under the pointer | 7.52 | 6.52 | 6.63 | 4.5 |
| alert on paper | 5.99 | 8.39 | 7.72 | 4.5 |
| paper on ink (destructive) | 16.03 | 14.74 | 10.61 | 4.5 |
| control border on paper | 4.29 | 5.05 | 3.50 | 3 |
| focus on paper / on ground | 6.02 / 5.36 | 9.51 / 10.25 | 5.79 / 6.04 | 3 |

## Typography

Headings, record titles, month headings and the history's day numbers are set in Source Serif 4, a
text serif used at 600 and never at display weights. It is self-hosted (OFL, latin and latin-ext
subsets, 93 KB together) and preloaded from `app.html`, because Polish headings need both subsets
and the first heading should not paint in Georgia and then swap. Everything else is the local
variable Atkinson Hyperlegible Next.

h1 is 2rem at every width, line height 1.15, tracking -0.005em; h2 is 1.35rem; the record title
1.25rem, the history's day numbers 1.5rem and its month headings 1.1rem, all in the serif. Body text
is 17px (1rem, since the root is 106.25%) at line height 1.45 (1.5 in dark and noc, where light text
on a dark ground reads denser), and paragraphs stop at 68ch. Labels and buttons are 600, body 400,
and 700 is kept for Event names, text actions, a chosen answer, the current step and the brand
name. Event names are 1.15rem, row and task titles 1.03rem, the receipt's status 1.3rem and the
no-help line on Sprawdź 0.94rem. Supporting text is 0.88rem and nothing is smaller. The app shell
uses tabular numerals throughout, so times and counts line up.

The Report-ready refinement requested on 9 November 2026 keeps the ruled-record
language but gives numerical Findings a distinct hierarchy. The dwelling distance
or area share uses the 3rem measurement size; a measured ambona distance uses
2rem. Contextual values use 1.25rem, with quieter labels and supporting text.
Each complete fact group has one muted separator and space on both sides.
Record identity keeps one muted rule rather than a pair of competing ink rules.
All legal rules, source wording, measurement meanings and fact order remain
unchanged. This candidate still requires the owner's rendered visual approval.

## Layout

The viewport uses `100dvh`. The app shell holds the orange header band, an independently scrolling
screen body, and a footer that does not shrink. Body content scrolls without moving the capture
action out of the first viewport, and the footer accounts for the bottom safe area.

The desktop workspace is at most 1080px wide with a document column up to 640px. At widths up to
760px the app fills the width, loses its outer border and margins, and uses 20px horizontal content
padding; wider layouts use 24px. In landscape at heights up to 500px, vertical margins disappear,
Event rows use two columns with an 8px gutter, and the footer places its action and supporting text side by side with
8px vertical padding. The action keeps its 56px height.

## Elevation & Depth

The interface is flat: colour fields, fills, rules and paper, with no shadows anywhere. Depth comes
from the band, the filled blocks and a chosen answer's paper face. The brief save confirmation
floats over the content as paper with a 1px ink border, a slip laid on the page. Collapsing rows and
messages draw their hairlines as inset shadows for a mechanical reason, not for depth: Chrome paints
a sub-pixel border at 1px, so a bordered row collapsing to nothing would stop at 2px and then vanish
in one frame.

## Shapes

Controls and filled blocks have 2px corners: buttons, Event rows and their squares, the home task,
menu links, choices, fields, badges and the task count. Everything else is square: the app shell,
the band, rows on hairlines, messages, maps, the hour wheel, photo tiles and the confirmation slip.
A field is a filled box with a 2px ink edge along the bottom. Geometry that is round by nature stays
round: the direction target and its rings, the map's radius circle, the Ty and Dom marks and the range
thumbs. Dashes mean only "not set yet" on something that takes a value: the radius slider's thumb and
the target's rim before anything is marked, and the circle of a distance given without a direction.
A control that cannot be used is never dashed.

## Components

- The main action is a flat burnt-orange fill with on-action text, one per screen. Every other
  button is a filled block in `--fill` with ink text; hover deepens the fill (the action darkens
  instead). An unavailable button is the paler soft fill with muted text; an aria-disabled one keeps
  that look under the pointer. Text actions are bold orange words that underline only on hover.
  Buttons, fields and disclosure summaries are at least 56px.
- The header is the orange band: the mark in the band's paper colour beside the name, then "Moje
  zapisy" with its task count as a paper tag, and Menu. The legal pages' way back sits on the same
  band.
- Fields are filled boxes with an ink edge along the bottom and the label above, 56px tall.
- Event choices are filled 76px rows: the Lucide glyph at 28px on a 52px orange square, then the
  Event's name at 1.15rem in bold, with no explanation or arrow. The home task, the tasks in Moje
  zapisy and the record strip use the same orange square at 36px and 44px.
- Answers, segments, choice boxes and the language switch are filled blocks. Chosen, one leaves the
  set: a paper face, a 2px orange edge drawn inside so nothing moves, and a bold label. Radio and
  checkbox rows on hairlines show the chosen row in bold beside the orange native control.
- Steps are words: the current one orange, bold, with a 2px underline; the others muted. There are
  no pills or check marks.
- Lists in the history, the record's status and the Notices are rows on hairlines; rows that open
  something end in the Lucide chevron in ink. Usuń on a Draft is a bold orange word inside its row,
  and its confirmation opens under an ink rule. The menu's links are filled blocks.
- Messages (notes, receipts, the Notice route panel, "Udało się wysłać?", confirmations and result
  lines) are ruled above and below in ink, with no box and no fill. An alert opens with a 3px rule in
  the alert colour and states its problem as a heading in that colour.
- Status is words. Badges are filled tags, used only once something has happened.
- The record's reference strip sits between two ink rules: the Event's orange square, its name in
  the serif and its time on the left, "Nr zapisu" and the first eight hex digits of the Report's id
  on the right.
- History is grouped by month under a serif heading on a 2px orange rule; each row leads with its
  day number in orange and weekday in a ruled column, which is hidden from screen readers because
  the row's name already says the day.
- Focus is a 3px outline 2px off the control: teal on the page, paper on the band. Screen changes
  focus the heading or the relevant field. Status announcements use a polite live region; validation
  and storage failures use alerts.
- Browser surfaces take the palette: selection is ink with paper text, the caret is ink, and the
  scrollbar uses the control border.
- Forced colours strip fills and shadows, so filled blocks draw a 1px edge there, a chosen answer an
  inner 2px ring, and the header mark takes the text colour instead of the band's paper.

Icons are locally bundled SVG paths from upstream [Lucide](https://github.com/lucide-icons/lucide);
`src/lib/icons-LICENSE.txt` carries the ISC licence and the notices for icons derived from
Feather. They are used only where they carry meaning: the five Event glyphs and the task glyphs on
their orange squares, row chevrons, back arrows, the folder that stands in for "Moje zapisy" at
narrow widths, and the external-link mark. No icon sits beside a label that already says the same
thing. The default stroke is 1.8px.

Screen changes use the View Transition API where available: 180ms with `ease-out`, 0ms for reduced
motion. A new change skips any previous transition; browsers without the API replace the screen
directly. The app makes no sound or vibration. The language adds no motion: everything that appears
or leaves still uses the shared 200ms height-and-opacity reveal.

Browser and Android Back follow the same screen history, one entry per completion step. Android
Back closes an open delete confirmation first; a record opened from Moje zapisy returns there, while
a record reached from capture returns through its journey. Forward restores the saved screen and
scroll position. Reload opens the same local record when it still exists; a missing record opens
Moje zapisy with an explanation. URLs contain only the screen and opaque local record IDs, never
coordinates or signer details. Only Back from the root exits the Android app.

### Report and Notice preparation

Redesign ticket 03 keeps the saved Report in the same document surface. Under the reference strip,
four compact rows give a written state for the phone, server, Findings and optional Notice. Light dividers
separate the rows; measurements keep their location uncertainty beside them. A Report the server lost
keeps its Findings row and says that the phone will save it again (Faza 5 ticket 02). Local details and
the full Findings record sit in disclosures. Existing Notices use the correspondence rows, with
each recipient's state and latest reported outcome visible. The fixed footer opens preparation
when no Notice exists, or the existing Notices when they do. Return home and Add Notice stay quiet.

Preparation reuses the completion stage head for Odbiorcy and Podpis. The gmina question comes
before authority choices as flat, divided radio rows with 56 px minimum targets. A caption below
explains the answer's effect; jurisdiction context remains available in the sources disclosure.
The optional gmina recipient group starts folded, with its selected count in the summary.
An unambiguous police or PSŁ row carries its own visible name and type; its fieldset legend
remains accessible without repeating that heading on screen. Ambiguous groups retain visible
legends and instructions. Directory provenance sits in a secondary disclosure.
Signed and Unsigned choices use the existing
selected-choice treatment, with their consequences inside the label. Signer fields open with the
height-and-opacity reveal, without a second entrance animation.

Withdrawal is the last, full-width quiet action on the Report, under a hairline. Its explanation
appears only in an inline confirmation, ruled in ink, that unfolds below the action, as "Usunąć
szkic?" does, with Anuluj and an ink "Wycofaj". Opening it focuses Anuluj without a focus scroll: on each
frame of the reveal the screen rises by what the panel grew, so the panel's edge stays above the
footer and the buttons are never hidden, even when the panel is taller than the screen (the
question then scrolls off the top). Under reduced motion it scrolls once. Cancel, Escape, Back
or a second tap on the action fold it and return focus to the action. Confirming opens Moje
zapisy with a result line under the heading, ruled above and below. It takes focus,
is not announced separately, and stays until the Reporter leaves. When the server confirms the
deletion, the line keeps its place and its text crossfades from the pending wording to the
confirmed one (faza 3 ticket 09). Physical Android Back, interruption and TalkBack checks for
this journey are still open.

### Notice handoff and check-in

Redesign ticket 04 follows the approved journey prototype, then a distilling pass the owner asked
for. A Notice screen reads top down: a small muted line with "Powiadomienie {n} z {m}" (only with
several) and the signature state, the recipient as the heading, a state badge only once something
has happened, then one ruled route panel with the route in words and the address. The
panel says nothing the heading or the button already says. The route's action is the footer
primary. After a handoff the panel gives way to "Udało się wysłać?" in the same ruled panel, with
the confirmation as an orange button inside it and no footer, so there is one thing to do.
Secondary material sits in disclosure rows without captions: the PDF preview and ePUAP guidance on
the PDF route, the outcome form (which also carries the follow-up sentence) and the bounced-address
report once confirmed, the Notice text, and "Inne sposoby przekazania" until confirmed. A confirmed
Notice's footer offers "Następne: {rodzaj}" or Gotowe. The Notices list is the heading,
"Przekazano {n} z {m}" and one row per authority, with its state once something has happened, and
opens the next Notice from the footer. The ePUAP guide mentions photos only when the Report has them.

The check-in is one question as the heading, with the Event and handoff day above it in the
muted line, and four 64 px full-width answers of equal weight. One tap saves; the answer is
replaced by the compact saved panel, which takes focus, with "Zmień datę" and "Zmień odpowiedź"
as orange text actions and Gotowe in the footer. No signer, PDF or mail controls appear there.

A save that changes something confirms itself briefly: a paper slip with a 1px ink border floats
12 px above the footer for 4 s, rising 10 px and fading in over 240 ms and out over 220 ms; with reduced motion it
appears and goes without animating. It never takes focus and nothing under it moves; the live
region reads it once.

## Do's and Don'ts

- Do keep capture available before details, with the saved time visible when work resumes, and the
  56px action target in short landscape viewports.
- Do keep measurements beside their uncertainty and source context, and describe missing Findings
  plainly; the Reporter can still prepare a Notice.
- Do keep exact home location out of the shared area. The preview may mark the local fix only with
  a legend saying it stays on the phone.
- Do say each thing once. A line that repeats a heading, a button or the line beside it goes.
- Do keep orange for what the Reporter acts on or has chosen: the band, the main action, Event
  squares, chosen answers and the current step. Text and structure stay ink.
- Don't underline a control so it reads as a link, or draw a secondary control as a black outline;
  controls are filled blocks and text actions are bold orange words.
- Don't add shadows, cards, pills, rounded containers or a coloured leading stripe, and don't put
  an icon beside a label that already says it.
- Don't pair yellow with black. That is InPost's look, and Bór czuwa should not read as another
  Polish brand any more than as a state one.
- Don't use anything that reads as state-run: Polish red and white, gov.pl or mObywatel blue, an
  eagle or crest-like shape, the gov.pl typeface or layout, or a dark forestry green.
- Don't carry meaning by colour alone, add decorative maps or legal verdicts, or imply that opening
  mail proves sending or delivery.
- Don't add motion or flourish (hard rule 8). Nothing appears at full opacity in one frame.

## Report progress and recovery

Report status distinguishes a local Draft, a saved Report waiting for connection, a deferred
retry, server refusal, and a server accepted Report awaiting Findings. Retry cause and deadline
survive reload and foreground events. Findings show computed results or a terminal unavailable
state with a recovery action. Reporter can prepare a Notice while Findings are missing.
Notice summaries show each recipient's own preparation and handoff state; opening mail does not
confirm delivery.

## Latest unfinished work

Ticket 32 moved the continuation above "Co się stało?". Faza 3 ticket 07 narrowed it to the
Reporter's own work. One shared classification splits pending work into tasks (finish a Draft,
confirm a handoff, answer a due check-in, look at a refused Report) and the app's work (a queued
upload, server deletion after a Withdrawal); home, the masthead count and Moje zapisy all read it.
The home slot holds the newest task as one compact filled block above the question: its glyph on
a 36px orange square, title and one line of "when · Dalej: next step". The next step is the question of the
screen the Draft opens on ("Co się stało?", "Kiedy to się stało?"), or at Sprawdź its first
readiness step. Authorities appear by short name ("Czy Policja odpowiedziała?") unless two tasks of
the same kind would then read alike, when the full name returns. With only the app's work left, the
slot stays empty unless an upload waits for signal, when one line says it will go once there is
internet; ticket 29 cut "Nic nie czeka na Ciebie." and moved "Zgłoszenie nie sprowadza pomocy." to
the Sprawdź footer. All five Event rows end above the footer at 390 × 844 with any task row. Moje
zapisy shows a count tag in the band's paper colour instead of a dot, read as "N do zrobienia"; the "i jeszcze N" link is gone.
A newer task crossfades into the same row, and the row follows the new height over 200ms. In a
container under 15rem a task row drops its glyph so its title wraps at word boundaries.
Opening the library does not dismiss tasks. Reporter activity sets task order, a check-in by the
day it fell due; background sync does not. An outcome answers the six-week check-in; "no answer
yet" schedules the next one six weeks after it, without changing the follow-up guidance.

Moje zapisy lists tasks as rows on hairlines. A Draft row is one resume
target with a narrow "Usuń" in bold orange at its right edge; that opens "Usunąć szkic?" inside the row
instead of a browser dialog, with focus on Anuluj. Cancel and Escape return focus to Usuń, and a
deletion moves it to the neighbouring task or the heading. Every task is a row under "Do
zrobienia" at the top, with the home row's wording; Report rows carry no Notice sub-rows. With no
task but some history, nothing stands there. Task rows and the confirmation grow and shrink with a 200ms height and opacity transition, so nothing below
them jumps; on home and in Moje zapisy, data updates skip the page crossfade that would show a
frozen copy over the moving rows. Row hairlines are inset shadows rather than borders, because a
sub-pixel border still paints 1px and a collapsing row would stop at 2px.

Faza 3 ticket 08 turned the rest into "Historia", which ticket 29 groups by month: a plain list under
serif month headings on a 2px orange rule ("Październik 2026"), divided by inset hairlines, newest first,
with pending Withdrawals in the same months. Each row leads with its day number in orange and short weekday in
a ruled column, hidden from screen readers. A Report row is that column, the Event, then "06:12 ·
gm. Borki Leśne" and one state line. The place word is the gmina the recipient suggestion already showed for that Report,
never for a Report made from home and never coordinates; with none known the row shows only the
time. The state line counts handed-off Notices and names the waiting authorities in ink ("Przekazano
1 z 2 · Czeka: Straż Łowiecka"), adds recorded outcomes, and is muted when nothing waits; a Report with no Notice and nothing
pending shows its time and place only. Sync appears only while it applies: a refusal in the alert
colour, "Czeka na internet, potem zapisze się samo", or
the server deferring; an accepted Report says nothing about the server. A row's accessible name is
"Strzał, dziś 06:12 · gm. Borki Leśne" and its description is the state line. A state line that
goes away collapses with the same 200ms reveal. The footer is a plain "Wróć do ekranu głównego"
button, since it is navigation.

Ticket 07 browser review covered light, dark and noc at 390px, 320px with 200% text, desktop and
landscape with English copy. The final review resolved dot wrapping beside the enlarged label.
Existing large-text masthead height remains outside this change. Physical Android verification
confirmed that answering a check-in cancels its reminder while retaining a future reminder.

## Draft completion

Redesign ticket 02 implements the stages approved with the
[journey prototype](prototypes/02-report-journey/proposal.md) on 2026-10-01. Completion is
three short screens named for the Reporter: Kiedy, Gdzie and Sprawdź, with Co first after quick
capture. Each screen has a stage head (a back arrow and the steps as words: the current one orange, bold
and underlined, the others muted) and one question. Its answer, or
Dalej, sits in the fixed footer above a quiet, centred "Dokończę później". A non-shot Event
happening now has no Gdzie step; its steps read Kiedy and Sprawdź. Each step is its own history
entry, so browser and Android Back walk the steps.

After quick capture there is no separate receipt screen (faza 3 ticket 06). Co is the receipt: a
panel ruled above and below, "Miejsce i czas zapisane" and "dziś 13:00 · Dokładność 9 m"
(without a fix, "Czas zapisany" and "dziś 13:00 · miejsce wskażesz później"), then "Co się
stało?" and the five Event rows, with "Dokończę później" alone in the footer. That Co has no
stage head; Kiedy shows Co as done. "Możesz już odejść" appears only until the Draft is
reopened. The panel is a status and takes focus on arrival. A fix that lands while it is on
screen crossfades the panel's two lines in one grid cell (140 ms out, 180 ms in), so the panel
and the rows stay where they are. Co opened by "Zmień" on Sprawdź keeps the plain step with its
stage head. "Dokończę później" confirms itself with the brief confirmation on home.

Kiedy offers three 56 px answer rows. Teraz, with the saved time at the row's end, answers and moves on.
Innego dnia reveals a date field and Kilka godzin temu an hour wheel: three 56 px rows of 1 to 24
hours that snap between two orange rules, turned by a swipe, arrow, Page or Home/End keys, or a
tap on a neighbouring hour, and brought into view once its reveal has grown. Dalej checks the date and
focuses it when it is wrong. The shot and armed-person safety
note sits above the answers and folds away once an earlier time is chosen, so every Kiedy state
fits a 390 × 844 screen without scrolling. Focused headings draw no ring after a tap, a click, a cold
start or Android's Back; after a key press they keep the keyboard ring (faza 3 ticket 04).

Gdzie for a shot heard now, and for a person with a gun, an injured animal or poaching seen now
(faza 3 ticket 13), is the direction target (faza 7 ticket 36). Each Event asks in its own words:
"Skąd słychać strzał?" for a shot, "Gdzie widzisz…?" for the others, and Kłusownictwo adds that a
Reporter standing at it can skip. The target never turns: north is up, PN, WSCH, PD and ZACH sit
just inside the rim in small spaced capitals with a paper halo, ticks mark only the diagonals, and
Ty is the centre. Linear rings every kilometre (and at 500 m) are thin ink lines at half strength
that fade as they shrink towards Ty; each is labelled on itself south-east of Ty, every other
kilometre at 5 km, and a label fades where its ring is too small or too close to the rim. The
scaffold stays behind the map and the answer on purpose (owner, 2026-11-15). The face
sits in the middle of the screen between two 56 px columns, the current scale on the left and its
zoom on the right, with 16 px above it and below it. A drag or a tap out from Ty places a point, which is the bearing (5-degree steps)
and the distance (eleven stops from 100 m to 5 km) together; snapped steps travel to their place
over 90 ms. While nothing is marked, a filled orange point shows the gesture: it fades in at Ty,
travels to the 500 m ring and fades, up to three times 4.5 s apart, and stops at the first touch,
key or answer (not under reduced motion). The scale is map-style zoom, + over − in the right-hand
column, with "Skala" and the current 1, 3 or 5 km in the left-hand one, so it never reads as a
distance; the end of the scale keeps its button but drops the fill. It opens at 1 km, or at the
smallest scale that shows a Draft's point. Dragging past the rim, or −, widens the scale one step
over 240 ms, rings, point and tiles together; + narrows it. After a touch ends, the answer buttons
scroll into view if the screen hides them; the "Telefon wskazuje" line gives way once there is an
answer, so at 390 × 844 "Nie wiem, jak daleko" stays above the footer. The keyboard turns by 5 degrees with the arrows, moves one
distance stop with Page Up and Page Down and sets north with Home, and the value text says the
answer in words. Where the phone gives a heading, a sonar shows where it points: ink arcs leave Ty every 850 ms
and take 3.2 s to pass the rim, fading in over their first 12% and out across the rim and thinning
as they grow. They point along the back camera's direction when held upright, the top edge when
flat, at the mean of the last 250 ms, 30 degrees wide, or 80 when Android reports poor accuracy (a
browser reports no accuracy, so there it stays 30). Once there is an answer the waves run along it
instead; where one crosses the marked point it flashes orange once and an orange echo grows from
the point. When the waves change from the phone to the answer, the old ones fade where they are and
new ones start, so no wave jumps. Under reduced motion three still arcs stand in for the waves. The
sensor moves nothing else. Ustaw ten kierunek copies its bearing from the first reading, with no wait
for a steady one, and keeps a distance already marked. Without a heading, on desktop or where the
browser gives none, there are no waves and nothing is said about the sensor; only a blocked or
not-yet-granted sensor says so, with Włącz kompas where a gesture can grant it. Every answer is
drawn: a point is a solid orange ray and dot; a direction without a distance is a dashed ray to the
rim, as anything not set is dashed; a distance without a direction is a dashed orange ring; "Nie
wiem, skąd" washes the whole face orange with a solid orange rim; nothing chosen yet is the grey
dashed rim. "Nie wiem, jak daleko" and "Nie wiem, skąd" stay on screen and show as pressed while
they are the answer. The sensor stops in the background and starts again on return. The map under the target ("Sylweta", picked by the owner from five rendered styles on 2026-11-15)
is drawn from OpenFreeMap vector tiles (OpenMapTiles schema) at its scale: forest and water as calm
shapes, rivers and streams in the water colour, main roads as a faint ink line, forest tracks
dotted because people aim along them, and at most four village or town names in small spaced
capitals where they fit without touching Ty, the letters or the ring labels. Wetland, settlements,
minor roads, ditches, buildings, paths, railways and street names are left out. 1 km draws zoom 14
and 3 and 5 km zoom 12, the coarsest zoom whose 3 by 3 tiles still cover the face. Contour lines
are traced on the phone, in a worker, from Mapzen's Terrarium elevation tiles (over Poland,
Copernicus EU-DEM) at zoom 12 around Ty: every 5, 10 or 20 m by the relief, every fifth line
stronger, the ordinary ones fading out between 3 and 5 km. The map fades into the paper towards
the rim; the contours keep half their strength there, and the names sit above the fade. The credit,
"OpenFreeMap © OpenMapTiles © OpenStreetMap · wysokości: Mapzen, Copernicus EU-DEM", has its own
lines under the face, always laid out, faded in once a tile has drawn. It is on by default, since the map is
what invites a tap on a place. A Menu switch, "Mapa pod tarczą kierunku", turns it off and the
phone remembers. The home question is about what reaches the server, so it does not gate the tiles. At a scale change
the new zoom's tiles fade in over the old ones, which stay whole and keep scaling with the rings
until the new ones have settled and the scale has reached the new view; a name that stops fitting fades out and a new one
fades in. Offline or with a corrupt tile the tiles
and contours simply do not appear and the target stays rings on paper. The footer reads Pomiń while nothing is
set. Gdzie for anything earlier, without GPS, or reached from Zmień on remains is
the map; Zmień on an Event placed by direction reopens its target: each tap or Enter writes the point straight to the Draft, a dashed circle shows the
radius slider's value, and search with coordinate entry folds into one disclosure under the map.
The map caption is the one-line OpenStreetMap disclosure; tiles load without a separate action.
Without a fix one line under the method buttons says "Brak pozycji GPS." or "Brak zgody na
lokalizację.", and leaves with the shared reveal when a fix arrives. "Miejsce wskazane" appears
under the map with the radius slider, so a tap never moves the map, and is announced politely.

Sprawdź lists Co, Kiedy and Gdzie, each with Zmień, which opens that step and returns to Sprawdź
on Dalej unless the change opened a new question. The place is said in words ("około 1 km na
północny wschód od Ciebie", "w promieniu około 500 m od wskazanego miejsca"), never as sizes or
cells. The home question appears as two segmented buttons only when no saved home decides it; a
saved home decides by distance and the privacy line then offers "Nie jestem w domu". Under it is a
148 px map of the kept place (the area as a square burnt-orange outline, or a pin for a point,
with a small Ty or Dom mark that stays on the phone) and one privacy sentence. The remains photo is
a required block with camera and gallery buttons. Gatunek (remains and an injured animal only),
optional photos and the note follow under "Możesz dodać" as disclosure rows. Saving under the map
confirms the area; any later change of place, direction, distance or radius needs a new save.

The footer always names the next missing fact. Pressing Zapisz zgłoszenie or Dalej while something
is missing keeps the button pressable, marks the control in the alert colour with its own message,
and focuses it. "Zgłoszenie nie sprowadza pomocy." stands directly above Zapisz zgłoszenie in every
layout. Conditional blocks open with the existing height-and-opacity reveal over 200 ms, none with
reduced motion.

## Touch targets, reflow and focus

Every operable element has an effective target of at least 56 by 56 CSS px, measured on the box a
thumb hits: a radio or checkbox counts as its whole label, never as its 24 px glyph. Radio and
checkbox groups inside completion sections use the Species row: full width, 56 px minimum, the
24 px control leading, a light divider under each row, and the selected row bold beside the orange control.
Inputs, selects and textareas share one field shape everywhere: a filled box, 56 px minimum, with a
2px ink edge along the bottom. One focus rule covers buttons, links, summaries, fields and custom controls: a
3 px teal outline at 2 px offset, in the band's paper colour on the band.

At 200% text and 320 CSS px nothing scrolls sideways. The masthead wraps: brand on one row, Moje
zapisy and Menu on the next, labels kept. At widths up to 360 px the masthead and footer text keep
the ticket 07 caps so the capture action stays in the first viewport; body text scales fully.
Headings and Event labels hyphenate where the platform has a Polish dictionary and break
otherwise. Completion groups may shrink below their content width.

Ticket 15 measured this in the browser at 390, 320 and 390 with doubled text, 844 by 390
landscape and desktop, and checked AA text contrast and 3:1 field borders in light, dark and noc
on every screen of the journey. Physical Android and TalkBack were not checked. Since ticket 29 a
field's edge is its ink line on the fill (13.70:1 in light, 9.37:1 in noc), and the control border
draws only the range track, the target's rings and rim, and the "not set yet" dashes.

## Camera

The in-app camera keeps a near-black surround (#090b09) in every palette, so the preview reads as
the photo. Its chrome follows the surround through the tokens: in light and dark the camera takes
the dark set, in noc it keeps noc's own, and both put paper and ground at #090b09. Nothing on the
screen picks a colour of its own. The shutter, "Zrób zdjęcie", is the footer primary like every
other screen's main action, so it sits under the thumb at every size; the safety line stays above
the preview. At 844 by 390 and at 320 with doubled text the preview starts under the footer and the
Reporter scrolls to frame the photo; fitting the preview to those viewports would be a new layout,
not this placement.

Faza 3 ticket 02 measured it in light, dark and noc at 390, 320 with doubled text, 844 by 390
landscape and desktop. Before, light drew the masthead and the shutter at 1.10:1 and a hovered
"Wróć" or "Menu" at 1.00:1. After, the masthead is 17.34:1 in light and dark and 11.53:1 in noc,
and the lowest text on the screen is the shutter label at 7.36:1 in noc. Ticket 29's palette moved
these values; the Colors table above is current.

## Offline readiness

Menu leads with Polish and English language choices, then one polite live status describing
offline readiness. It says "Gotowe do pracy bez internetu", reports a download, or names
what still needs a connection. A failed shell installation never claims capture is ready.
"Pobierz brakujące pliki" appears only while files are missing and the phone is online;
offline, the caption says files will download when the connection returns. Completion in
Menu uses the existing four-second confirmation above the footer without moving focus or
content. Background downloads preserve confirmations on capture and handoff screens.
The records entry appears once in the masthead. Browser storage and Android reminder advice
stay in Menu; real save errors stay where they happen. Offline, before the PDF files are
stored, "Pobierz PDF" remains disabled and described by a line explaining why. The faza 3
ticket 10 evidence compares Menu with the approved surface prototype across the three
palettes, 320 px with doubled text, landscape and desktop. Physical Android acceptance
remains pending.

## App updates

A new web version installs beside the running one, downloads its directory and PDF files too, and waits.
A running tab never reloads by itself. The browser starts the new version once every window has closed;
faza 3 ticket 12 also starts it when the app opens again while its old page still exists, as on a
reload. That start happens before the first screen is drawn,
only when the app opens on a screen with no Draft or Notice (home, Moje zapisy, Menu) and only when no
other window of the app is open. The waiting worker checks the second condition itself. Nobody sees the
old version first, so nothing appears and then vanishes.

Home and Moje zapisy show nothing about it. Menu shows a status row under the offline line, "Nowa wersja
czeka" with "Uruchomi się sama, gdy następnym razem otworzysz aplikację.", and a full-width secondary
"Uruchom nową wersję" for a Reporter who wants it now. The row grows in with the shared 200 ms reveal
when an update finishes installing while Menu is open, instantly with reduced motion.

Restarting saves the open Draft first. If that save fails, or signer details typed on this phone
are not remembered, a native confirm names what will be lost before anything reloads. A tab left
on the old code that cannot open the upgraded local database says so in the alert area with
"Uruchom nową wersję" on every screen; one that cannot load its PDF engine offers "Uruchom aplikację ponownie".
Neither claims a save or an export. Ticket 25 rendered these at 390 px in light and dark and at
320 px with doubled text; the Android app bundles its files and never shows the offer.

## Public brand

The public name is Bór czuwa in both interface languages. The mark is four tapered lines of wood
grain that part around a round knot, the knot in the action orange. It has no frame. The kit, with
its clear space, minimum sizes, five colour versions and the full and small-size symbols, is in
`brand/` and described in `brand/README.md`; the app takes every mark and icon from there and
does not redraw it. The web header sets the one-colour symbol (`symbol-white.svg`, 32 px, in the
band's text colour) beside the name, since ink and orange would vanish on the orange band. The name
provides the accessible label, so the mark does not repeat it. The favicon is the kit's small-size
symbol on a paper tile.

The Android launcher uses the kit's adaptive foreground on the paper color (#f6f7f5), its monochrome
layer for themed icons, and its day and night splash (paper, and #1b1a17). Legacy icons for Android 7
are cut from the same layers. Alicja picked the mark and logotype from rendered options on 2026-11-12
(ticket 02 of the Bór czuwa rename); the earlier grove-in-an-eye mark of Bór widzi is retired.
