# Bór czuwa

An app for reporting hunting incidents in Poland to the authorities. A witness records what they
saw, the app establishes the facts of place and time, and the witness sends those facts to the
authority that has jurisdiction. Reports are collected centrally so the scale of the problem can be
shown later.

The repo is written in English, and so is the code. Product concepts take an English headword with
the Polish in parentheses. Terms of art from Polish statutes keep their Polish headword, because
translating a term that names a thing in the ustawa invents law that does not exist. The app itself
ships in Polish and English; a Notice is always written in Polish whatever the interface language,
since its recipient is a Polish authority.

## Language

### What a reporter creates

**Report** (zgłoszenie):
One record created by one reporter about one thing they saw or heard, at one place and one time.
Exists and counts whether or not a Notice is ever sent.
_Avoid_: incident, alert, submission, donos

**Draft** (szkic):
A Report not yet created: the device fix and the occurrence time, saved with one tap so the
reporter can leave first and finish later from somewhere safe. Lives only on the phone, never syncs
and never counts. Choosing an Event type does not create a Report: the Reporter must finish the
required facts and explicitly save it as a Report (ADR-0010).
_Avoid_: pending report, unsent report (a Report is never "sent")

**Event type** (typ zdarzenia):
The category of a Report, chosen by the reporter from a fixed list: shot (strzał), armed person
(człowiek z bronią), remains (szczątki w lesie), injured animal (ranne zwierzę), poaching
(kłusownictwo).
_Avoid_: kategoria, category, incident type

**Reporter** (zgłaszający):
The person who creates a Report. Never identified to us.
_Avoid_: user, witness, świadek (which has a specific legal meaning we do not want to imply)

**Reported person** (osoba, której dotyczy zgłoszenie):
Whoever a Report points at: the hunter, the koło, the dzierżawca. A Reported person need not be
identifiable, but when they are, it is their data the archive holds, and they never consented.
_Avoid_: suspect, sprawca, perpetrator, podejrzany (all of which prejudge the facts)

**Species** (gatunek):
The animal a Report concerns, where the reporter knows it. Optional, and "nie wiem" is a value
distinct from leaving it unset, because okres ochronny cannot be checked without it.
_Avoid_: animal, zwierzę

**Notice** (powiadomienie):
The message a Reporter sends to one authority about their Report, by email or as a locally made
PDF filed through an official service. One Notice has one recipient; a Report exists whether or
not any Notice is sent.
_Avoid_: notification, tip, donos, zawiadomienie (which is a legal term of art, see below)

**Signed Notice** (powiadomienie podpisane):
A Notice carrying the Reporter's name and correspondence address, entered on the phone and never
synced. It can leave by email or as a PDF the Reporter files through an official service, and is
the only kind that can be a zawiadomienie under k.p.k.
_Avoid_: named notice, identified notice

**Unsigned Notice** (powiadomienie bez podpisu):
A Notice with no name in its body. Not anonymous to its recipient, since it leaves from the
reporter's own mailbox and the sending address is visible. Anonymous only to us.
_Avoid_: anonymous notice, anonimowe powiadomienie

**Notice outcome** (wynik powiadomienia):
What the Reporter says happened after sending one Notice to one authority. It is self-reported,
not confirmation from the authority, and is distinct from the Report's lifecycle.
_Avoid_: Report outcome, verified response, delivery confirmation

**Zawiadomienie o podejrzeniu popełnienia przestępstwa**:
The formal legal notice under k.p.k. A Notice only becomes one when the reporter attaches their
identity. An anonymous Notice is handled as the organ's own lead and is not a zawiadomienie.
_Avoid_: using this interchangeably with Notice

### What the app establishes

**Findings** (ocena):
The set of facts the app establishes about a Report's place and time: distances to the nearest
relevant features, which protected areas the point falls in, whether the date falls in an okres
ochronny. Findings state measurements, never a verdict of guilt, which is why they are not called
an assessment.
_Avoid_: assessment, verdict, violation, naruszenie

**Rule set** (zestaw reguł):
A dated version of the legal rules Findings are computed against: buffer distances, species
seasons, protected-area treatment. Every Findings record names the Rule set that produced it,
because the law changes and old Reports must stay comparable.
_Avoid_: ruleset config, legal config, rules version

**Accuracy** (dokładność):
The accuracy radius the device reports for a coordinate. Part of the Findings, never discarded,
because a 150 m rule cannot be applied honestly without it. A location the reporter placed by hand
has no Accuracy at all, and that absence is recorded rather than filled in.
_Avoid_: precision, error margin, uncertainty

**Occurrence time** (czas zdarzenia):
When the reported thing happened, as against when the Report was written. Carries how the reporter
supplied it and how coarse it is, because a reporter who remembers only the day is a different fact
from one whose phone recorded the minute. Findings are computed against it, so a Report filed the
next morning is still judged against the night it concerns.
_Avoid_: timestamp, date, capture time (which is the other field)

**Geodata snapshot** (migawka geodanych):
One dated set of every external dataset Findings are computed against, each with its source, its
retrieval time and a hash of the bytes. Findings name a snapshot the way they name a Rule set. The
law is one moving input and the geodata is the other, and neither publisher tells us when it moved.
_Avoid_: data version, dataset vintage, refresh

**Incident location** (miejsce zdarzenia):
Where the reported thing happened, as against where the phone was when the Report was written.
It can be a point or an Incident area; Findings use the form and uncertainty the Reporter supplied.
_Avoid_: position, coordinates, GPS

**Hearing location** (miejsce, z którego słychać strzał):
Where the Reporter heard a shot, which can differ from where it happened. A home Hearing location
stays on the phone and is used only to estimate the Incident area.
_Avoid_: Incident location, shot location

**Incident area** (przybliżony obszar zdarzenia):
An approximate region where the Reporter believes the event happened. Its basis and the reason a
precise point was withheld are recorded separately; it has no device Accuracy. The basis is an area
the Reporter chose, an estimate by ear (a shot heard now) or an estimate by sight (a person with a
gun, an injured animal or poaching seen now), the last two from a direction and distance.
Findings measure the whole area (nearest dwelling distance, the fraction within the Rule set's
threshold, overlap shares and wholly or partly inside), never its centre (ADR-0011). Spatial
Findings require geodata coverage of the whole area; partial coverage remains unavailable.
_Avoid_: pin, GPS radius, precise location

**Integrity signal** (sygnał wiarygodności):
A fact about a Report as a report rather than about the law: that its point repeats another Report's
exactly, that it arrived in a burst, that its sender went over the rate limit. Kept apart from
Findings so that a doubt about the Report can never be read as a doubt about the law, or the reverse.
A signal never blocks a Notice and never appears in one.
_Avoid_: flag, suspicion, spam score, fraud

**Exclusion** (wykluczenie):
The operator's public, reasoned decision that a Report does not belong in the counts, typically
because it is part of a fabricated flood. An excluded Report stays in the archive and on the public
record, shown as excluded with its reason, and every aggregate states how many were excluded. Not a
removal: a removal answers a request about personal data and never changes a count, an Exclusion
answers a doubt about the Report and does. Can be lifted.
_Avoid_: deletion, rejection, moderation, removal (which is the other thing)

**Withdrawal** (wycofanie zgłoszenia):
The Reporter deleting their own Report from the phone that made it, because it was a mistake. A
synced Report is deleted on the server with its token, together with its events, Findings and
Integrity signal. Withdrawal of an included Report shrinks the included count. Withdrawal of an
excluded Report keeps its contribution to the excluded tally, with no Report facts left in that
tally. The separate token marker prevents a delayed upload from restoring a withdrawn Report; it
belongs to the token that withdrew, so it never stops a Report made with another token, and it
holds no Exclusion state. A queued Report is only deleted on the phone. Only the
Reporter can do it, and not once the app is gone. Neither a removal, which answers someone else's
request and never changes a count, nor an Exclusion, which leaves the Report on the record.
_Avoid_: deletion, cancellation, removal, retraction

### Places and times the law cares about

**Zabudowania mieszkalne** (residential premises):
The thing the 150 m shooting ban is measured from. Not any building: a barn or a shed is not
zabudowanie mieszkalne.
_Avoid_: budynek, building, built-up area, zabudowa

**Obszar chroniony** (protected area):
Any area under nature protection. Only some of them restrict hunting, so this term never stands
alone in Findings; the specific form is always named.
_Avoid_: protected zone, park (ambiguous between park narodowy and park krajobrazowy)

**Otulina** (buffer zone of a park or reserve):
A zone around a park narodowy or rezerwat, sized individually per area by the act that creates it.
There is no statutory distance. It protects the area inside it from external threats and does not
carry that area's own prohibitions, so hunting is not banned in an otulina. GDOŚ publishes the
geometry inside the park and reserve layers, marked only by a `" - otulina"` suffix on the name.
_Avoid_: buffer, strefa buforowa, 150 m buffer (which does not exist)

**Strefa ochronna zwierząt łownych** (game protection zone):
An individually sized zone that may be created inside a park narodowy's otulina, established per
park by rozporządzenie. Only a park narodowy may have one, a rezerwat cannot, and most otulina has
none, because creating one is discretionary. Hunting there is not prohibited outright: the zone is
kept out of every obwód łowiecki, and since a hunt needs an obwód's dzierżawca to authorise it,
nobody can. There is no dataset.
_Avoid_: strefa ochronna without the qualifier, which means something else in other statutes; saying
a zone exists wherever an otulina does

**Plan ochrony** and **zadania ochronne** (conservation plan, conservation tasks):
The two kinds of act that may designate areas inside a rezerwat where hunting is permitted. A
reserve with neither cannot have such an area, which is the one fact that lets Findings assert the
ban. Whether either exists is published per reserve; what it says is not.
_Avoid_: management plan, conservation plan as a headword

**Obwód łowiecki** (hunting district):
Cities and villages are structurally excluded from them, so a point outside every obwód łowiecki is
itself evidence.
_Avoid_: hunting ground, hunting district as a headword, teren łowiecki

**Noc** (night, as the regulamin polowań defines it):
From one hour after sunset to one hour before sunrise. Only a named list of species may be hunted
then. Both the window and the list live in the regulamin polowań, so both are Rule set data, and
both are computable from a coordinate and a moment without any dataset at all.
_Avoid_: night, after dark, nocturnal

**Okres ochronny** (closed season):
The closed season for a given Species. Set by rozporządzenie and amended often. A Species removed
from the game list entirely is a stronger fact than a closed season and is never described as one.
_Avoid_: closed season as a headword, protected period

**Polowanie zbiorowe** (collective hunt):
A hunt the dzierżawca must notify to the wójt and nadleśniczy 14 days ahead and which the wójt must
publish.
_Avoid_: driven hunt, group hunt

### The project's own documents

**Terms of use** (regulamin serwisu):
The rules for using the app, published by the operator. Never shortened to "regulamin", which in
this glossary means the regulamin polowań.
_Avoid_: regulamin (alone), terms of service, ToS

**Privacy policy** (polityka prywatności):
What the operator tells both the Reporter and the Reported person about the data the project holds.
_Avoid_: RODO clause, klauzula informacyjna, privacy notice
