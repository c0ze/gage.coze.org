// Transport selection. Picks the right platform adapter by hostname and assigns
// window.Gage.threadTransport, so the rest of Gage (content.js, orchestration)
// stays platform-agnostic and just consumes Gage.threadTransport.
//
// Every adapter (x.js, mastodon.js, bluesky.js) is loaded on every matched host
// and registers itself into Gage.transports.<platform> WITHOUT touching the DOM
// at load time. This file — loaded AFTER all adapters and BEFORE
// orchestration.js/content.js — reads location.hostname once and wires up the
// single adapter for the current site.
//
// Defensive by design: if the hostname maps to an adapter that didn't load, we
// fall back to Gage.transports.x (X is the primary target) or null, and we never
// throw at load time — a bad match must not break the page.
(function () {
  const Gage = (window.Gage = window.Gage || {});
  Gage.transports = Gage.transports || {};

  // hostname -> platform id. www./mobile. prefixes are stripped before lookup.
  function platformFor(hostname) {
    const h = String(hostname || "").toLowerCase().replace(/^(www\.|mobile\.)/, "");
    if (h === "x.com" || h === "twitter.com") return "x";
    if (h === "mastodon.social") return "mastodon";
    if (h === "bsky.app") return "bluesky";
    return null;
  }

  let platform = null;
  let adapter = null;
  try {
    platform = platformFor(location.hostname);
    adapter = platform ? Gage.transports[platform] : null;
  } catch (e) {
    platform = null;
    adapter = null;
  }

  // Chosen adapter missing (unmatched host, or its file failed to load) -> fall
  // back to X (the primary target), else null. Never throw.
  if (!adapter) {
    adapter = Gage.transports.x || null;
    if (adapter) platform = "x";
  }

  Gage.threadTransport = adapter;
  Gage.platform = platform;
})();
