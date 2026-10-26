/* Tiny Web Audio sound player. Browsers only allow audio after the first tap,
   so the context is created and the sounds are loaded on the first interaction. */
window.Sfx = (() => {
  const NAMES = [
    'deal-1', 'deal-2', 'flip', 'pass', 'bet', 'ante', 'collect', 'chips', 'shuffle',
    'win', 'lose', 'post', 'jackpot', 'your-turn', 'end',
  ];
  const VOLUME = { win: 0.6, lose: 0.6, post: 0.6, jackpot: 0.7, 'your-turn': 0.5, end: 0.6 };
  const buffers = {};
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('ib:muted') === '1'; } catch { /* private mode */ }

  function unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) {
      ctx = new AC();
      for (const name of NAMES) {
        fetch(`/sounds/${name}.mp3`)
          .then((r) => r.arrayBuffer())
          .then((data) => new Promise((ok, err) => ctx.decodeAudioData(data, ok, err)))
          .then((buf) => { buffers[name] = buf; })
          .catch(() => { /* a missing sound just stays silent */ });
      }
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function play(name, delayMs = 0) {
    if (muted || !ctx || !buffers[name] || document.hidden) return;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = VOLUME[name] ?? 0.9;
    src.buffer = buffers[name];
    src.connect(gain).connect(ctx.destination);
    src.start(ctx.currentTime + delayMs / 1000);
  }

  function setMuted(v) {
    muted = v;
    try { localStorage.setItem('ib:muted', v ? '1' : '0'); } catch { /* private mode */ }
  }

  for (const ev of ['pointerdown', 'keydown', 'touchend']) {
    document.addEventListener(ev, unlock, { capture: true, passive: true });
  }

  return { play, unlock, setMuted, isMuted: () => muted };
})();
