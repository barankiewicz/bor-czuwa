# Bór czuwa

[Polski](README.md)

Hunters in Poland largely police themselves, so this app lets anyone who hears a shot near their
home or finds a wounded animal report it to the police, the gmina and the Hunting Guard, and every
report gets counted.

The domain will be chosen before the first public release. The Polish version of this page is the original.

## What the app does

You record what happened: a shot, a person with a gun, remains in the forest, a wounded animal, or
poaching. The phone records the place and the time together with how accurate the fix is. You do not
need signal for this. In a forest there usually is none, and the app treats that as normal.

Once the report reaches the server, the server measures the place against the law: the distance to
the nearest zabudowania mieszkalne, the boundaries of any park narodowy or rezerwat, the obwód
łowiecki, whether it was noc, and the okres ochronny if you name the species. From that and your
description the app composes a notice to the police, Państwowa Straż Łowiecka and the gmina, and
also to the park or the RDOŚ when the place lies inside a park narodowy or a rezerwat. The notice
names the rules the measurements bear on. You send it from your own mailbox. The app does not know
whether the notice arrived, and it never says it was sent.

Every report is counted, including when you send no notice at all.

## Who it is for

Above all for somebody who hears shooting behind their house at dawn. They are at home, they know
the area, they may be frightened or angry, and they do not need to know hunting law.

Also for mushroom pickers, dog walkers and runners who run into a hunt in the forest, often with no
signal and one hand free. And for people who watch polowania zbiorowe on purpose and file many
reports. They know the law better than the app does and want speed, not explanations.

## Why

Today there is no single place to report a hunt that breaks the rules. Państwowa Straż Łowiecka is
run separately in each voivodeship and takes reports through no shared form. You have to find an
address on the right urząd wojewódzki's website. Krajowa Mapa Zagrożeń Bezpieczeństwa takes reports
of poaching, but of no other breach during a hunt. Polski Związek Łowiecki has no public reporting
channel, and its disciplinary proceedings stay in-house. No Polish NGO runs a tool for these
reports.

This project is openly opposed to hunting and to a system in which hunters largely police their own.
It wants these incidents to reach the authorities whose job it is to deal with them, and it wants
them counted.

## What the app does not do

It does not rule on guilt. The findings give measurements with their accuracy and the rule those
measurements bear on. The authority that receives the notice decides. The app states that hunting is
banned in two cases only: inside a park narodowy, and inside a rezerwat that has neither a plan
ochrony nor zadania ochronne. In both, only where the distance from the boundary is greater than the
accuracy of the fix.

It does not know who you are. There are no accounts and no identity field, and your name never
reaches the server. If you want to sign the notice, the signature is added on the phone. The
recipient will see the address the notice came from. An unsigned notice does not oblige the
authority to open proceedings, and you will not hear the outcome. The app tells you this at the
moment you choose.

It is not an emergency channel. A report does not bring help.

It is not a campaign tool. There are no petitions, calls to action or share buttons in it.

## Safety

A report about a shot or a person with a gun is made near somebody holding a gun. So nothing in the
app asks you to approach, follow anyone, stay where you are, wait for a better GPS fix, or
photograph a person. The app records the accuracy the phone reports first, however poor.

You can leave first. One tap saves a draft: the place and the exact time. You fill in the rest
later, somewhere safe or at home. The draft stays on the phone and does not expire.

The phone stays quiet: no flash, no sound, no vibration. At night the report screen is dark.

On confrontation the app says one sentence: "Do not approach and do not interfere with the hunt: it
is dangerous, and obstructing a hunt is a criminal offence."

## What we store

Reports are stored centrally. For shots and any report made from home, the exact point stays
on your phone and the server receives the confirmed approximate area. Other reports retain
coordinates at full precision. Measurements are stored as numbers rather than as a yes or a no.
Photos and the note stay on your phone. The server receives only a hash of
each photo and the fact that a note exists. IP addresses are not written to disk.

The law is stored as dated rule sets, and every set of findings names the rule set that produced it.
A change in the law, such as the distance from buildings, does not invalidate older reports.

The server is a VPS in Canada; deployment still needs verification.
The data controller is Alicja Barankiewicz. The privacy policy and terms of use await legal
review before public release.

## Uwaga! Polowanie

An independent project, supported on the substance by Komitet Inicjatywy Uwaga! Polowanie.

The komitet provides legal help and writes the wording of the notices to the authorities. The
project supports the komitet and its citizens' bill, but it is not their product and does not speak
for them.

## Future public map

Data is collected centrally for a future public map of reports and figures over time.
The map will show every report, without photos or notes. Any report can be taken off the map on a
request sent by email, but a removal does not lower the count of reports. Excluding a report as
fabricated, duplicate or a test lowers that count; the exclusion is public, gives its reason and
can be lifted. Withdrawing your own report from the phone that created it is a separate operation:
it deletes the report and lowers the count.

Older documents call the map "phase 2". The current phase 2 covers improvements from the app audit.
The map remains separate future work, requiring its own specification and a data protection
impact assessment before publication.

## Status

The web app, Android build and server are implemented, with code in this repository.
The stack is TypeScript, SvelteKit, Capacitor and PostgreSQL/PostGIS. iOS is not planned.
Phase 1 closed on 26 September 2026 with unfinished work transferred to later tickets.
The local version uses test data and is not ready for public release.

[Faza 6](.scratch/faza-6/issues/README.md) is closed. Faza 7 is the final audit and remediation phase.
Release still requires [legal and organizational work](.scratch/pre-production-human-steps/README.md),
verified authority inboxes, production deployment checks and final Android/browser acceptance.
[DEVELOPMENT.md](DEVELOPMENT.md) covers setup, tests and remaining release gates.
Some planning documents under `.scratch/` are local and may be absent from a fresh clone.

## Licence

The app code is open source under the GNU GPL, version 3 or later. The full text is in [LICENSE](LICENSE).
