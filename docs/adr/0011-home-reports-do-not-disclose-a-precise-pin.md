# Home reports do not disclose a precise pin

The phone may know where the Reporter lives when they use the local Mój dom preset. A Report made
from that preset sends an Incident area, not the exact home fix, for every Event type. It records
both how the area was estimated and that the precise fix was withheld to protect the Reporter. The
home fix remains on the phone. This is an exception to the earlier full-precision storage rule in
ADR-0006: exact home coordinates would improve distance measurements, but would also expose the
Reporter through the archive and a later public map. Findings and Notices must describe the area
and its uncertainty rather than present its centre as a measured point.

## Addendum: whole-area Findings, 8 November 2026

Findings measure every Incident area as a whole, never its centre. This applies to home cells,
estimates by ear or sight, and Reporter-selected areas. Dwelling Findings store the minimum
distance to a residential footprint, the fraction of the whole area within the Rule set's
threshold of any residential footprint, and whether the area contains a dwelling. Overlapping
footprint buffers count once. The owner approved this closest-distance/share contract in place
of the earlier minimum/maximum proposal; no maximum distance is claimed. The buffer is a planar
EPSG:2180 approximation with 32 segments per quarter circle, not an exact circular boundary.

Obwody list their area shares. Protected areas record whole or partial overlap. ADR-0007 permits
a ban statement only when the whole Incident area lies inside with a positive boundary margin,
and only for its two statutory cases. Ambona distance runs from the area's edge, zero inside.

District vintages apply at each covered location, not once for the entire Incident area.
A newer adjacent district cannot erase older coverage elsewhere. Each stored fragment retains
its actual source year; same-number/year features are unioned before their share is measured.
Every positive interior overlap counts, however small; a boundary-only contact does not.

Spatial Findings require the snapshot to cover the whole Incident area. Partial coverage uses
the existing `outside_coverage` result instead of asserting measurements or absence for unknown
territory. Time Findings do not change. Point Findings and Notices remain unchanged. Immutable
Rule sets retain their ids and bytes: the legacy `distance_measured_from: reported_point` field
describes point measurements; an area result explicitly declares `basis: area`.

Migration 013 identifies the new JSON shape. Older local `incident_area` results remain readable;
existing Reports are not backfilled. Only an eligible, authorized private-demo update may reseed
the fictional demo. No exact home fix leaves the device.
