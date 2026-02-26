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
The final record in the file passes the data-record signature check (`bytes 1–3 = 0x00 0x01 0x00`) but carries a corrupt timestamp — a jump of ~1.1 billion ms (~13 days) from the previous record. This is caught by rejecting any record whose timestamp delta exceeds 5,000 ms:

```js
if (prevMs !== -1 && (ms - prevMs) > MAX_DELTA_MS) continue;
```

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

## Design Decisions

### No server, no dependencies
All parsing and conversion runs in the browser using `FileReader`, `Uint8Array`, `TextDecoder`, and `URL.createObjectURL`. No npm packages, no bundler, no build step. The site works opened directly from the filesystem as a `file://` URL.

### Timestamps over sample-rate calibration
Rather than rely on any assumed hardware sample rate (which proved incorrect), the parser reads the per-record millisecond timestamp embedded in the binary data. This is more accurate, hardware-independent, and immune to the 2× calibration error that affected the original script.

### One trackpoint per second
The ~1.8 Hz raw sample rate produces roughly 1–2 records per second. Records within the same second are averaged together into a single trackpoint. This matches the resolution expected by TCX consumers (TrainingPeaks, Strava, etc.) and keeps output file sizes reasonable.

### Sensor detection threshold
Rather than trust the cadence and heart rate values unconditionally, the parser checks what fraction of records differ from PerfPro's known "no sensor" defaults (90 rpm cadence, 50 bpm heart rate). Only if more than 5% of records show non-default values is the sensor considered real. This prevents PerfPro's simulator defaults from being written into the TCX as fake data.
