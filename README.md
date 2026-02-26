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

## Project Files

```
perfpro-converter/
├── index.html          Page structure and markup
├── converter.js        .3dp parser and TCX builder
├── app.js              UI logic, chart, and file download
├── styles.css          Dark-theme stylesheet
└── docs/
    ├── 3dp-format.md       Reverse-engineered .3dp binary format spec
    └── development-notes.md  Bugs found, fixes applied, and technical decisions
```
