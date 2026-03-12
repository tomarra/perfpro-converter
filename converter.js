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

"use strict";

(function (global) {
  // ─── .3dp Format constants ──────────────────────────────────────────────────

  const HEADER_NAME_OFFSET = 0x10;
  const RECORD_START = 0x110;
  const RECORD_SIZE = 48;
  const WATTS_OFFSET = 4;
  const CADENCE_OFFSET = 38;
  const HR_OFFSET = 46;
  const DIST_KM_OFFSET = 40; // cumulative distance (km) as little-endian float32

  // Bytes 32-35 of each record: little-endian uint32 milliseconds from workout start.
  // This is the authoritative source of timing — do NOT use a fixed sample rate.
  const TIMESTAMP_MS_OFFSET = 32;

  // Maximum plausible gap between consecutive records (~550 ms typical).
  // Rest periods between intervals can legitimately exceed 30 seconds.
  // Corrupt sentinel records at the end of the file typically jump by hundreds of millions
  // of milliseconds, so 5 minutes (300 000 ms) safely rejects them while accepting all
  // real rest periods.
  const MAX_DELTA_MS = 300000;

  // Sensor "default" values written by PerfPro when no real sensor is connected
  const CADENCE_DEFAULT = 90;
  const HR_DEFAULT = 50;

  // Minimum fraction of records with non-default values to count as a real sensor
  const SENSOR_THRESHOLD = 0.05;

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function readNullTermString(bytes, offset, maxLen) {
    const slice = bytes.subarray(offset, offset + maxLen);
    let end = slice.indexOf(0);
    if (end === -1) end = maxLen;
    return new TextDecoder("utf-8").decode(slice.subarray(0, end));
  }

  /** Read a little-endian unsigned 32-bit integer from bytes at offset. */
  function readUint32LE(bytes, offset) {
    return (
      (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
      0
    ); // >>> 0 keeps it unsigned
  }

  /** Read a little-endian IEEE 754 float32 from bytes at offset. */
  function readFloat32LE(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    return view.getFloat32(0, true);
  }

  function isoTimestamp(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function isDataRecord(bytes, offset) {
    // byte[2] and byte[3] are the stable record-type signature (0x01, 0x00).
    // byte[1] carries the high byte of the watts uint16 — it is 0x00 for power < 256 W
    // and 0x01 for power 256–511 W — so it must NOT be used as a fixed signature test.
    return (
      bytes[offset + 2] === 0x01 &&
      bytes[offset + 3] === 0x00
    );
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
      throw new Error("File is too small to be a valid .3dp file.");
    }

    const athleteName =
      readNullTermString(bytes, HEADER_NAME_OFFSET, 64) || "Unknown";
    const totalSlots = Math.floor((bytes.length - RECORD_START) / RECORD_SIZE);

    const wattsBySecond = new Map();
    const cadenceBySecond = new Map();
    const hrBySecond = new Map();
    const distBySecond = new Map(); // cumulative km — keep the latest value per second
    let validCount = 0;
    let realCadence = 0;
    let realHR = 0;
    let maxRawWatts = 0;
    let prevMs = -1;
    let lastValidMs = 0;

    for (let i = 0; i < totalSlots; i++) {
      const offset = RECORD_START + i * RECORD_SIZE;
      if (!isDataRecord(bytes, offset)) continue;

      // Read the embedded millisecond timestamp and reject corrupt sentinel records
      // (the final record(s) in the file often have a wildly out-of-range timestamp).
      const ms = readUint32LE(bytes, offset + TIMESTAMP_MS_OFFSET);
      if (prevMs !== -1 && ms - prevMs > MAX_DELTA_MS) {
        prevMs = ms; // update so subsequent valid records aren't cascaded-away
        continue;
      }
      prevMs = ms;
      lastValidMs = ms;

      validCount++;
      // Watts are stored as a little-endian uint16: byte[4] is the low byte,
      // byte[5] (which mirrors byte[1]) is the high byte, allowing values up to 511 W.
      const watts = bytes[offset + WATTS_OFFSET] | (bytes[offset + WATTS_OFFSET + 1] << 8);
      const cadence = bytes[offset + CADENCE_OFFSET];
      const hr = bytes[offset + HR_OFFSET];
      const distKm = readFloat32LE(bytes, offset + DIST_KM_OFFSET);
      const sec = Math.floor(ms / 1000);

      if (watts > maxRawWatts) maxRawWatts = watts;
      if (cadence !== CADENCE_DEFAULT && cadence !== 0) realCadence++;
      if (hr !== HR_DEFAULT && hr !== 0) realHR++;

      if (!wattsBySecond.has(sec)) wattsBySecond.set(sec, []);
      if (!cadenceBySecond.has(sec)) cadenceBySecond.set(sec, []);
      if (!hrBySecond.has(sec)) hrBySecond.set(sec, []);

      wattsBySecond.get(sec).push(watts);
      cadenceBySecond.get(sec).push(cadence);
      hrBySecond.get(sec).push(hr);
      // Cumulative distance: overwrite with the latest value in this second
      if (distKm > 0) distBySecond.set(sec, distKm);
    }

    if (validCount === 0) {
      throw new Error(
        "No valid data records found — this may not be a .3dp file."
      );
    }

    const hasCadence = realCadence / validCount > SENSOR_THRESHOLD;
    const hasHR = realHR / validCount > SENSOR_THRESHOLD;

    const seconds = Array.from(wattsBySecond.keys()).sort((a, b) => a - b);

    const trackpoints = seconds.map((sec) => {
      const w = avgInt(wattsBySecond.get(sec));
      const c = hasCadence ? avgInt(cadenceBySecond.get(sec)) : null;
      const h = hasHR ? avgInt(hrBySecond.get(sec)) : null;
      const d = distBySecond.has(sec) ? distBySecond.get(sec) * 1000 : null; // km → meters
      return {
        sec,
        watts: w,
        cadence: c !== null && c !== 0 ? c : null,
        hr: h !== null && h !== 0 ? h : null,
        distMeters: d,
      };
    });

    const allWatts = trackpoints.map((t) => t.watts).filter((w) => w > 0);
    const durationSec = Math.floor(lastValidMs / 1000);
    const lastDist = trackpoints.findLast((t) => t.distMeters !== null);
    const totalDistMeters = lastDist ? lastDist.distMeters : 0;

    const stats = {
      durationSec,
      avgWatts: allWatts.length
        ? Math.round(allWatts.reduce((s, v) => s + v, 0) / allWatts.length)
        : 0,
      maxWatts: maxRawWatts,
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

    const tpXml = trackpoints
      .map((tp) => {
        const t = new Date(startTime.getTime() + tp.sec * 1000);

        const hrBlock =
          tp.hr !== null
            ? `            <HeartRateBpm><Value>${tp.hr}</Value></HeartRateBpm>\n`
            : "";
        const distLine =
          tp.distMeters !== null
            ? `            <DistanceMeters>${tp.distMeters.toFixed(
                2
              )}</DistanceMeters>\n`
            : "";
        const cadLine =
          tp.cadence !== null
            ? `              <ns3:RunCadence>${tp.cadence}</ns3:RunCadence>\n`
            : "";

        return `          <Trackpoint>
            <Time>${isoTimestamp(t)}</Time>
${hrBlock}${distLine}            <Extensions>
              <ns3:TPX xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
              <ns3:Watts>${tp.watts}</ns3:Watts>
${cadLine}              </ns3:TPX>
            </Extensions>
          </Trackpoint>`;
      })
      .join("\n");

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
   * PerfPro names files: AthleteName_-_WorkoutName_-_perfpro_-_YYYY-MM-DD-HH-MM-SS.3dp
   *
   * @param  {string} filename
   * @returns {Date|null}  null if no timestamp found
   */
  function extractStartTime(filename) {
    const match = filename.match(
      /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/
    );
    if (match) {
      const [, yr, mo, dy, hh, mm, ss] = match.map(Number);
      return new Date(yr, mo - 1, dy, hh, mm, ss); // local time — PerfPro stamps with wall-clock time
    }
    return null;
  }

  // ─── FIT builder ─────────────────────────────────────────────────────────────

  /**
   * Build a binary .fit file from a parsed workout.
   *
   * @param  {{ trackpoints: Array, stats: object }} workout
   * @param  {Date} startTime
   * @returns {Uint8Array}  binary FIT file contents
   */
  function buildFit(workout, startTime) {
    const { trackpoints, stats } = workout;

    // FIT epoch: Dec 31, 1989 00:00:00 UTC = Unix timestamp 631065600
    const FIT_EPOCH = 631065600;
    function toFitTs(d) { return (Math.floor(d.getTime() / 1000) - FIT_EPOCH) >>> 0; }

    const startTs = toFitTs(startTime);
    const endTs   = toFitTs(new Date(startTime.getTime() + stats.durationSec * 1000));

    // ── CRC-16 (FIT variant) ─────────────────────────────────────────────────
    const CRC_TABLE = [
      0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
      0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
    ];
    function crc16(data, start, end) {
      let c = 0;
      for (let i = start; i < end; i++) {
        const b = data[i];
        let tmp = CRC_TABLE[c & 0xF]; c = (c >>> 4) & 0x0FFF; c ^= tmp ^ CRC_TABLE[b & 0xF];
        tmp      = CRC_TABLE[c & 0xF]; c = (c >>> 4) & 0x0FFF; c ^= tmp ^ CRC_TABLE[(b >>> 4) & 0xF];
      }
      return c;
    }

    // ── Byte buffer ──────────────────────────────────────────────────────────
    const buf = [];
    const u8  = v => buf.push(v & 0xFF);
    const u16 = v => buf.push(v & 0xFF, (v >>> 8) & 0xFF);
    const u32 = v => { v = v >>> 0; buf.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); };

    // FIT base type codes
    const ENUM    = 0x00;
    const UINT8   = 0x02;
    const UINT16  = 0x84;
    const UINT32  = 0x86;
    const UINT32Z = 0x8C;

    // ── Definition message helper ────────────────────────────────────────────
    // fields: [[defNum, byteSize, baseType], ...]
    function def(localType, globalMesg, fields) {
      u8(0x40 | localType);  // definition record header
      u8(0);                 // reserved
      u8(0);                 // architecture: little-endian
      u16(globalMesg);
      u8(fields.length);
      for (const [defNum, size, baseType] of fields) { u8(defNum); u8(size); u8(baseType); }
    }

    // ── file_id  (local 0, global 0) ─────────────────────────────────────────
    def(0, 0, [
      [0, 1, ENUM], [1, 2, UINT16], [2, 2, UINT16], [3, 4, UINT32Z], [4, 4, UINT32],
    ]);
    u8(0);        // local type 0 data header
    u8(4);        // type = activity
    u16(255);     // manufacturer = development
    u16(0);       // product
    u32(0);       // serial_number
    u32(startTs); // time_created

    // ── record  (local 1, global 20) ─────────────────────────────────────────
    // Fields: timestamp, power, distance (scale ×100 → cm), cadence, heart_rate
    def(1, 20, [
      [253, 4, UINT32], [7, 2, UINT16], [5, 4, UINT32], [4, 1, UINT8], [3, 1, UINT8],
    ]);
    for (const tp of trackpoints) {
      u8(1);  // local type 1 data header
      u32(startTs + tp.sec);
      u16(tp.watts);
      u32(tp.distMeters !== null ? Math.round(tp.distMeters * 100) : 0xFFFFFFFF);
      u8(tp.cadence !== null ? tp.cadence : 0xFF);
      u8(tp.hr      !== null ? tp.hr      : 0xFF);
    }

    // ── lap  (local 2, global 19) ────────────────────────────────────────────
    const distRaw = stats.totalDistMeters > 0
      ? (Math.round(stats.totalDistMeters * 100) >>> 0)
      : 0xFFFFFFFF;
    def(2, 19, [
      [254, 2, UINT16], [253, 4, UINT32], [0, 1, ENUM],   [1, 1, ENUM],
      [2,   4, UINT32], [7,   4, UINT32], [8, 4, UINT32], [9, 4, UINT32],
      [20,  2, UINT16], [21,  2, UINT16], [5, 1, ENUM],
    ]);
    u8(2);  // local type 2 data header
    u16(0);                            // message_index
    u32(endTs);                        // timestamp
    u8(9); u8(1);                      // event = lap, event_type = stop
    u32(startTs);                      // start_time
    u32(stats.durationSec * 1000);     // total_elapsed_time (raw = seconds × 1000)
    u32(stats.durationSec * 1000);     // total_timer_time
    u32(distRaw);                      // total_distance (raw = meters × 100)
    u16(stats.avgWatts);               // avg_power
    u16(stats.maxWatts);               // max_power
    u8(2);                             // sport = cycling

    // ── session  (local 3, global 18) ────────────────────────────────────────
    def(3, 18, [
      [254, 2, UINT16], [253, 4, UINT32], [0, 1, ENUM],   [1, 1, ENUM],
      [2,   4, UINT32], [7,   4, UINT32], [8, 4, UINT32], [9, 4, UINT32],
      [20,  2, UINT16], [21,  2, UINT16], [5, 1, ENUM],   [6,  1, ENUM],
      [25,  2, UINT16], [26,  2, UINT16],
    ]);
    u8(3);  // local type 3 data header
    u16(0);                            // message_index
    u32(endTs);                        // timestamp
    u8(8); u8(1);                      // event = session, event_type = stop
    u32(startTs);                      // start_time
    u32(stats.durationSec * 1000);     // total_elapsed_time
    u32(stats.durationSec * 1000);     // total_timer_time
    u32(distRaw);                      // total_distance
    u16(stats.avgWatts);               // avg_power
    u16(stats.maxWatts);               // max_power
    u8(2); u8(0);                      // sport = cycling, sub_sport = generic
    u16(0); u16(1);                    // first_lap_index = 0, num_laps = 1

    // ── activity  (local 4, global 34) ───────────────────────────────────────
    def(4, 34, [
      [253, 4, UINT32], [0, 4, UINT32], [1, 2, UINT16], [2, 1, ENUM], [3, 1, ENUM], [4, 1, ENUM],
    ]);
    u8(4);  // local type 4 data header
    u32(endTs);
    u32(stats.durationSec * 1000);     // total_timer_time
    u16(1);                            // num_sessions
    u8(0); u8(26); u8(1);              // type = manual, event = activity, event_type = stop

    // ── Assemble file ────────────────────────────────────────────────────────
    const data = new Uint8Array(buf);

    // 14-byte file header
    const hdr = new Uint8Array(14);
    const hv  = new DataView(hdr.buffer);
    hdr[0] = 14;    // header size
    hdr[1] = 0x10;  // protocol version 1.0
    hv.setUint16(2, 2132, true);          // profile version 21.32
    hv.setUint32(4, data.length, true);   // data record size (excludes header + file CRC)
    hdr[8] = 0x2E; hdr[9] = 0x46; hdr[10] = 0x49; hdr[11] = 0x54; // ".FIT"
    hv.setUint16(12, crc16(hdr, 0, 12), true); // header CRC (bytes 0–11)

    // Append data CRC
    const dataCrc = crc16(data, 0, data.length);
    const out = new Uint8Array(14 + data.length + 2);
    out.set(hdr, 0);
    out.set(data, 14);
    out[14 + data.length]     = dataCrc & 0xFF;
    out[14 + data.length + 1] = (dataCrc >>> 8) & 0xFF;

    return out;
  }

  // ─── Expose public API ────────────────────────────────────────────────────────

  global.PerfProConverter = { parse3dp, buildTcx, buildFit, extractStartTime };
})(window);
