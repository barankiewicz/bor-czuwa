# Powiat moniecki fixture

`bubd.parquet` contains all 41,521 BUBD buildings for TERYT `2008`, extracted from
GUGiK's national GeoParquet on 24 September 2026. It retains `TERYT`, `LOKALNYID`,
`KODKST`, and `GEOM`. The loader keeps the 11,946 residential footprints, KST 110.
Source: Główny Urząd Geodezji i Kartografii, BDOT10k, public Geoportal download.
The source URL and hashes of both the national file and this extract are recorded
in `manifest.json`.

The app computes Findings only inside the EPSG:2180 rectangle in the manifest.
Extraction checks the national file for residential buildings from other powiaty
inside that rectangle plus 1000 m. There were none. This prevents a boundary point
from treating an omitted neighboring house as an empty search radius.

`acceptance.json` carries synthetic Report points against real source footprints.

`osm/` contains two synthetic `hunting=stand` features. They exercise OSM loading
without implying either stand exists in Moniecki. `osm/acceptance.json` records
independent PROJ measurements from an indicated point and an Incident area centre; an area's
own Findings are measured from its edge, see `area-acceptance.json`.

`recipients/` contains PRG jurisdiction polygons clipped to this fixture's area.
Its park and rezerwat polygons are synthetic and marked in the manifest. They
exercise routing only; they do not describe protected areas in powiat moniecki.
Regenerate the PRG extract with `scripts/extract-recipient-fixture.py` using the
two dane.gov.pl PRG ZIP files named in `recipients/manifest.json`. The fixture
container loads these polygons under the same geodata snapshot id as BUBD.
Expected values were measured with GDAL 3.6.2's OGR API, transforming WGS84 to
EPSG:2180 and taking the minimum `Geometry.Distance` across KST 110 footprints:

| Point | Distance to footprint | Distance to that footprint's centroid | Purpose |
| --- | ---: | ---: | --- |
| edge | 140.000 m | 145.896 m | Reject centroid measurement |
| barn | 270.872 m | 275.103 m | Exclude nonresidential buildings at the point |
| empty | 2186.776 m | 2195.192 m | Return `none_within_radius` for the 1000 m cap |

The API tests allow 0.5 m error. They load the recorded expected values and never
generate them from the application's SQL. To repeat the independent measurement:

```sh
podman compose run --rm --no-deps \
  -v ./data/fixtures:/app/data/fixtures:Z \
  fixture python scripts/measure-fixture.py
```

To recreate the extract, install `scripts/requirements-fixture.txt` in a virtual
environment with GDAL 3.6.2 available and run:

```sh
python scripts/extract-fixture.py /path/to/OT_BUBD_A.parquet
```

GUGiK's national URL is mutable. Reproducing these bytes requires the source hash
in the manifest; a newer download requires a new dated snapshot and fresh acceptance
measurements. The 1.72 GB national file is not committed.

## Incident area acceptance

`area-acceptance.json` holds Incident areas around the points above and four home grid cells.
OGR measures each one independently of the application: minimum distance to the nearest
residential footprint and the fraction of the whole area within 150 m of any residential
footprint, obwód overlap shares, wholly or partly inside each synthetic protected area with
the boundary margin, and distance to OSM stands from the area's edge and from its centre.
Cases are listed in `scripts/area-cases.json`; regenerate with:

```sh
podman compose run --rm --no-deps \
  -v ./data/fixtures:/app/data/fixtures:Z -v ./scripts:/app/scripts:Z \
  fixture python scripts/measure-area-fixture.py
```

Each case records whether the snapshot covers the whole Incident area. Partial coverage
produces `outside_coverage` for spatial Findings, without changing time Findings.
The real 4 km and 8 km home cells contain houses, so `area-synthetic.json` separately
proves far, partly within the threshold, and containing dwellings for every area basis,
using genuine 4 km home grid bounds against explicitly synthetic geodata.

The same OGR generator writes both acceptance files. Synthetic cases also prove boundary-only
contact, threshold equality, whole and near-whole threshold shares, overlapping dwelling
buffers, protected-document conditions, and zero boundary margin. A positive 1 m² district
and park overlap remains present even though its share is below `1e-6`; boundary-only
contacts remain absent. No relative-area cutoff defines an overlap.

District expectations union features by number and source year. OGR subtracts every newer
vintage from each older geometry before measuring its remaining share. The mixed-year case
retains adjacent older land, gives newer coverage precedence, and records the actual year
of each fragment, including two vintages of the same district number.

`tests/api-area-synthetic.test.ts` creates and removes its own dedicated database, uses the
real migrations and restricted `app_runtime` role, and exercises real HTTP and the Findings
worker. Four serial, fixed-clock API groups own independent rate salts, with at most fourteen
Reports per group; no counters are reset. The real-fixture API suite additionally needs the
normal Findings worker running against its disposable fixture database.
