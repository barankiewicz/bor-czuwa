"""Independent GDAL/OGR measurements of Incident areas, never importing application SQL or code.

Each case is a WGS84 box, as a Reporter's phone sends it. The box becomes a polygon in
EPSG:2180 by transforming its four corners, which is how the server builds the same
polygon. Every expected value below comes from OGR geometry calls on the checked-in
fixture files:

- dwelling min: OGR Distance from the area polygon to the nearest KODKST=110 footprint
- dwelling within_threshold_share: OGR Area of (area intersected with the 150 m Buffer of every footprint
  within 150 m of the area) over the area's own Area
- obwod share: OGR Intersection area over the area's own area, per BDL polygon
- protected coverage: OGR Difference (wholly) or positive Intersection area (partly); the margin
  to the boundary of a wholly contained area is the Distance from the area to the boundary
- ambona: OGR Distance from the area polygon to each OSM stand
"""
import json
import math
import sys
from pathlib import Path
import pyarrow.parquet as pq
from osgeo import ogr, osr, gdal

ogr.UseExceptions()
root = Path('data/fixtures')
THRESHOLD_M = 150
SEARCH_RADIUS_M = 1000
COVERAGE_BBOX = json.loads((root / 'manifest.json').read_text())['coverage_bbox_2180']


def rectangle(west, south, east, north):
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for x, y in [(west, south), (east, south), (east, north), (west, north), (west, south)]:
        ring.AddPoint_2D(x, y)
    polygon = ogr.Geometry(ogr.wkbPolygon)
    polygon.AddGeometry(ring)
    return polygon


coverage = rectangle(*COVERAGE_BBOX)


def fraction(value):
    """Clamp only floating-point endpoint slivers, never a genuine overlap."""
    if not -1e-10 <= value <= 1 + 1e-10:
        raise ValueError(f'Invalid area fraction: {value}')
    return min(1.0, max(0.0, value))


def exact_wkt(geometry):
    """Preserve binary64 coordinates across OGR/PostGIS, including exact boundary contacts."""
    if geometry.GetGeometryType() == ogr.wkbPoint:
        return f'POINT ({geometry.GetX():.17g} {geometry.GetY():.17g})'
    if geometry.GetGeometryType() != ogr.wkbPolygon:
        raise ValueError('Synthetic input must be a polygon or point')
    rings = []
    for index in range(geometry.GetGeometryCount()):
        ring = geometry.GetGeometryRef(index)
        rings.append('(' + ','.join(f'{ring.GetX(point):.17g} {ring.GetY(point):.17g}'
                                   for point in range(ring.GetPointCount())) + ')')
    return 'POLYGON (' + ','.join(rings) + ')'

wgs84, projected = osr.SpatialReference(), osr.SpatialReference()
wgs84.ImportFromEPSG(4326)
projected.ImportFromEPSG(2180)
for crs in (wgs84, projected):
    crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
to_wgs84 = osr.CoordinateTransformation(projected, wgs84)
to_pl = osr.CoordinateTransformation(wgs84, projected)

rows = pq.read_table(root / 'bubd.parquet', columns=['KODKST', 'GEOM']).to_pylist()
houses = [ogr.CreateGeometryFromWkb(row['GEOM']) for row in rows if row['KODKST'] == 110]


obwody = []
obwody_source = ogr.Open(str(root / 'obwody.json'))  # keep the datasource alive while its features are read
for feature in obwody_source.GetLayer(0):
    geometry = feature.GetGeometryRef().Clone()
    obwody.append((str(feature.GetField('hunt_dist_nr')), int(feature.GetField('a_year')), geometry))

protected = []
for kind, name in [('park_narodowy', 'ParkiNarodowe'), ('rezerwat', 'Rezerwaty'), ('park_krajobrazowy', 'ParkiKrajobrazowe'),
                   ('natura_2000_oso', 'ObszarySpecjalnejOchrony'), ('natura_2000_soo', 'SpecjalneObszaryOchrony')]:
    for feature in json.loads((root / 'protected' / f'{name}.json').read_text())['features']:
        # The fixture marks a park's buffer by the name suffix; it has the park's hole cut out.
        buffer = feature['properties']['nazwa'].endswith(' - otulina')
        protected.append(('otulina' if buffer else kind, feature['properties']['kodinspire'], ogr.CreateGeometryFromJson(json.dumps(feature['geometry']))))

stands = []
for line in (root / 'osm' / 'stands.geojsonseq').read_text().splitlines():
    feature = json.loads(line.lstrip('\x1e'))
    point = ogr.CreateGeometryFromJson(json.dumps(feature['geometry']))
    point.Transform(to_pl)
    stands.append((feature['properties'].get('osm_id') or feature.get('id'), point))


def bounds_around(cx, cy, half_w, half_h):
    """WGS84 box, rounded to six decimals like a phone's, whose middle is the given EPSG:2180 point."""
    lon, lat, _ = to_wgs84.TransformPoint(cx, cy)
    d_lat = half_h / 111_320
    d_lon = half_w / (111_320 * math.cos(lat * math.pi / 180))
    return [round(lon - d_lon, 6), round(lat - d_lat, 6), round(lon + d_lon, 6), round(lat + d_lat, 6)]


def area_polygon(bounds):
    west, south, east, north = bounds
    corners = []
    for lon, lat in [(west, south), (east, south), (east, north), (west, north), (west, south)]:
        x, y, _ = to_pl.TransformPoint(lon, lat)
        corners.append((x, y))
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for x, y in corners:
        ring.AddPoint_2D(x, y)
    polygon = ogr.Geometry(ogr.wkbPolygon)
    polygon.AddGeometry(ring)
    return polygon, corners[:4]


def within_share(area, near):
    """Exact share of the area inside the threshold buffer of the dwellings; 32 segments per quarter circle."""
    close = [house for house in near if house.Distance(area) <= THRESHOLD_M]
    if not close:
        return 0.0
    union = close[0].Clone()
    for house in close[1:]:
        union = union.Union(house)
    buffered = union.Buffer(THRESHOLD_M, 32)
    # Difference proves whole coverage without introducing a false <100% from area summation.
    if area.Difference(buffered).IsEmpty():
        return 1.0
    intersection = buffered.Intersection(area)
    if intersection.GetDimension() < 2:
        return 0.0
    return fraction(intersection.GetArea() / area.GetArea())


def measure(bounds, dwellings=houses, districts=obwody, protected_shapes=protected, mapped_stands=stands,
            snapshot_coverage=coverage):
    area, _ = area_polygon(bounds)
    result = {'bounds': bounds, 'full_coverage': area.Difference(snapshot_coverage).IsEmpty()}
    near = [house for house in dwellings if house.Distance(area) <= SEARCH_RADIUS_M]
    if near:
        nearest = min(near, key=lambda house: house.Distance(area))
        minimum = nearest.Distance(area)
        # A boundary-only touch has zero distance but puts no dwelling footprint inside the area.
        intersections = [house.Intersection(area) for house in near]
        contains = any(shape.GetDimension() == 2 and shape.GetArea() > 0 for shape in intersections)
        result['dwelling'] = {
            'min_m': minimum, 'within_threshold_share': within_share(area, near),
            'contains_dwelling': contains,
            'class': 'contains_dwelling' if contains else 'partly_within_threshold' if minimum <= THRESHOLD_M else 'beyond_threshold'
        }
    else:
        result['dwelling'] = {'min_m': None, 'within_threshold_share': 0.0, 'contains_dwelling': False, 'class': 'beyond_threshold'}
    total = area.GetArea()
    district_unions = {}
    for number, year, geometry in districts:
        key = (number, year)
        district_unions[key] = district_unions[key].Union(geometry) if key in district_unions else geometry.Clone()
    result['obwody'] = []
    covered = None
    # An older district keeps land not covered by any newer vintage, as for a point at that land.
    for year in sorted({year for _, year in district_unions}, reverse=True):
        current = [(number, geometry) for (number, source_year), geometry in district_unions.items() if source_year == year]
        for number, geometry in current:
            visible = geometry if covered is None else geometry.Difference(covered)
            intersection = visible.Intersection(area)
            if intersection.GetDimension() == 2 and intersection.GetArea() > 0:
                result['obwody'].append({'number': number, 'source_year': year,
                                         'share': fraction(intersection.GetArea() / total)})
        for _, geometry in current:
            covered = geometry.Clone() if covered is None else covered.Union(geometry)
    result['obwody'].sort(key=lambda item: (item['number'], -item['source_year']))
    result['obwody_outside_share'] = fraction(area.Difference(covered).GetArea() / total) if covered is not None else 1.0
    result['protected'] = []
    for kind, inspire_id, geometry in sorted(protected_shapes, key=lambda item: (item[0], item[1])):
        intersection = geometry.Intersection(area)
        if intersection.GetDimension() < 2 or intersection.GetArea() == 0:
            continue
        whole = area.Difference(geometry).IsEmpty()
        result['protected'].append({
            'kind': kind, 'inspire_id': inspire_id, 'coverage': 'wholly_inside' if whole else 'partly_inside',
            'share': fraction(intersection.GetArea() / total),
            **({'margin_m': area.Distance(geometry.Boundary())} if whole else {})})
    nearest_stand = min(mapped_stands, key=lambda stand: (stand[1].Distance(area), stand[0]))
    centre = area.Centroid()
    result['ambona'] = {'osm_id': nearest_stand[0], 'edge_m': nearest_stand[1].Distance(area),
                        'centre_m': min(stand[1].Distance(centre) for stand in mapped_stands),
                        'centre_nearest_osm_id': min(mapped_stands, key=lambda stand: (stand[1].Distance(centre), stand[0]))[0]}
    return result


def write_real_fixture():
    cases = json.loads(Path('scripts/area-cases.json').read_text())
    result = {'method': f"{gdal.VersionInfo('--version')}; WGS84 box corners to EPSG:2180 with OSR, OGR geometry calls, never application SQL",
              'threshold_m': THRESHOLD_M, 'coverage_bbox_2180': COVERAGE_BBOX, 'cases': {}}
    for name, spec in cases.items():
        bounds = spec['bounds'] if isinstance(spec, dict) else bounds_around(*spec)
        result['cases'][name] = measure(bounds)
        if name == 'dwelling_none_within_radius_covered':
            assert result['cases'][name]['full_coverage']
            assert result['cases'][name]['dwelling']['min_m'] is None
        print(name, json.dumps(result['cases'][name]))
    (root / 'area-acceptance.json').write_text(json.dumps(result, indent=2) + '\n')


def write_synthetic_fixture():
    """Isolated snapshots use an actual 4 km home grid cell for every basis, not a smaller home stand-in."""
    bounds = json.loads(Path('scripts/area-cases.json').read_text())['home_cell_4km_with_park']['bounds']
    area, _ = area_polygon(bounds)
    west, east, south, north = area.GetEnvelope()
    middle_x, middle_y = (west + east) / 2, (south + north) / 2
    broad = rectangle(west - 10000, south - 10000, east + 10000, north + 10000)
    left = rectangle(west - 10000, south - 10000, middle_x, north + 10000)
    right = rectangle(middle_x, south - 10000, east + 10000, north + 10000)
    centre_house = rectangle(middle_x - 100, middle_y - 100, middle_x + 100, middle_y + 100)
    far_house = rectangle(west - 320, south - 1000, west - 300, north + 1000)
    partial_house = rectangle(west - 70, south - 1000, west - 50, north + 1000)
    # The right wall touches the area's westernmost vertex, with no shared interior.
    touching_house = rectangle(west - 20, south - 1000, west, north + 1000)
    equal_house = rectangle(west - 170, south - 1000, west - 150, north + 1000)
    almost_whole_house = rectangle(west - 1000, south - 1000, east - 150.02, north + 1000)
    overlap_a = rectangle(west - 1000, south - 1000, middle_x + 200, north + 1000)
    overlap_b = rectangle(middle_x - 200, south - 1000, east - 500, north + 1000)
    tiny_square = rectangle(middle_x, middle_y, middle_x + 1, middle_y + 1)
    positive_park = ('park_narodowy', 'synthetic.park', area.Buffer(200, 32))
    states = ['neither', 'plan_ochrony', 'zadania_ochronne', 'not_in_crfop_snapshot']
    reserves = [('rezerwat', f'synthetic.{state}', area.Buffer(200, 32)) for state in states]
    contexts = [(kind, f'synthetic.{kind}', area.Buffer(200, 32))
                for kind in ['otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo']]
    specs = {
        'far_single_outside': ([far_house], [('1', 2025, broad)], []),
        'partial_multiple_partial': ([partial_house], [('1', 2025, left), ('2', 2025, right)],
                                     [('park_narodowy', 'synthetic.park', left)]),
        'contains_single_wholly': ([centre_house], [('1', 2025, broad)], [positive_park, reserves[0]]),
        'touch_dwelling': ([touching_house], [('1', 2025, broad)], []),
        'threshold_equal': ([equal_house], [('1', 2025, broad)], []),
        'whole_threshold': ([area], [('1', 2025, broad)], []),
        'near_whole_threshold': ([almost_whole_house], [('1', 2025, broad)], []),
        'overlapping_dwellings': ([overlap_a, overlap_b], [('1', 2025, broad)], []),
        'same_district_overlap': ([centre_house], [('1', 2025, overlap_a), ('1', 2025, overlap_b)], []),
        'tiny_positive_overlaps': ([centre_house], [('1', 2025, tiny_square), ('touch', 2025, touching_house)],
                                   [('park_narodowy', 'synthetic.tiny', tiny_square),
                                    ('rezerwat', 'synthetic.neither', touching_house)]),
        'mixed_year_partition': ([centre_house], [('1', 2024, broad), ('1', 2025, left), ('2', 2026, centre_house)], []),
        'zero_protected_margin': ([centre_house], [('1', 2025, broad)],
                                  [('park_narodowy', 'synthetic.park', area), ('rezerwat', 'synthetic.neither', area)]),
        'protected_documents': ([centre_house], [('1', 2025, broad)], [positive_park, *reserves, *contexts]),
        'incomplete_coverage': ([centre_house], [('1', 2025, broad)], [positive_park]),
    }
    result = {'method': f"{gdal.VersionInfo('--version')}; synthetic EPSG:2180 shapes and independent OGR measurements; no application SQL",
              'threshold_m': THRESHOLD_M, 'cases': {}}
    for name, (dwellings, districts, shapes) in specs.items():
        snapshot_coverage = left.Intersection(area) if name == 'incomplete_coverage' else broad
        mapped_stands = [('synthetic/inside', area.Centroid())]
        expected = measure(bounds, dwellings, districts, shapes, mapped_stands, snapshot_coverage)
        # The independent generator certifies the intended acceptance partitions before any HTTP test.
        if name == 'far_single_outside':
            assert expected['dwelling']['class'] == 'beyond_threshold' and not expected['protected']
        if name == 'partial_multiple_partial':
            assert expected['dwelling']['class'] == 'partly_within_threshold'
            assert len(expected['obwody']) == 2 and expected['protected'][0]['coverage'] == 'partly_inside'
        if name == 'contains_single_wholly':
            assert expected['dwelling']['class'] == 'contains_dwelling'
            assert all(item['coverage'] == 'wholly_inside' and item['margin_m'] > 0 for item in expected['protected'])
        if name == 'touch_dwelling':
            assert expected['dwelling']['min_m'] == 0 and not expected['dwelling']['contains_dwelling']
        if name == 'threshold_equal':
            assert expected['dwelling']['min_m'] == THRESHOLD_M
            assert expected['dwelling']['class'] == 'partly_within_threshold'
        if name == 'near_whole_threshold':
            assert 0.99 < expected['dwelling']['within_threshold_share'] < 1
        if name == 'whole_threshold':
            assert expected['dwelling']['within_threshold_share'] == 1
        if name == 'overlapping_dwellings':
            individual = [within_share(area, [house]) for house in dwellings]
            union_share = expected['dwelling']['within_threshold_share']
            assert max(individual) < union_share < sum(individual)
            expected['individual_dwelling_shares'] = individual
        if name == 'same_district_overlap':
            individual = [shape.Intersection(area).GetArea() / area.GetArea() for _, _, shape in districts]
            assert len(expected['obwody']) == 1
            union_share = expected['obwody'][0]['share']
            assert max(individual) < union_share < min(1, sum(individual))
        if name == 'tiny_positive_overlaps':
            assert len(expected['obwody']) == len(expected['protected']) == 1
            assert 0 < expected['obwody'][0]['share'] < 1e-6
            assert 0 < expected['protected'][0]['share'] < 1e-6
        if name == 'mixed_year_partition':
            assert [(item['number'], item['source_year']) for item in expected['obwody']] == [('1', 2025), ('1', 2024), ('2', 2026)]
            assert all(0 < item['share'] < 1 for item in expected['obwody'])
            assert abs(sum(item['share'] for item in expected['obwody']) - 1) < 1e-10
            assert expected['obwody_outside_share'] == 0
        if name == 'zero_protected_margin':
            assert all(item['coverage'] == 'wholly_inside' and item['margin_m'] == 0 for item in expected['protected'])
        result['cases'][name] = {
            'coverage_wkt': exact_wkt(snapshot_coverage),
            'dwellings_wkt': [exact_wkt(house) for house in dwellings],
            'obwody': [{'number': number, 'source_year': year, 'wkt': exact_wkt(shape)} for number, year, shape in districts],
            'protected': [{'kind': kind, 'inspire_id': inspire_id, 'wkt': exact_wkt(shape),
                           'document_state': inspire_id.removeprefix('synthetic.') if kind == 'rezerwat' else None}
                          for kind, inspire_id, shape in shapes],
            'stands': [{'osm_id': osm_id, 'wkt': exact_wkt(point)} for osm_id, point in mapped_stands],
            'expected': expected,
        }
    (root / 'area-synthetic.json').write_text(json.dumps(result, indent=2) + '\n')


if '--synthetic-only' not in sys.argv:
    write_real_fixture()
write_synthetic_fixture()
