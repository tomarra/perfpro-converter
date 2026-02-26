/**
 * converter.js
 *
 * Browser-compatible port of the PerfPro .3dp parser and TCX builder.
 * Runs entirely client-side — no server or npm packages required.
 *
 * Exports (on window):
 *   PerfProConverter.parse3dp(arrayBuffer)  → workout object
 *   PerfProConverter.buildTcx(workout, startTime)  → TCX string
 *   PerfProConverter.extractStartTime(filename)  → Date
 */

'use strict';

(function (global) {

  // ─── .3dp Format constants ──────────────────────────────────────────────────

  const HEADER_NAME_OFFSET = 0x10;
  const RECORD_START       = 0x110;
  const RECORD_SIZE        = 48;
  const WATTS_OFFSET       = 4;
  const CADENCE_OFFSET     = 38;
  const HR_OFFSET          = 46;
  const DIST_KM_OFFSET     = 40;  // cumulative distance (km) as little-endian float32

  // Bytes 32-35 of each record: little-endian uint32 milliseconds from workout start.
  // This is the authoritative source of timing — do NOT use a fixed sample rate.
  const TIMESTAMP_MS_OFFSET = 32;

  // Maximum plausible gap between consecutive records (~550 ms typical).
  // Records whose timestamp jumps beyond this are corrupt sentinels and are skipped.
  const MAX_DELTA_MS = 5000;

  // Sensor "default" values written by PerfPro when no real sensor is connected
  const CADENCE_DEFAULT    = 90;
  const HR_DEFAULT         = 50;

  // Minimum fraction of records with non-default values to count as a real sensor
  const SENSOR_THRESHOLD   = 0.05;

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function readNullTermString(bytes, offset, maxLen) {
    const slice = bytes.subarray(offset, offset + maxLen);
    let end = slice.indexOf(0);
    if (end === -1) end = maxLen;
    return new TextDecoder('utf-8').decode(slice.subarray(0, end));
  }

  /** Read a little-endian unsigned 32-bit integer from bytes at offset. */
  function readUint32LE(bytes, offset) {
    return (bytes[offset]       |
            bytes[offset + 1] << 8  |
            bytes[offset + 2] << 16 |
            bytes[offset + 3] << 24) >>> 0; // >>> 0 keeps it unsigned
  }

  /** Read a little-endian IEEE 754 float32 from bytes at offset. */
  function readFloat32LE(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    return view.getFloat32(0, true);
  }

  function isoTimestamp(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function isDataRecord(bytes, offset) {
    return bytes[offset + 1] === 0x00 &&
           bytes[offset + 2] === 0x01 &&
           bytes[offset + 3] === 0x00;
  }

  function avgInt(arr) {
    return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
  }

  // ─── Core parser ─────────────────────────────────────────────────────────────

  /**
   * Parse a .3dp ArrayBuffer and return a structured workout.
   *
   * @param  {ArrayBuffer} arrayBuffer
   * @returns {{
   *   athleteName: string,
   *   trackpoints: Array<{sec:number, watts:number, cadence:number|null, hr:number|null, distMeters:number|null}>,
   *   stats: { durationSec, avgWatts, maxWatts, hasCadence, hasHR, recordCount, totalDistMeters }
   * }}
   */
  function parse3dp(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.length < RECORD_START + RECORD_SIZE) {
      throw new Error('File is too small to be a valid .3dp file.');
    }

    const athleteName = readNullTermString(bytes, HEADER_NAME_OFFSET, 64) || 'Unknown';
    const totalSlots  = Math.floor((bytes.length - RECORD_START) / RECORD_SIZE);

    const wattsBySecond   = new Map();
    const cadenceBySecond = new Map();
    const hrBySecond      = new Map();
    const distBySecond    = new Map(); // cumulative km — keep the latest value per second
    let validCount  = 0;
    let realCadence = 0;
    let realHR      = 0;
    let prevMs      = -1;
    let lastValidMs = 0;

    for (let i = 0; i < totalSlots; i++) {
      const offset = RECORD_START + i * RECORD_SIZE;
      if (!isDataRecord(bytes, offset)) continue;

      // Read the embedded millisecond timestamp and reject corrupt sentinel records
      // (the final record(s) in the file often have a wildly out-of-range timestamp).
      const ms = readUint32LE(bytes, offset + TIMESTAMP_MS_OFFSET);
      if (prevMs !== -1 && (ms - prevMs) > MAX_DELTA_MS) continue;
      prevMs = ms;
      lastValidMs = ms;

      validCount++;
      const watts   = bytes[offset + WATTS_OFFSET];
      const cadence = bytes[offset + CADENCE_OFFSET];
      const hr      = bytes[offset + HR_OFFSET];
      const distKm  = readFloat32LE(bytes, offset + DIST_KM_OFFSET);
      const sec     = Math.floor(ms / 1000);

      if (cadence !== CADENCE_DEFAULT && cadence !== 0) realCadence++;
      if (hr !== HR_DEFAULT && hr !== 0) realHR++;

      if (!wattsBySecond.has(sec))   wattsBySecond.set(sec,   []);
      if (!cadenceBySecond.has(sec)) cadenceBySecond.set(sec, []);
      if (!hrBySecond.has(sec))      hrBySecond.set(sec,      []);

      wattsBySecond.get(sec).push(watts);
      cadenceBySecond.get(sec).push(cadence);
      hrBySecond.get(sec).push(hr);
      // Cumulative distance: overwrite with the latest value in this second
      if (distKm > 0) distBySecond.set(sec, distKm);
    }

    if (validCount === 0) {
      throw new Error('No valid data records found — this may not be a .3dp file.');
    }

    const hasCadence = (realCadence / validCount) > SENSOR_THRESHOLD;
    const hasHR      = (realHR      / validCount) > SENSOR_THRESHOLD;

    const seconds = Array.from(wattsBySecond.keys()).sort((a, b) => a - b);

    const trackpoints = seconds.map(sec => {
      const w = avgInt(wattsBySecond.get(sec));
      const c = hasCadence ? avgInt(cadenceBySecond.get(sec)) : null;
      const h = hasHR      ? avgInt(hrBySecond.get(sec))      : null;
      const d = distBySecond.has(sec) ? distBySecond.get(sec) * 1000 : null; // km → meters
      return {
        sec,
        watts:      w,
        cadence:    (c !== null && c !== 0) ? c : null,
        hr:         (h !== null && h !== 0) ? h : null,
        distMeters: d,
      };
    });

    const allWatts    = trackpoints.map(t => t.watts).filter(w => w > 0);
    const durationSec = Math.floor(lastValidMs / 1000);
    const lastDist    = trackpoints.findLast(t => t.distMeters !== null);
    const totalDistMeters = lastDist ? lastDist.distMeters : 0;

    const stats = {
      durationSec,
      avgWatts:    allWatts.length ? Math.round(allWatts.reduce((s, v) => s + v, 0) / allWatts.length) : 0,
      maxWatts:    allWatts.length ? Math.max(...allWatts) : 0,
      hasCadence,
      hasHR,
      recordCount: validCount,
      totalDistMeters,
    };

    return { athleteName, trackpoints, stats };
  }

  // ─── TCX builder ─────────────────────────────────────────────────────────────

  function buildTcx(workout, startTime) {
    const { trackpoints, stats } = workout;

    const tpXml = trackpoints.map(tp => {
      const t = new Date(startTime.getTime() + tp.sec * 1000);

      const hrBlock  = tp.hr !== null
        ? `            <HeartRateBpm><Value>${tp.hr}</Value></HeartRateBpm>\n` : '';
      const distLine = tp.distMeters !== null
        ? `            <DistanceMeters>${tp.distMeters.toFixed(2)}</DistanceMeters>\n` : '';
      const cadLine  = tp.cadence !== null
        ? `              <ns3:RunCadence>${tp.cadence}</ns3:RunCadence>\n` : '';

      return `          <Trackpoint>
            <Time>${isoTimestamp(t)}</Time>
${hrBlock}${distLine}            <Extensions>
              <ns3:TPX xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
              <ns3:Watts>${tp.watts}</ns3:Watts>
${cadLine}              </ns3:TPX>
            </Extensions>
          </Trackpoint>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase
  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2
    http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Activities>
    <Activity Sport="Biking">
      <Id>${isoTimestamp(startTime)}</Id>
      <Lap StartTime="${isoTimestamp(startTime)}">
        <TotalTimeSeconds>${stats.durationSec}</TotalTimeSeconds>
        <DistanceMeters>${stats.totalDistMeters.toFixed(2)}</DistanceMeters>
        <Calories>0</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${tpXml}
        </Track>
        <Extensions>
          <ns3:LX xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
            <ns3:AvgWatts>${stats.avgWatts}</ns3:AvgWatts>
            <ns3:MaxWatts>${stats.maxWatts}</ns3:MaxWatts>
          </ns3:LX>
        </Extensions>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
  }

  // ─── Start-time extraction from filename ──────────────────────────────────────

  /**
   * Extract the workout start time from the filename.
   * PerfPro names files: AthlName_-_WorkoutName_-_perfpro_-_YYYY-MM-DD-HH-MM-SS.3dp
   *
   * @param  {string} filename
   * @returns {Date|null}  null if no timestamp found
   */
  function extractStartTime(filename) {
    const match = filename.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
    if (match) {
      const [, yr, mo, dy, hh, mm, ss] = match.map(Number);
      return new Date(yr, mo - 1, dy, hh, mm, ss); // local time — PerfPro stamps with wall-clock time
    }
    return null;
  }

  // ─── Expose public API ────────────────────────────────────────────────────────

  global.PerfProConverter = { parse3dp, buildTcx, extractStartTime };

}(window));
