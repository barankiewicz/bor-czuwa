"""Independent GDAL/OGR measurements, never importing application SQL or code."""
import json
from pathlib import Path
import pyarrow.parquet as pq
from osgeo import ogr, osr, gdal

ogr.UseExceptions()
points_path = Path('data/fixtures/acceptance.json')
points = json.loads(points_path.read_text())
rows = pq.read_table('data/fixtures/bubd.parquet', columns=['KODKST', 'GEOM']).to_pylist()
houses = [ogr.CreateGeometryFromWkb(row['GEOM']) for row in rows if row['KODKST'] == 110]
others = [ogr.CreateGeometryFromWkb(row['GEOM']) for row in rows if row['KODKST'] != 110]
wgs84, projected = osr.SpatialReference(), osr.SpatialReference()
wgs84.ImportFromEPSG(4326)
projected.ImportFromEPSG(2180)
for crs in [wgs84, projected]:
    crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
transform = osr.CoordinateTransformation(wgs84, projected)
for name, sample in points.items():
    point = ogr.Geometry(ogr.wkbPoint)
    point.AddPoint_2D(sample['point']['lon'], sample['point']['lat'])
    point.Transform(transform)
    nearest = min(houses, key=lambda geometry: geometry.Distance(point))
    sample['expected_m'] = nearest.Distance(point)
    sample['nearest_centroid_m'] = nearest.Centroid().Distance(point)
    sample['nearest_nonresidential_m'] = min(geometry.Distance(point) for geometry in others)
    sample['method'] = f"{gdal.VersionInfo('--version')}; OSR EPSG:4326 to EPSG:2180, OGR Geometry.Distance to every KODKST=110 footprint; minimum"
    print(name, sample['expected_m'], 'centroid', sample['nearest_centroid_m'])
points_path.write_text(json.dumps(points, indent=2) + '\n')
