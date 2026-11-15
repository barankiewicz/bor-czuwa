# Protected-area acceptance fixture

These polygons and CRFOP rows are synthetic. They are not the protected areas of
powiat moniecki. They sit inside the existing BUBD coverage so the API can test
protected-area rules alongside real residential footprints. Do not use this
fixture to describe a real place.

The five GeoJSON files use the GDOŚ layer names, `nazwa`, `kodinspire`, and
EPSG:2180. The XLSX uses the CRFOP export columns and includes a continuation row
for legal history. The two reserves named Testowy Las have different INSPIRE ids:
`fixture.3` has neither document; `fixture.4` has zadania ochronne. Testowy Nowy
is absent from the workbook. Testowy Plan has both document types.

The park is a 1000 m square from (744000, 620000) to (745000, 621000).
The otulina is a separate 1400 m square with that park cut out as a hole.
The acceptance points are 10 m and 300 m east of the park's western boundary.
Reserve and context squares use the same 1000 m side. Two OSO polygons overlap
to check that Findings retain every membership.

`acceptance.json` was measured with GDAL 3.6.2 OGR, independently of PostGIS.
Coordinates use traditional GIS axis order, including EPSG:2180. Reproduce it
from the repo root with the fixture container:

```sh
podman compose run --rm --no-deps \
  -v ./data/fixtures:/app/data/fixtures:Z \
  fixture python scripts/measure-protected-fixture.py
```

The source URLs in `manifest.json` identify the formats these synthetic files
stand in for. The hashes cover the checked-in fixture bytes, not a GDOŚ download.
The manifest marks this explicitly with `synthetic: true`.
