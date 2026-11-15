"""Validate and stage OSM hunting stands as EPSG:2180 points."""
import hashlib
import json

from osgeo import ogr, osr
from psycopg import sql


def stage_ambony(connection, source, manifest, storage):
    with source.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != manifest['extract_sha256']:
            raise ValueError('OSM stand extract hash does not match its manifest')
    wgs84, projected = osr.SpatialReference(), osr.SpatialReference()
    wgs84.ImportFromEPSG(4326)
    projected.ImportFromEPSG(2180)
    wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    projected.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(wgs84, projected)
    connection.execute('CREATE TEMP TABLE incoming_ambona (osm_id text PRIMARY KEY, geom geometry(Point,2180) NOT NULL) ON COMMIT DROP')
    count = 0
    with connection.cursor().copy('COPY incoming_ambona (osm_id, geom) FROM STDIN') as copy:
        for line in source.open():
            feature = json.loads(line.lstrip('\x1e'))
            properties = feature.get('properties', {})
            if properties.get('amenity') != 'hunting_stand' and properties.get('hunting') != 'stand':
                continue
            osm_id = feature.get('id') or feature['properties'].get('@id')
            if not osm_id:
                raise ValueError('OSM stand has no stable identifier')
            geom = ogr.CreateGeometryFromJson(json.dumps(feature['geometry']))
            if geom is None or geom.IsEmpty():
                raise ValueError('OSM stand has invalid geometry')
            if geom.GetGeometryType() != ogr.wkbPoint:
                geom = geom.Centroid()
            geom.Transform(transform)
            copy.write_row((str(osm_id), geom.ExportToWkb().hex()))
            count += 1
    if not count:
        raise ValueError('OSM stand extract contains no hunting stands')
    connection.execute(sql.SQL('INSERT INTO {}.ambona SELECT * FROM incoming_ambona').format(sql.Identifier(storage)))
    return count
