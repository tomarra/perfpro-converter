# PerfPro `.3dp` Binary Format

This document describes the binary layout of `.3dp` files produced by PerfPro / Computrainer software. It is entirely **reverse-engineered** from inspection of real workout files — there is no official public specification.

---

## File Layout

| Offset | Size | Contents |
|---|---|---|
| `0x00–0x03` | 4 bytes | File version / magic (`5e 00 02 00` observed) |
| `0x04–0x07` | 4 bytes | ASCII `perf` — format identifier |
| `0x08–0x0F` | 8 bytes | Unknown header fields |
| `0x10–0x4F` | 64 bytes | Athlete name, null-terminated UTF-8 |
| `0x50–0x10F` | 192 bytes | Workout metadata (settings, totals — not fully decoded) |
| `0x110–EOF` | variable | Data records (48 bytes each), then a plaintext footer |

---

## Data Records

Records begin at file offset `0x110`. Each is exactly **48 bytes**.

A record is a valid data record if bytes 1–3 equal `0x00 0x01 0x00`. Records that fail this check are part of the footer and are skipped.

### 48-byte Record Layout

| Byte(s) | Field | Type | Notes |
|---|---|---|---|
| 0 | Segment marker | `uint8` | `0x83` = lap 1, `0x84` = lap 2, etc. — not fully decoded |
| 1–3 | Record signature | 3 bytes | Always `0x00 0x01 0x00` for data records |
| 4 | Power | `uint8` | Watts, range 0–255 |
| 5–31 | Unknown | — | Reserved / not decoded |
| **32–35** | **Timestamp** | `uint32 LE` | **Milliseconds from workout start** — authoritative timing source |
| 36–37 | Unknown | — | |
| 38 | Cadence | `uint8` | RPM; `90` = PerfPro default when no sensor connected |
| 39 | Cadence (duplicate) | `uint8` | Same value as byte 38 |
| 40–45 | Unknown | — | |
| 46 | Heart rate | `uint8` | BPM; `50` = PerfPro default when no HR monitor connected |
| 47 | Heart rate (duplicate) | `uint8` | Same value as byte 46 |

---

## Timing

The timestamp at bytes 32–35 is a **little-endian unsigned 32-bit integer representing milliseconds from workout start**. This is the authoritative source for trackpoint timing.

Observed characteristics:
- First record is typically timestamped at ~423 ms (PerfPro starts logging slightly before t=0)
- Typical inter-record interval: ~550–566 ms (~1.8 Hz)
- The final record(s) in the file are corrupt sentinels whose timestamp jumps by ~1.1 billion ms; these are identified and skipped by checking that each record's delta from the previous is ≤ 5,000 ms

> **Note:** An earlier version of the Node.js conversion script used a hardcoded calibration constant of `6249 / 1805 ≈ 3.46 Hz`, which was approximately 2× too fast and caused all workout durations to be reported at half their actual length. Reading the embedded timestamp directly eliminates this class of error entirely.

---

## Sensor Detection

PerfPro writes fixed sentinel values to cadence and heart rate fields when no real sensor is connected:

| Field | No-sensor default |
|---|---|
| Cadence | `90` rpm |
| Heart rate | `50` bpm |

The parser counts how many records contain a non-default, non-zero value for each field. If more than **5%** of records qualify, the sensor is considered real and the field is included in output. This threshold tolerates occasional glitch records without producing false positives.

---

## Footer

After the data records, the file ends with a plaintext block that describes the workout structure — interval names, power targets, segment labels (e.g. `"Solid 94% just under FTP|2 of 5"`), and a `PAUSE` marker. These bytes do not conform to the 48-byte record structure and are ignored by the parser.

---

## Example: Reading a Record (JavaScript)

```js
const RECORD_START = 0x110;
const RECORD_SIZE  = 48;

function isDataRecord(bytes, offset) {
  return bytes[offset + 1] === 0x00 &&
         bytes[offset + 2] === 0x01 &&
         bytes[offset + 3] === 0x00;
}

function readUint32LE(bytes, offset) {
  return (bytes[offset] | bytes[offset+1]<<8 | bytes[offset+2]<<16 | bytes[offset+3]<<24) >>> 0;
}

const bytes = new Uint8Array(arrayBuffer);
const slots = Math.floor((bytes.length - RECORD_START) / RECORD_SIZE);

for (let i = 0; i < slots; i++) {
  const off = RECORD_START + i * RECORD_SIZE;
  if (!isDataRecord(bytes, off)) continue;

  const ms      = readUint32LE(bytes, off + 32); // timestamp
  const watts   = bytes[off + 4];
  const cadence = bytes[off + 38];
  const hr      = bytes[off + 46];
}
```
