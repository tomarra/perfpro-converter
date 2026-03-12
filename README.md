# PerfPro Converter

Convert your **PerfPro / Computrainer `.3dp` workout files** into formats you can upload to TrainingPeaks, Strava, and Garmin Connect — right in your browser, with no installs and no uploads.

---

## How It Works

1. Open `index.html` in any modern browser
2. Drag & drop your `.3dp` file (or click **Browse File**)
3. Confirm the detected workout date & time
4. Click **Convert**
5. Review your power chart and stats, then click **Download TCX**

Your file never leaves your machine.

---

## What You Get

- **TCX file** ready to import into TrainingPeaks, Strava, Garmin Connect, Final Surge, and more
- **Power data** for every second of your ride
- **Cadence and heart rate** included automatically when a real sensor was connected
- **Power chart** showing your output over the full workout, with average power marked
- **Workout summary** — duration, avg power, max power, trackpoint count

---

## Supported Platforms

| Platform | Import path |
|---|---|
| TrainingPeaks | Home → Upload File |
| Strava | strava.com/upload/select |
| Garmin Connect | Activities → Import Data |
| Final Surge | Athlete Dashboard → Upload Workout |
| Garmin Training Center | File → Import → Import File |

---

## No Setup Required

- No server, no npm, no build step
- Open `index.html` directly from your filesystem or any static host
- Works in Chrome, Firefox, Safari, and Edge

---

## Running the Tests

The unit tests use Node's built-in test runner — no extra packages needed.

**Requirements:** Node.js 18 or later

```bash
npm test
```

The test suite parses each fixture file, converts it to both TCX and FIT, and asserts that duration, average power, max power, and distance are consistent across all three. It prints a side-by-side validation table as it runs.

### Test fixtures

Real `.3dp` workout files live in `tests/fixtures/`. To add a new fixture, copy a `.3dp` file there and add an entry to the `FIXTURES` array in `tests/converter.test.js`.

---

## Project Files

```
perfpro-converter/
├── index.html          Page structure and markup
├── converter.js        .3dp parser, TCX builder, and FIT builder
├── app.js              UI logic, chart, and file download
├── styles.css          Dark-theme stylesheet
├── tests/
│   ├── converter.test.js   Unit tests (node --test)
│   └── fixtures/           Sample .3dp files used by the tests
└── docs/
    ├── 3dp-format.md       Reverse-engineered .3dp binary format spec
    └── development-notes.md  Bugs found, fixes applied, and technical decisions
```
