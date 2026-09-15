require("dotenv").config();

// Render sets RENDER=true on every service, so a forgotten NODE_ENV there
// still gets the production checks.
const isProduction =
  process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);

// Forgives the usual dashboard typos: a missing scheme and a trailing slash
// (which would otherwise produce "site.app//join/...").
function normalize(raw) {
  const value = (raw || "").trim().replace(/\/+$/, "");
  if (!value || /^https?:\/\//i.test(value)) return value;
  const scheme = /^(localhost|127\.0\.0\.1)(:|\/|$)/.test(value) ? "http" : "https";
  return `${scheme}://${value}`;
}

// In production a missing or localhost URL is a deploy mistake that silently
// hands users dead links, so refuse to boot instead of falling back.
function baseUrl(name, devDefault) {
  const value = normalize(process.env[name]);
  const isLocal = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(value);

  if (isProduction && (!value || isLocal)) {
    console.error(
      `${name} must be a public URL in production (got "${value || "nothing"}") — refusing to start.`,
    );
    process.exit(1);
  }
  return value || devDefault;
}

module.exports = {
  isProduction,
  APP_BASE_URL: baseUrl("APP_BASE_URL", "http://localhost:4000"),
  FRONTEND_BASE_URL: baseUrl("FRONTEND_BASE_URL", "http://localhost:5173"),
};
