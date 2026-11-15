FROM docker.io/library/python:3.12-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin libgdal-dev osmium-tool \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/requirements.txt scripts/requirements-hashes.txt /app/
# GDAL is the one unhashed input: it must match the libgdal-dev installed above. Exactly one
# unconditional pin is required (a marker would make pip skip it), and it must import.
RUN pip install --no-cache-dir --require-hashes -r /app/requirements-hashes.txt \
    && [ "$(grep -c '^GDAL' /app/requirements.txt)" = 1 ] \
    && grep -qE '^GDAL==[0-9][0-9.]*$' /app/requirements.txt \
    && grep '^GDAL==' /app/requirements.txt | pip install --no-cache-dir -r /dev/stdin \
    && python -c 'from osgeo import gdal'
WORKDIR /app
COPY scripts/ scripts/
COPY data/ data/
CMD ["python", "scripts/ingest-bubd.py", "data/fixtures/bubd.parquet", "data/fixtures/manifest.json", "data/fixtures/obwody.json", "data/fixtures/obwody-manifest.json", "data/fixtures/protected/manifest.json", "data/fixtures/recipients/manifest.json", "data/fixtures/osm/stands.geojsonseq", "data/fixtures/osm/manifest.json"]
