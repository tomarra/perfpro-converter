# Development Notes

Bugs found and fixed, plus technical decisions made during the build of PerfPro Converter.

---

## Bug 1 — Workout duration reported at half actual length

### Symptom
A 57-minute workout was displayed as 29 minutes 53 seconds.

### Root cause
The original Node.js conversion script used a hardcoded calibration constant derived from a single reference file:

```js
const SAMPLES_PER_SECOND = 6249 / 1805; // ≈ 3.46 Hz
```

This was approximately **2× too fast**. The actual sample interval is ~550 ms (~1.8 Hz), not ~289 ms. Because duration was computed by multiplying a record index by `1 / 3.46`, every workout was reported at roughly half its true length.

### Discovery
Binary inspection of a known 57-minute workout file revealed that bytes 32–35 of each 48-byte data record contain a **little-endian `uint32` millisecond timestamp from workout start**. Sampling the first two valid records showed:

- Record 0: `423 ms`
- Record 1: `977 ms`
- Delta: `+554 ms`

Extrapolating across all 6,210 valid records: `6210 × 554 ms ≈ 3,440 seconds = 57m 20s` — matching the expected duration exactly.

### Fix
The calibration constant was removed entirely. Each record's time offset is now read directly from the embedded timestamp:

```js
const ms  = readUint32LE(bytes, offset + 32);
const sec = Math.floor(ms / 1000);
```

Total duration is taken from the last valid record's timestamp:

```js
const durationSec = Math.floor(lastValidMs / 1000);
```

### Sentinel record filtering
The final record in the file passes the data-record signature check (`bytes[2] = 0x01, bytes[3] = 0x00`) but carries a corrupt timestamp — a jump of ~1.1 billion ms (~13 days) from the previous record. This is caught by rejecting any record whose timestamp delta exceeds `MAX_DELTA_MS`:

```js
if (prevMs !== -1 && (ms - prevMs) > MAX_DELTA_MS) {
  prevMs = ms;
  continue;
}
```

See Bug 4 for the discovery that the original `MAX_DELTA_MS = 5000` and the original `isDataRecord` signature were both incorrect.

---

## Bug 2 — Browse File button opened the file picker but selecting a file had no effect

### Symptom
Drag-and-drop worked correctly. Clicking **Browse File**, selecting a `.3dp` file, and confirming the selection produced no visible output — the options panel never appeared.

### Root cause
Two separate mechanisms were both attempting to open the file input on the same click:

1. The original markup used `<label for="fileInput">`, which activates the file input when clicked.
2. A `click` listener on the parent drop zone also called `fileInput.click()`.

The `.btn` CSS class sets `pointer-events: auto`, which overrides the `pointer-events: none` on `.drop-zone__content`. This meant the label *did* receive the pointer event. Both triggers fired in the same tick, causing the browser to cancel the dialog before any file could be selected.

### Fix
The `<label for="fileInput">` was replaced with a `<button>`. A dedicated click handler calls `e.stopPropagation()` before opening the file picker, preventing the event from reaching the drop-zone handler:

```js
browseBtn.addEventListener('click', e => {
  e.stopPropagation(); // prevent drop zone from also calling fileInput.click()
  fileInput.click();
});
```

The drop-zone click handler is retained so that clicking anywhere else on the drop zone background still opens the picker.

---

## Bug 3 — Start time displayed 6 hours behind actual workout time

### Symptom
A file with `2026-02-25-17-33-40` in the filename was pre-filled in the date/time picker as `11:33 AM` instead of `5:33 PM`.

### Root cause
`extractStartTime` constructed the date using `Date.UTC()`:

```js
return new Date(Date.UTC(yr, mo - 1, dy, hh, mm, ss));
```

This treated the filename timestamp as a UTC instant. The UI then called `date.getHours()` to populate the picker, which converts to local time — subtracting the user's UTC-6 offset and producing `11:33`.

### Fix
PerfPro generates filenames using the **local wall-clock time** of the machine running the software. The date is now constructed without `UTC`, which places it directly in the user's local timezone:

```js
return new Date(yr, mo - 1, dy, hh, mm, ss); // local time — PerfPro stamps with wall-clock time
```

---

## Bug 4 — Interval workout duration truncated to first rest gap

### Symptom
A 59-minute interval workout was reported as ~18 minutes. The file contained 12 structured efforts separated by ~30-second rest periods.

### Root cause
Two separate problems compounded each other:

**1. `MAX_DELTA_MS` too small for rest periods.**
The sentinel filter rejected any record whose timestamp delta exceeded `MAX_DELTA_MS = 5000` (5 seconds). Interval workouts have legitimate ~30-second gaps between efforts, all of which exceeded this threshold and were silently discarded.

**2. Cascade from stale `prevMs`.**
When a record was skipped, `prevMs` was not updated. Every subsequent record was then compared against the stale `prevMs` value from before the gap, so its delta was even larger — causing every remaining record in the workout to be skipped as well. Only the ~18 minutes before the first rest gap survived.

### Fix
`MAX_DELTA_MS` was raised to 300,000 ms (5 minutes) — well above any plausible rest interval but well below the ~1.1 billion ms sentinel jump. `prevMs` is now updated even when a record is skipped, preventing the cascade:

```js
const MAX_DELTA_MS = 300000; // 5 minutes — accommodates rest gaps in interval workouts

// ...inside the parse loop:
if (prevMs !== -1 && ms - prevMs > MAX_DELTA_MS) {
  prevMs = ms; // advance anchor so subsequent valid records aren't cascaded away
  continue;
}
```

After the fix: 1 sentinel record rejected, all 12 rest gaps preserved, duration reported as 59.3 minutes.

---

## Bug 5 — Power values capped at 255 W and peak power understated

### Symptom
A workout with a known max power of 316 W and average power of 159 W was reported as 251 W max and 146 W average.

### Root cause
Three separate issues, all in the power-reading path:

**1. `isDataRecord` rejected high-power records.**
The original record-type check required `bytes[offset+1] === 0x00`:

```js
return (
  bytes[offset + 1] === 0x00 &&   // ← incorrect
  bytes[offset + 2] === 0x01 &&
  bytes[offset + 3] === 0x00
);
```

Byte 1 is not a fixed signature byte — it is the **high byte of the watts `uint16`**. For power ≥ 256 W, byte 1 equals `0x01`. This caused all 657 high-power records (those with watts > 255) to be silently excluded from parsing.

**2. Watts read as `uint8`, capping at 255 W.**
Even for the records that did pass the signature check, watts were read from a single byte:

```js
const watts = bytes[offset + WATTS_OFFSET]; // uint8, max 255
```

The correct encoding is a little-endian `uint16` across bytes 4–5:

```js
const watts = bytes[offset + 4] | (bytes[offset + 5] << 8); // uint16 LE
```

**3. Max power computed from per-second averages.**
`maxWatts` was derived from the averaged trackpoints rather than the raw samples. In a second that contained both a 316 W and a 298 W sample, the trackpoint value was 307 W — hiding the true peak entirely.

### Fix

`isDataRecord` now checks only the two stable signature bytes:

```js
function isDataRecord(bytes, offset) {
  // bytes[2] and bytes[3] are the stable record-type signature.
  // bytes[1] is the high byte of the watts uint16 — must NOT be used as a fixed check.
  return (
    bytes[offset + 2] === 0x01 &&
    bytes[offset + 3] === 0x00
  );
}
```

Watts are read as `uint16 LE`, and a separate `maxRawWatts` variable is updated from every raw sample before averaging:

```js
const watts = bytes[offset + 4] | (bytes[offset + 5] << 8);
if (watts > maxRawWatts) maxRawWatts = watts;
```

The final stats object uses `maxRawWatts` rather than the per-second maximum:

```js
maxWatts: maxRawWatts,
```

After all three fixes: avg = 159 W, max = 316 W.

---

## Design Decisions

### No server, no dependencies
All parsing and conversion runs in the browser using `FileReader`, `Uint8Array`, `TextDecoder`, and `URL.createObjectURL`. No npm packages, no bundler, no build step. The site works opened directly from the filesystem as a `file://` URL.

### Timestamps over sample-rate calibration
Rather than rely on any assumed hardware sample rate (which proved incorrect), the parser reads the per-record millisecond timestamp embedded in the binary data. This is more accurate, hardware-independent, and immune to the 2× calibration error that affected the original script.

### One trackpoint per second
The ~1.8 Hz raw sample rate produces roughly 1–2 records per second. Records within the same second are averaged together into a single trackpoint. This matches the resolution expected by TCX consumers (TrainingPeaks, Strava, etc.) and keeps output file sizes reasonable.

### Sensor detection threshold
Rather than trust the cadence and heart rate values unconditionally, the parser checks what fraction of records differ from PerfPro's known "no sensor" defaults (90 rpm cadence, 50 bpm heart rate). Only if more than 5% of records show non-default values is the sensor considered real. This prevents PerfPro's simulator defaults from being written into the TCX as fake data.
