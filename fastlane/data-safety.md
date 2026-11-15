# Play data-safety draft

Draft answers for Alicja and legal review, based on the current source. Recheck against
the signed release and the current Play Console definitions before submitting. No
answer here replaces human step 02 or production TLS/provider verification.

The app collects data when a saved Report synchronizes. Drafts stay local. There are no
accounts, advertising SDKs or analytics SDKs. OVH in Canada hosts the Report database.
Backups are off by decision. Reports have no expiry; Withdrawal deletes their data,
with minimal tombstones/counts kept for replay and aggregate integrity.

| Console question | Proposed answer and evidence |
| --- | --- |
| Does the app collect or share user data? | Yes. Report place/time and related fields leave the device. Do not select "no data collected" because the app has no accounts. |
| Approximate location | Collected for app functionality, optionally through Report submission. Home Reports and area Reports send approximate Incident areas. |
| Precise location | Collected for app functionality where a Report uses a precise non-home point. GPS permission is optional; manually chosen places also leave the device. |
| Other user-generated content | Declare Report event type, species if supplied, time, photo hashes and note/photo presence flags for app functionality and abuse prevention. Note text and photo bytes never go to our API. Confirm Play's classification of hashes at review. |
| Device or other IDs | Conservatively declare random Report IDs and authorization-token hashes, plus the salted network-address hash used for abuse prevention. These identify a Report or admission bucket, not a device/account. Do not claim they are advertising IDs. Confirm classification with the Console guidance. |
| Name, email, postal address | Kept locally for a Signed Notice. We do not collect them. A user sends them to an authority through their own mail or official filing service. Review the user-initiated transfer exception before marking these as shared. |
| Photos | Kept locally, passed to the user's chosen destination only through their handoff. Review that exception separately from the hashes our API collects. |
| Is collected data processed ephemerally? | No for Reports, Findings, token/photo hashes and Notice lifecycle events. The unlinked salted address hash expires at Warsaw midnight, at most 25 hours after storage; it is stored in the database, so do not classify all collection as ephemeral. |
| Is collection optional? | The user can retain a Draft without submission. Report submission needs a place, time and event type. Species and photos depend on Event type; explain required fields at the relevant Console questions. |
| Is data encrypted in transit? | Intended yes: the release script requires an HTTPS API origin. Confirm real TLS on the release host and external services before selecting yes. |
| Can users request deletion? | Yes: Withdrawal in the app removes the Report from phone and server after sync. Legal contact handles rights requests from others; the public mailbox/Privacy policy URL still require human steps 02/03. There is no account to delete. |
| Is data shared? | OVH processes it for us; review the service-provider exception. OSM receives IP and viewed map area, Nominatim receives submitted search text and server IP. Treat location transfer to OSM as sharing unless the reviewed Console definition provides an applicable exception. |

Map/search requests are independent of Report synchronization.

No purchase, payment, health, contact-list or browsing-history data is collected by our
API. No identity is attached to a Report. "Anonymous" is not a reason to omit location,
Report identifiers or other transmitted fields from the Console answers.
