"""Measure synthetic acceptance points with OGR, independently of application SQL."""
import json
from pathlib import Path
from osgeo import ogr, osr

root = Path('data/fixtures/protected')
source = osr.SpatialReference(); source.ImportFromEPSG(2180)
source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
target = osr.SpatialReference(); target.ImportFromEPSG(4326)
target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
transform = osr.CoordinateTransformation(source, target)
cases = {
    'park_margin': ('ParkiNarodowe', 0, 744010, 620500),
    'park_inside': ('ParkiNarodowe', 0, 744300, 620500),
    'park_boundary': ('ParkiNarodowe', 0, 744000, 620500),
    'otulina': ('ParkiNarodowe', 1, 743900, 620500),
    'reserve_neither': ('Rezerwaty', 0, 747300, 620500),
    'reserve_tasks': ('Rezerwaty', 1, 749300, 620500),
    'reserve_missing': ('Rezerwaty', 2, 751300, 620500),
    'reserve_plan': ('Rezerwaty', 3, 747300, 623500),
    'context': ('ParkiKrajobrazowe', 0, 749300, 623500),
    'outside': ('ParkiNarodowe', 0, 754000, 628000)
}
result = {}
for name, (layer, index, x, y) in cases.items():
    feature = json.loads((root / f'{layer}.json').read_text())['features'][index]
    geometry = ogr.CreateGeometryFromJson(json.dumps(feature['geometry']))
    point = ogr.Geometry(ogr.wkbPoint); point.AddPoint_2D(x, y)
    lon, lat, _ = transform.TransformPoint(x, y)
    result[name] = {'point': {'lat': lat, 'lon': lon}, 'point_2180': [x, y],
                    'boundary_m': point.Distance(geometry.Boundary())}
(root / 'acceptance.json').write_text(json.dumps(result, indent=2) + '\n')
