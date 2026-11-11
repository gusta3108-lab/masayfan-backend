'use strict';

const PRODUCTION_ORIGINS = new Set([
  'https://masayfantasias.com',
  'https://www.masayfantasias.com'
]);

// Only Vercel deployments for this exact frontend project/team are trusted.
// This includes branch previews such as local-git-feature-...-gusta3108-labs-projects.vercel.app.
const VERCEL_PREVIEW_ORIGIN = /^https:\/\/local(?:-[a-z0-9-]+)?-gusta3108-labs-projects\.vercel\.app$/i;

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  return PRODUCTION_ORIGINS.has(origin) || VERCEL_PREVIEW_ORIGIN.test(origin);
}

module.exports = { isAllowedOrigin };
