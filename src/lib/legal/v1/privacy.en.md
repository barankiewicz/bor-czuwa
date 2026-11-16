# Privacy policy

Version 1, in force from [data startu].

> This is a translation, and the [Polish version](/legal/privacy/v1/) is the binding one.

## Who the controller is

The administrator danych (data controller) is Alicja Barankiewicz, bor-czuwa@pm.me. You can write
to this address about anything to do with data. We reply within a month.

## What we store about a report

The app has no accounts. We do not ask for your first name, surname, email or phone number, and a
report on the server has no field where they could be written.

The server receives:

- the event type and, if you give it, the animal species,
- the time of the incident, the time the report was saved on the phone and the time the server
  received it, rounded to the minute,
- the place of the incident, in one of three forms: the phone's position at the moment of saving
  with its accuracy, a point you placed on the map, or an approximate area. We send an area when you
  judge the incident from a distance, for example a shot by ear, and then add the direction and
  distance you gave. With a point from the map or an area, the phone's position does not reach the
  server,
- whether a note and photos were attached to the report, and a hash of each photo,
- the measurements the server works out after synchronisation: distances from zabudowania
  mieszkalne (homes), obszary chronione (protected areas) and the boundaries of the obwód łowiecki
  (hunting district), the time of day, the okres ochronny (closed season),
- the version of the app, and of this policy and the terms of use in force when the report was made,
- the course of your notices: the kind and unit of the authority, the template version, when the
  notice was prepared and handed over, your confirmation that you sent it and, if you mark it, the
  kind of reply from the authority and its date.

If you report an incident from a home saved in the app, the server gets only an approximate area,
with no direction or distance. The exact location of the home stays on the phone.

The server does not receive:

- the text of the note or the photos themselves. They stay on the phone and go only in the notice
  you send from your own mailbox,
- your details from a signed notice. Your first name, surname and address stay on the phone and go
  only in the notice you send,
- the phone's identifier or model, the interface language, or a trail of your positions.

A draft (a report saved with one tap so you can finish it later) never leaves the phone.

## IP address

The server sees the IP address when the phone connects to it, but never records it: not in logs
and not in the database. To make it harder to flood the database with false reports, on every
write to the server we compute a hash of the address with a random salt, which the server keeps
only in memory and draws afresh at midnight. The hash is not linked to any report and expires at
midnight, so after 25 hours at most. The server deletes expired hashes every minute, and if it was
not running, as soon as it starts again. HTTP request logging is switched off, and the HTTP
server's error logs are discarded.

We treat the phone's position and the address hash as personal data, although we ourselves cannot
link them to any person.

## On what basis

Art. 6(1)(f) GDPR: our legitimate interest, which is documenting incidents connected with hunting,
so that the competent authorities can be notified of them and the scale of the problem can be
shown. We do not ask for consent. Providing data is voluntary.

## Who has access

We rent the server from OVH, which processes data on our behalf. The server is in Canada, outside the
European Economic Area. Canada has a European Commission adequacy decision (Art. 45 GDPR). We keep report data only there. We make no backups ourselves.
OVH copies the server's disk daily and keeps only the latest copy, at most a day old. The project's mail is handled by Proton, in Switzerland. The information website is
hosted by LH.pl, whose server records visitors' IP addresses
for 30 days. Maps and place search use the
OpenStreetMap services described below.

We send nothing to the authorities. You send the notice from your own mailbox, or file a signed one
as a PDF through ePUAP or e-Doręczenia. The app does not log in to those services and does not
know whether the notice arrived. This is the only way a report reaches the police, Państwowa Straż
Łowiecka or the gmina.

## Map and place search

The map stays closed until you choose "Show map". The app remembers that choice for the current
session. It does not open the map on the basis of a saved home. Once the map is open, the phone
downloads map tiles directly from tile.openstreetmap.org. OpenStreetMap receives the phone's IP
address, our app's address and the area you are viewing, including when you pan or zoom the map.

Search works only after you press "Search". Our server passes the name you typed to OpenStreetMap's
Nominatim service. It does not pass the phone's IP address, the saved position or your home.
Nominatim sees our server's IP address. Do not type your home address. We keep up to 200 searched
names with their results in the server's memory. Later searches replace the oldest entries, and a
server restart deletes them all. We do not write searched names to logs.

These services are run by the OpenStreetMap Foundation, based in the United Kingdom, outside the
European Economic Area. The United Kingdom and Switzerland (Proton) have European Commission
decisions on an adequate level of data protection. The basis is our legitimate interest in showing
the map and finding a place (Art. 6(1)(f) GDPR). How their requests are handled, including logs and processing outside the
EEA, is governed by the
[OpenStreetMap Foundation's privacy policy](https://wiki.osmfoundation.org/wiki/Privacy_Policy).
Our rules on logs do not cover OpenStreetMap's servers.

## Publication

Reports will be published on a public map, with an approximate place and the date. We do not
publish notes or photos, because we do not have them on the server. We do not publish your phone's
position.

## How long

Reports are an archive and have no expiry date. Apart from OVH's daily disk copy there are no other copies.

You can withdraw a report in the app. We then delete the report, its measurements and the course of
its notices from the server. What remains is the report's random number, a hash of the withdrawal
key and the time of withdrawal to the minute, so that a report sent late does not come back to the
server. The report leaves OVH's disk copy within a day, when the next copy replaces it.

## Your rights

You have the right to access your data, to have it corrected or erased and to have its processing
restricted, the right to object, and the right to complain to the Prezes Urzędu Ochrony Danych
Osobowych (President of the Personal Data Protection Office). Because we do not know who sent
which report, your request must identify the report, for example by place and time.

<h2 id="jesli-zgloszenie-dotyczy-ciebie">If a report concerns you</h2>

A report may concern a person who was, or may have been, at a hunt. We do not know who that person
is, so we cannot inform them personally (Art. 14(5)(b) GDPR). This part is for them.

The controller is Alicja Barankiewicz, bor-czuwa@pm.me. We process reports on the basis of
Art. 6(1)(f) GDPR, in the interest described above.

A report contains the place, the time, the event type, the species and distance measurements. It
does not contain names, photos or descriptions. The measurements describe a place and a time, not
people, and we take no decision about anyone on the basis of them.

Reports come from anonymous users of the app. The recipients will be everyone who views the public
map, and OVH processes the data on our behalf. We keep report data with no time limit on the
server in Canada. We have described the use of the map and place search separately
above.

If you believe a report concerns you, write to bor-czuwa@pm.me with the subject "sprzeciw /
usunięcie" (objection / removal) and identify the report: by its number on the map, or by place and
date. On the map, each report will also have a link to such a request. We will reply within a
month. A request we grant takes the report off the map. It stays in the archive and in the count of
reports, unpublished.

You have the right of access, rectification, erasure, restriction of processing and objection, and
the right to complain to the Prezes Urzędu Ochrony Danych Osobowych.
