'use strict';

// ─── Platform Configuration ───────────────────────────────────────────────────
//
// Copy this file to config.js and fill in your API credentials.
// config.js is listed in .gitignore — it is never committed to the repository.
//
// In production (GitHub Pages), config.js is generated automatically by the
// CI workflow (.github/workflows/deploy.yml) using GitHub repository secrets.
//
// How to get credentials:
//   Strava:        https://www.strava.com/settings/api
//   TrainingPeaks: https://developer.trainingpeaks.com/ (requires approval)
//
// Set `enabled: true` only after filling in real credentials.
// Buttons for disabled platforms are hidden from users automatically.

const PLATFORMS = {
  strava: {
    enabled:      false,
    clientId:     'YOUR_STRAVA_CLIENT_ID',
    clientSecret: 'YOUR_STRAVA_CLIENT_SECRET',
    authUrl:      'https://www.strava.com/oauth/authorize',
    tokenUrl:     'https://www.strava.com/oauth/token',
    uploadUrl:    'https://www.strava.com/api/v3/uploads',
    scope:        'activity:write,read',
    name:         'Strava',
  },
  trainingpeaks: {
    enabled:      false,
    clientId:     'YOUR_TP_CLIENT_ID',
    clientSecret: 'YOUR_TP_CLIENT_SECRET',
    authUrl:      'https://oauth.trainingpeaks.com/oauth/authorize',
    tokenUrl:     'https://oauth.trainingpeaks.com/oauth/token',
    uploadUrl:    'https://api.trainingpeaks.com/v1/workouts/file',
    scope:        'file:upload',
    name:         'TrainingPeaks',
  },
};
