# Authority directory

## Address flags

Review flags on the server with `SELECT kind, unit_id, count(*) AS flags, max(flagged_on) AS last_flag FROM recipient_address_flag GROUP BY kind, unit_id ORDER BY last_flag DESC, flags DESC;`. Find each unit by `kind` and `id` in this directory. Check its current address on the official source page before editing the record and its check date. Flags do not update the directory automatically; the table stores no Report, sender address or bounced message.

Version `2026-09-26` contains all 2,477 gminy from MSWiA's CC0 dataset, 16 PSŁ records, 16 RDOŚ records, 23 parks identified by GDOŚ INSPIRE codes, and 336 KPP/KMP units identified by PRG `IIP_IDENTY`. The latest check found 66 more police intake addresses on unit or BIP pages. Each new address has its source URL and check date. Six PSŁ units and 67 police units still lack a verified intake address. Their records list the pages checked and say what needs confirmation. The manifest stays `complete: false`; this directory is not ready for release.

Ticket 16's internal fixture build bundles this incomplete version so offline
recipient picking can be tested. Units without a verified address stay visible,
but their address cannot be copied. This does not clear the release gate.

To refresh gminy, download the latest XLS release from [MSWiA's dataset](https://dane.gov.pl/pl/dataset/28544), convert it to UTF-8 CSV with LibreOffice, then run `python3 scripts/import-gminy.py INPUT.csv data/authority-directory/gminy.json`. Update the source URL, source date and check date in the importer for the new release. Review the diff by TERYT, especially mailbox changes and source corrections. MSWiA labels its email column as the general address, even when a mailbox begins with `wojt@` or `burmistrz@`; check those entries against the office site when the release changes.

Recheck PSŁ at each urząd wojewódzki, RDOŚ on each regional gov.pl contact page, police through the KWP and KSP unit lists, and each park at its official site. Record the exact page and check date beside each address or gap. Use a published administrative intake mailbox, including a unit commandant or secretariat mailbox. Do not use a duty officer's mailbox or `112`. Revisit missing addresses before each release, and compare PRG and GDOŚ identifiers with the recipients endpoint. Set `complete` to `true` only when every required unit has a verified email. Repeat the check when police stations open or jurisdictions change.

For police records checked in this version, `checkedSources` lists the unit contact page, its BIP homepage, and the KWP or KSP unit directory. `sourceUrl` points to the page that publishes a verified address when one exists. Some BIP pages publish the unit's intake address when its contact page shows only the duty officer; check the email's label before copying it. For PSŁ gaps, `checkedSources` records the urząd wojewódzki pages consulted. A general urząd mailbox is not a verified PSŁ inbox unless the urząd says it accepts PSŁ correspondence there. The six PSŁ and 67 police gaps need direct confirmation from their authorities if the published pages do not change.

To refresh police identifiers, download PRG granice specjalne from [dane.gov.pl dataset 726](https://dane.gov.pl/pl/dataset/726), extract `K02_Komenda_powiatowa_policji.gml`, then run `python3 scripts/import-police-ids.py INPUT.gml data/authority-directory/police.json`. Update the PRG URL, check date and expected unit count in the importer after reviewing any count change. Merge verified contact fields from the previous version by `IIP_IDENTY` after reviewing renamed and removed units. The GDOŚ `GDOS:ParkiNarodowe` WFS layer supplied park identifiers; exclude features whose names end in ` - otulina`.

PRG attribution: „Wykorzystano/opracowano na podstawie materiałów państwowego zasobu geodezyjnego i kartograficznego.”
