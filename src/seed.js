// Game state <-> compact base64url seed. UTF-8 safe. Transport-independent.
//
// A seed is a self-describing envelope so a decoder can route to the right Game
// module WITHOUT out-of-band knowledge of which game it is:
//
//   { v: 1, game: "<id>", state: State, meta?: {...} }
//
// `game` is redundant with State.game (State carries its own id) but is lifted
// to the envelope top so routing needs no game-specific parsing. `meta` is an
// opaque bag for transport-level extras later (players, move no, signature) —
// the codec neither requires nor interprets it.
(function () {
  const Gage = (window.Gage = window.Gage || {});

  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(seed) {
    const b64 = seed.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // encodeSeed(state, meta?) -> string
  // `state` must carry state.game (every Game module's State does).
  function encodeSeed(state, meta) {
    if (!state || !state.game) {
      throw new Error("[gage] encodeSeed: state is missing a game id");
    }
    const envelope = { v: 1, game: state.game, state };
    if (meta) envelope.meta = meta;
    return b64urlEncode(JSON.stringify(envelope));
  }

  // decodeSeed(seed) -> { v, game, state, meta?, module }
  // `module` is the resolved Game module (window.Gage.games[game]) or null if it
  // isn't registered in this client. Callers decide how to handle a null module.
  function decodeSeed(seed) {
    const env = JSON.parse(b64urlDecode(seed));
    const games = Gage.games || {};
    env.module = games[env.game] || null;
    return env;
  }

  Gage.encodeSeed = encodeSeed;
  Gage.decodeSeed = decodeSeed;
})();
