"""Extract powiat moniecki and verify its test coverage against national data."""
import hashlib
import json
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from pyproj import Transformer
from shapely import box, from_wkb, intersects

source = Path(sys.argv[1])
parquet = pq.ParquetFile(source)
x, y = Transformer.from_crs(4326, 2180, always_xy=True).transform(22.797, 53.405)
coverage = [x - 10000, y - 4000, x + 4000, y + 8000]
expanded = box(coverage[0] - 1000, coverage[1] - 1000,
               coverage[2] + 1000, coverage[3] + 1000)
parts = []
for group in range(parquet.num_row_groups):
    table = parquet.read_row_group(group, columns=['TERYT', 'LOKALNYID', 'KODKST', 'GEOM'])
    county = table.filter(pc.equal(table['TERYT'], '2008'))
    if len(county):
        parts.append(county)
    other = table.filter(pc.and_(pc.not_equal(table['TERYT'], '2008'),
                                pc.equal(table['KODKST'], 110)))
    # A distance within this window must not overlook a house across the county border.
    if intersects(from_wkb(other['GEOM'].to_pylist()), expanded).any():
        raise ValueError('Coverage omits neighboring dwellings; choose a smaller window')

table = pa.concat_tables(parts)
fixture = Path('data/fixtures/bubd.parquet')
fixture.parent.mkdir(parents=True, exist_ok=True)
pq.write_table(table, fixture, row_group_size=1000, compression='zstd')
with source.open('rb') as stream:
    source_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
with fixture.open('rb') as stream:
    fixture_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
manifest = {
    'id': 'moniecki-2026-09-24-interior-v1',
    'powiat_teryt': '2008',
    'source_url': 'https://opendata.geoportal.gov.pl/bdot10k/schemat2021/GeoParquet/OT_BUBD_A.parquet',
    'retrieved_at': '2026-09-24T16:00:00Z',
    'source_sha256': source_digest,
    'sha256': fixture_digest,
    'coverage_bbox_2180': coverage,
    'row_count': len(table),
    'residential_count': pc.sum(pc.cast(pc.equal(table['KODKST'], 110), pa.int64())).as_py()
}
Path('data/fixtures/manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f"Extracted {len(table)} buildings from powiat moniecki")
