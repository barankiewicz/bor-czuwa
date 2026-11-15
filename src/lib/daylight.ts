// Solar altitude from UTC time and device position. Civil dawn/dusk is 6° below horizon.
export function isNight(at: Date, lat: number, lon: number): boolean {
  const day = (at.getTime() / 86_400_000) + 2440587.5 - 2451545;
  const meanLongitude = (280.46 + 0.9856474 * day) % 360;
  const anomaly = (357.528 + 0.9856003 * day) * Math.PI / 180;
  const ecliptic = (meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * Math.PI / 180;
  const obliquity = (23.439 - 0.0000004 * day) * Math.PI / 180;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(ecliptic));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(ecliptic), Math.cos(ecliptic));
  const sidereal = (280.16 + 360.9856235 * day + lon) * Math.PI / 180;
  const hourAngle = sidereal - rightAscension;
  const latitude = lat * Math.PI / 180;
  const altitude = Math.asin(Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle));
  return altitude < -6 * Math.PI / 180;
}
