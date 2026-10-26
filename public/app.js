/* In-Between client. One state object comes from the server; we re-render on every change. */
(() => {
  const REVEAL_MS = 1400; // flip (0.5s delay + 0.6s) plus a beat before money moves
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');

  // ---------- local identity (no login: a random id + secret kept on this device) ----------
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let identity;
  try { identity = JSON.parse(storage.get('ib:identity')); } catch { identity = null; }
  if (!identity?.playerId || !identity?.secret) {
    identity = { playerId: uuid(), secret: uuid() };
    storage.set('ib:identity', JSON.stringify(identity));
  }

  const params = new URLSearchParams(location.search);
  const ui = {
    name: storage.get('ib:name') || '',
    joinCode: (params.get('room') || '').toUpperCase(),
    // Rejoin automatically if this device already has a seat in the linked room.
    roomCode: !params.get('room') || params.get('room').toUpperCase() === storage.get('ib:room') ? storage.get('ib:room') : null,
    state: null,
    prev: null, // state shown while a hand is being revealed
    revealId: null,
    revealStart: 0,
    seenHandId: null,
    dealKey: null,
    dealAt: 0,
    bet: null,
    modal: null, // 'ledger' | 'settings' | 'me' | {player: id}
    showCreate: false,
    showLog: false,
    busy: false,
    createSettings: { ante: 10, minBet: 10, maxBet: 100, postMultiplier: 2, currency: '₱' },
  };

  const socket = io({ transports: ['websocket', 'polling'] });

  function send(event, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload, (err, res) => {
        if (err) res = { ok: false, error: 'Connection problem, try again' };
        if (!res.ok) toast(res.error);
        resolve(res);
      });
    });
  }

  function joinRoom(code, name) {
    return send('room:join', { code, name, ...identity }).then((res) => {
      if (res.ok) enteredRoom(res.code);
      return res;
    });
  }

  function enteredRoom(code) {
    ui.roomCode = code;
    storage.set('ib:room', code);
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url);
  }

  function leaveRoom() {
    ui.roomCode = null;
    ui.state = null;
    ui.prev = null;
    ui.modal = null;
    storage.del('ib:room');
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    socket.disconnect().connect();
    render();
  }

  socket.on('connect', () => {
    // Coming back after a reload or a dropped connection: slip back into our seat.
    const code = ui.roomCode;
    if (code) {
      send('room:join', { code, name: ui.name, ...identity }).then((res) => {
        if (!res.ok) {
          ui.roomCode = null;
          storage.del('ib:room');
          render();
        }
      });
    }
  });
  socket.on('disconnect', () => render());

  socket.on('state', (state) => {
    const old = ui.state;
    const hand = state.lastHand;
    if (hand && hand.id !== ui.seenHandId) {
      if (ui.seenHandId !== null && old) {
        // A new hand just resolved: animate the flip and hold the old numbers until it lands.
        ui.prev = old;
        ui.revealId = hand.id;
        ui.revealStart = Date.now();
        setTimeout(() => { ui.prev = null; render(); }, REVEAL_MS);
      }
      ui.seenHandId = hand.id;
    }
    if (!hand) ui.seenHandId = 0;
    const posts = state.turn?.posts?.join(',') || '';
    if (posts && posts !== ui.dealKey) { ui.dealKey = posts; ui.dealAt = Date.now(); }
    const wasMyTurn = old && isMyTurn(old);
    ui.state = state;
    playSounds(old, state);
    if (!wasMyTurn && isMyTurn(state) && navigator.vibrate) navigator.vibrate(60);
    if (ui.bet === null || state.turn?.playerId !== old?.turn?.playerId) ui.bet = state.betLimits.min;
    render();
  });

  // Work out what just happened from the change in state, so every phone at the
  // table hears the same thing. Timings line up with the deal and flip animations.
  function playSounds(old, s) {
    if (!old || old.code !== s.code) return;
    const hand = s.lastHand;
    const newHand = hand && hand.id !== old.lastHand?.id;
    const started = old.status !== 'playing' && s.status === 'playing';
    let wait = 0;

    if (started) {
      Sfx.play('shuffle');
      Sfx.play('chips', 900);
      wait = 1400;
    } else if (s.status === 'playing' && s.shuffles > old.shuffles) {
      Sfx.play('shuffle');
      wait = 900;
    }
    if (old.status === 'playing' && s.status === 'ended') Sfx.play('end');

    if (newHand) {
      Sfx.play('bet');
      Sfx.play('flip', 500);
      if (hand.outcome === 'win') {
        // Taking the whole pot gets the big fanfare, then everyone re-antes.
        const cleaned = hand.delta === old.pot;
        Sfx.play(cleaned ? 'jackpot' : 'win', 1100);
        Sfx.play('collect', 1100);
        if (cleaned) Sfx.play('chips', 2000);
      } else {
        Sfx.play(hand.outcome === 'post' ? 'post' : 'lose', 1100);
      }
      wait = REVEAL_MS + 200;
    } else if (old.turn?.phase === 'decide' && s.turn?.playerId !== old.turn.playerId && s.status === 'playing') {
      Sfx.play('pass');
    }

    const posts = s.turn?.phase === 'decide' ? s.turn.posts.join(',') : '';
    if (posts && posts !== (old.turn?.phase === 'decide' ? old.turn.posts.join(',') : '')) {
      Sfx.play('deal-1', wait);
      Sfx.play('deal-2', wait + 120);
    }

    if (!started && s.status === 'playing') {
      for (const p of s.players) {
        const before = old.players.find((x) => x.id === p.id);
        if (before?.sittingOut && !p.sittingOut) Sfx.play('ante');
      }
    }

    if (!isMyTurn(old) && isMyTurn(s) && s.turn.phase === 'deal') Sfx.play('your-turn', wait);
  }

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const me = (s = ui.state) => s?.players.find((p) => p.id === identity.playerId);
  const nameOf = (id, s = ui.state) => s?.players.find((p) => p.id === id)?.name || 'Someone';
  const isHost = (s = ui.state) => s?.hostId === identity.playerId;
  const isMyTurn = (s = ui.state) => s?.status === 'playing' && s.turn?.playerId === identity.playerId;
  const cur = () => ui.state?.settings.currency ?? '';
  const fmt = (n) => `${n < 0 ? '−' : ''}${cur()}${Math.abs(n).toLocaleString()}`;
  const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
  const cardImg = (c) => `/cards/${c}.png`;
  const rankOf = (c) => ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].indexOf(c.slice(0, -1)) + 1;
  const suitSym = (c) => ({ C: '♣', S: '♠', H: '♥', D: '♦' }[c.slice(-1)]);
  const label = (c) => c.slice(0, -1) + suitSym(c);

  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
  }

  // ---------- rendering ----------
  function render() {
    // Keep focus/caret in the bet box across re-renders.
    const focusId = document.activeElement?.id;
    const caret = document.activeElement?.selectionStart;
    $app.innerHTML = ui.roomCode && ui.state ? tableView() : ui.roomCode ? loadingView() : homeView();
    renderModal();
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus();
        try { if (caret != null) el.setSelectionRange(caret, caret); } catch { /* number inputs */ }
      }
    }
  }

  function loadingView() {
    return `<div class="center muted" style="margin-top:40vh">${socket.connected ? 'Joining room…' : 'Connecting…'}</div>`;
  }

  function homeView() {
    const s = ui.createSettings;
    return `
      <section class="hero">
        <div class="hero-cards"><img src="${cardImg('4S')}" alt=""><img src="${cardImg('7H')}" alt=""><img src="${cardImg('JD')}" alt=""></div>
        <h1>In-Between</h1>
        <div class="muted">Deal, bet, and keep the ledger honest.</div>
      </section>
      <div class="panel stack">
        <div>
          <label for="nick">Your nickname</label>
          <input id="nick" maxlength="20" placeholder="e.g. Tito Boy" value="${esc(ui.name)}" autocomplete="nickname">
        </div>
        <div>
          <label for="code">Room code</label>
          <div class="row">
            <input id="code" class="code" maxlength="4" placeholder="ABCD" value="${esc(ui.joinCode)}" autocomplete="off" autocapitalize="characters">
            <button class="primary" data-act="join" style="flex:0 0 96px">Join</button>
          </div>
        </div>
        <div class="divider">or</div>
        ${ui.showCreate ? `
          <h3>New room</h3>
          ${settingsFields(s, 'c')}
          <button class="primary big" data-act="create">Create room</button>
          <button class="ghost" data-act="toggle-create" style="width:100%">Cancel</button>
        ` : `<button class="big" data-act="toggle-create">Create a room</button>`}
      </div>
      <p class="credit">Card art: <a href="https://kerenel.itch.io/pixelart-cards" target="_blank" rel="noopener">FREE Pixel Art Playing Cards</a> by KereneL (CC0)</p>
    `;
  }

  function settingsFields(s, prefix) {
    return `
      <div class="two">
        <div><label for="${prefix}-ante">Ante</label><input id="${prefix}-ante" type="number" inputmode="numeric" min="1" value="${s.ante}"></div>
        <div><label for="${prefix}-cur">Currency</label><input id="${prefix}-cur" maxlength="4" value="${esc(s.currency)}"></div>
        <div><label for="${prefix}-min">Min bet</label><input id="${prefix}-min" type="number" inputmode="numeric" min="1" value="${s.minBet}"></div>
        <div><label for="${prefix}-max">Max bet</label><input id="${prefix}-max" type="number" inputmode="numeric" min="1" value="${s.maxBet}"></div>
        <div class="full">
          <label>Hitting a post pays</label>
          <div class="seg" data-seg="${prefix}-mult">
            ${[1, 2, 3].map((m) => `<button type="button" data-mult="${m}" class="${s.postMultiplier === m ? 'on' : ''}">${m}× bet</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="small muted">Bets are also capped at whatever is in the pot. Aces are low.</div>
    `;
  }

  function readSettings(prefix, base) {
    const v = (id) => document.getElementById(`${prefix}-${id}`)?.value;
    const on = document.querySelector(`[data-seg="${prefix}-mult"] .on`);
    return {
      ante: Number(v('ante')),
      minBet: Number(v('min')),
      maxBet: Number(v('max')),
      currency: v('cur') ?? base.currency,
      postMultiplier: on ? Number(on.dataset.mult) : base.postMultiplier,
    };
  }

  function tableView() {
    const live = ui.state;
    const revealing = !!ui.prev;
    const s = revealing ? ui.prev : live; // numbers shown (held back during a reveal)
    const meNow = me(live);
    return `
      <div class="topbar">
        <button class="code-btn" data-act="share" title="Share room link">${esc(live.code)}</button>
        <span class="spacer"></span>
        ${socket.connected ? '' : '<span class="small neg">offline</span>'}
        <button class="icon" data-act="mute" aria-label="${Sfx.isMuted() ? 'Turn sound on' : 'Mute sound'}">${Sfx.isMuted() ? '🔇' : '🔊'}</button>
        <button class="icon" data-act="modal" data-modal="ledger">Ledger</button>
        ${isHost(live) ? '<button class="icon" data-act="modal" data-modal="settings">Settings</button>' : ''}
        <button class="icon" data-act="modal" data-modal="me">${esc(meNow?.name || 'Me')}</button>
      </div>
      ${!live.players.some((p) => p.id === live.hostId && p.connected) && !isHost(live) ? `
        <div class="banner">The host is offline. <button class="link" data-act="claim">Take over as host</button></div>` : ''}
      <div class="pot">
        <div class="label">Pot</div>
        <div class="amount">${fmt(s.pot)}</div>
        <div class="meta">${live.status === 'playing' ? `${live.deckCount} card${live.deckCount === 1 ? '' : 's'} left · ` : ''}ante ${fmt(live.settings.ante)} · bets ${fmt(live.settings.minBet)}–${fmt(live.settings.maxBet)} · post ${live.settings.postMultiplier}×</div>
      </div>
      ${boardView(live, revealing)}
      <div class="actions">${actionsView(live, revealing)}</div>
      ${live.status === 'playing' ? `<section class="panel" style="margin-bottom:12px">
        <h3>Who pays who</h3>
        <div class="small muted" style="margin-bottom:8px">If you stopped now, counting everyone's share of the pot coming back. Updates after every hand.</div>
        ${payoutView(s)}
      </section>` : ''}
      <section class="panel">
        <h3>Players</h3>
        <ul class="players">${playersView(s, live)}</ul>
      </section>
      <section class="panel" style="margin-top:12px">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0;flex:0 0 auto">Table talk</h3>
          <button class="link" data-act="toggle-log" style="flex:0 0 auto">${ui.showLog ? 'Hide' : 'Show'}</button>
        </div>
        ${ui.showLog ? `<ul class="log" style="margin-top:8px">${live.log.slice().reverse().map((l) => `<li>${esc(l.text)}</li>`).join('')}</ul>`
          : `<div class="small muted" style="margin-top:6px">${esc(live.log[live.log.length - 1]?.text || '')}</div>`}
      </section>
      <p class="credit">Card art by KereneL (CC0) · <button class="link" data-act="leave">Leave room</button></p>
    `;
  }

  function slot(card, extra = '') {
    if (!card) return `<div class="slot empty ${extra}"></div>`;
    return `<div class="slot ${extra}"><img src="${cardImg(card)}" alt="${label(card)}"></div>`;
  }

  function backSlot(extra = '') {
    return `<div class="slot ${extra}"><img src="/cards/back-red.png" alt="face-down card"></div>`;
  }

  function boardView(s, revealing) {
    const turn = s.turn;
    const hand = s.lastHand;
    if (turn?.phase === 'decide' && !revealing) {
      const fresh = Date.now() - ui.dealAt < 500 ? 'deal-in' : '';
      return `<div class="board">${slot(turn.posts[0], fresh)}${backSlot('mid')}${slot(turn.posts[1], `${fresh} second`)}</div>`;
    }
    if (hand && s.status !== 'lobby') {
      const elapsed = revealing && hand.id === ui.revealId ? Date.now() - ui.revealStart : Infinity;
      const flipState = elapsed < REVEAL_MS ? 'go' : 'done';
      const delay = elapsed < REVEAL_MS ? `style="animation-delay:${500 - elapsed}ms"` : '';
      return `<div class="board">
        ${slot(hand.posts[0])}
        <div class="slot mid"><div class="flip ${flipState}"><div class="flip-inner" ${delay}>
          <img class="face back" src="/cards/back-red.png" alt=""><img class="face front" src="${cardImg(hand.third)}" alt="${label(hand.third)}">
        </div></div></div>
        ${slot(hand.posts[1])}
      </div>`;
    }
    return `<div class="board">${slot(null)}${slot(null, 'mid')}${slot(null)}</div>`;
  }

  function resultLine(s, revealing) {
    const hand = s.lastHand;
    if (!hand) return '';
    const elapsed = revealing ? Date.now() - ui.revealStart : Infinity;
    const delay = elapsed < REVEAL_MS ? `style="animation-delay:${1100 - elapsed}ms"` : '';
    const who = hand.playerId === identity.playerId ? 'You' : esc(nameOf(hand.playerId, s));
    const headline = hand.outcome === 'win' ? `${who} won ${fmt(hand.delta)}` : `${who} paid ${fmt(-hand.delta)}`;
    return `<div class="${elapsed < REVEAL_MS ? 'reveal' : ''}" ${delay}>
      <div class="headline ${hand.outcome}">${headline}</div>
      <div class="sub">${esc(hand.reason)}${hand.guess ? ` · called ${hand.guess}` : ''} · bet ${fmt(hand.bet)}</div>
    </div>`;
  }

  function actionsView(s, revealing) {
    const mine = me(s);
    if (revealing) return `<div class="status">${resultLine(s, true)}</div><button class="big" disabled>Revealing…</button>`;

    if (s.status === 'lobby') {
      const n = s.players.length;
      if (isHost(s)) {
        return `<div class="status"><div class="headline">${n} at the table</div><div class="sub">Share the code <b>${esc(s.code)}</b> so everyone can join. Starting antes everyone ${fmt(s.settings.ante)}.</div></div>
          <button class="primary big" data-act="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'Waiting for players…' : 'Start game'}</button>`;
      }
      return `<div class="status"><div class="headline">Waiting for ${esc(nameOf(s.hostId))}</div><div class="sub">The host starts the game. Everyone antes ${fmt(s.settings.ante)}.</div></div>`;
    }

    if (s.status === 'ended') {
      return `<div class="status"><div class="headline">Session over</div><div class="sub">Hand over the cash and you're square.</div></div>
        ${payoutView(s)}
        ${isHost(s) ? '<button class="big" data-act="new" style="margin-top:12px">Start a new session</button>' : ''}`;
    }

    if (mine?.sittingOut) {
      return `<div class="status">${resultLine(s)}</div>
        <button class="primary big" data-act="sit-in">Sit in · ante ${fmt(s.settings.ante)}</button>`;
    }

    const turn = s.turn;
    if (!turn) return `<div class="status"><div class="sub">Nobody is seated.</div></div>`;
    const turnName = esc(nameOf(turn.playerId));

    if (!isMyTurn(s)) {
      const doing = turn.phase === 'deal' ? 'to deal' : 'is deciding';
      const skip = isHost(s) ? `<button class="chip" data-act="skip" style="margin-top:8px">Skip ${turnName}</button>` : '';
      return `<div class="status">${resultLine(s) || ''}<div class="sub" style="margin-top:6px">Waiting for <b>${turnName}</b> ${doing}…</div>${skip}</div>`;
    }

    if (turn.phase === 'deal') {
      return `<div class="status">${resultLine(s)}</div><button class="primary big" data-act="deal">Your turn · Deal</button>`;
    }

    // Deciding: show a bet picker.
    const [a, b] = turn.posts;
    const { min, max } = s.betLimits;
    const bet = Math.min(Math.max(ui.bet ?? min, min), max);
    ui.bet = bet;
    const pair = rankOf(a) === rankOf(b);
    const lo = Math.min(rankOf(a), rankOf(b));
    const hi = Math.max(rankOf(a), rankOf(b));
    let odds;
    if (pair) {
      const higher = ((13 - lo) * 4 / 50) * 100;
      const lower = ((lo - 1) * 4 / 50) * 100;
      odds = `Pair! Higher ≈ ${higher.toFixed(0)}% · Lower ≈ ${lower.toFixed(0)}% · ties go by suit ♣ ♠ ♥ ♦`;
    } else {
      const win = ((hi - lo - 1) * 4 / 50) * 100;
      odds = hi - lo === 1
        ? 'No card fits between these — consider passing'
        : `≈ ${win.toFixed(0)}% to land in between · post hit costs ${s.settings.postMultiplier}× your bet`;
    }
    const half = Math.max(min, Math.floor(max / 2));
    return `
      <div class="odds">${odds}</div>
      <div class="bet-row">
        <button class="step" data-act="bet-step" data-step="-1">−</button>
        <input id="bet" type="number" inputmode="numeric" min="${min}" max="${max}" value="${bet}" aria-label="Bet amount">
        <button class="step" data-act="bet-step" data-step="1">+</button>
      </div>
      <input id="bet-range" type="range" min="${min}" max="${max}" value="${bet}" aria-label="Bet slider">
      <div class="chips">
        <button class="chip" data-act="bet-set" data-val="${min}">Min ${fmt(min)}</button>
        <button class="chip" data-act="bet-set" data-val="${half}">Half</button>
        <button class="chip" data-act="bet-set" data-val="${max}">${max === s.pot ? 'Pot' : 'Max'} ${fmt(max)}</button>
      </div>
      ${pair ? `
        <div class="two">
          <button class="primary big" data-act="bet" data-guess="higher">▲ Higher</button>
          <button class="primary big" data-act="bet" data-guess="lower">▼ Lower</button>
          <button class="full" data-act="pass">Pass</button>
        </div>` : `
        <div class="two">
          <button data-act="pass">Pass</button>
          <button class="primary" data-act="bet">Bet ${fmt(bet)}</button>
        </div>`}
    `;
  }

  function playersView(s, live) {
    return s.players.map((p) => {
      const lp = live.players.find((x) => x.id === p.id) || p;
      const tags = [
        p.id === live.hostId ? '<span class="tag">host</span>' : '',
        p.id === identity.playerId ? '<span class="tag">you</span>' : '',
        lp.sittingOut ? '<span class="tag">sitting out</span>' : '',
      ].join('');
      const cls = [
        live.status === 'playing' && live.turn?.playerId === p.id ? 'turn' : '',
        lp.sittingOut ? 'out' : '',
        isHost(live) && p.id !== identity.playerId ? 'tappable' : '',
      ].join(' ');
      const bal = p.balance;
      return `<li class="${cls}" ${isHost(live) && p.id !== identity.playerId ? `data-act="player" data-id="${p.id}"` : ''}>
        <span class="dot ${lp.connected ? '' : 'off'}" title="${lp.connected ? 'online' : 'offline'}"></span>
        <span class="name">${esc(p.name)}${tags}</span>
        <span class="bal ${bal > 0 ? 'pos' : bal < 0 ? 'neg' : ''}">${signed(bal)}</span>
      </li>`;
    }).join('') || '<li class="muted">Nobody yet</li>';
  }

  // "X pays Y ₱N" lines, with your own lines highlighted and a one-line summary for you.
  function payoutView(s) {
    const st = s.payout;
    if (!st) return '';
    if (!st.transfers.length) return '<div class="center muted">Everyone is even. Nobody owes anything.</div>';
    const mine = identity.playerId;
    const who = (id) => (id === mine ? 'You' : esc(nameOf(id, s)));
    const pays = st.transfers.filter((t) => t.from === mine);
    const gets = st.transfers.filter((t) => t.to === mine);
    let summary = '';
    if (pays.length) summary = `You pay <b>${fmt(pays.reduce((a, t) => a + t.amount, 0))}</b> in total`;
    else if (gets.length) summary = `You collect <b>${fmt(gets.reduce((a, t) => a + t.amount, 0))}</b> in total`;
    else if (me(s)) summary = "You're even — you don't pay or collect";
    return `${summary ? `<div class="you-line">${summary}</div>` : ''}
      <ul class="transfers">${st.transfers.map((t) => `
      <li class="${t.from === mine || t.to === mine ? 'mine' : ''}"><b>${who(t.from)}</b><span class="arrow">${t.from === mine ? 'pay' : 'pays'}</span><b>${t.to === mine ? 'you' : esc(nameOf(t.to, s))}</b><span class="amt">${fmt(t.amount)}</span></li>`).join('')}
    </ul>`;
  }

  // Forms keep what you've typed when someone else's move refreshes the table.
  function renderModal() {
    const existing = document.body.querySelector('.backdrop');
    const key = !ui.modal ? '' : typeof ui.modal === 'string' ? ui.modal : `player:${ui.modal.player}`;
    if (existing && existing.dataset.key === key && (key === 'me' || key === 'settings')) return;
    const same = existing && existing.dataset.key === key;
    existing?.remove();
    if (!ui.state || !ui.modal) return;
    const html = modalView();
    if (!html) return;
    document.body.insertAdjacentHTML('beforeend', html);
    const el = document.body.querySelector('.backdrop');
    el.dataset.key = key;
    if (same) el.classList.add('noanim');
  }

  function modalView() {
    const s = ui.state;
    let title = '';
    let body = '';
    if (ui.modal === 'ledger') {
      title = 'Ledger';
      const sorted = s.players.slice().sort((a, b) => b.balance - a.balance);
      const pending = s.status === 'playing' ? s.pot : 0;
      body = `
        <p class="small muted">Net for this session. Money changes hands in real life — this just keeps score.</p>
        <ul class="players">${sorted.map((p) => `
          <li><span class="name">${esc(p.name)}</span><span class="bal ${p.balance > 0 ? 'pos' : p.balance < 0 ? 'neg' : ''}">${signed(p.balance)}</span></li>`).join('')}
          ${pending ? `<li class="muted"><span class="name">In the pot</span><span class="bal">${fmt(pending)}</span></li>` : ''}
        </ul>
        ${s.payout ? `<h3 style="margin-top:16px">${s.status === 'ended' ? 'Settle up' : 'Who pays who (if you stopped now)'}</h3>${payoutView(s)}` : ''}
        ${s.status === 'playing' ? `<p class="small muted">The leftover pot goes back to whoever paid into it, so this list already includes it.</p>` : ''}
        ${s.status === 'playing' && isHost(s) ? '<button class="danger big" data-act="end">End session &amp; settle up</button>' : ''}
      `;
    } else if (ui.modal === 'settings') {
      title = 'Room settings';
      body = `<div class="stack">${settingsFields(s.settings, 's')}
        <button class="primary big" data-act="save-settings">Save</button></div>`;
    } else if (ui.modal === 'me') {
      const mine = me(s);
      title = 'You';
      body = `<div class="stack">
        <div><label for="rename">Nickname</label><input id="rename" maxlength="20" value="${esc(mine?.name || '')}"></div>
        <button class="primary" data-act="rename" style="width:100%">Save nickname</button>
        ${s.status === 'playing' ? (mine?.sittingOut
          ? `<button data-act="sit-in" style="width:100%">Sit in (ante ${fmt(s.settings.ante)})</button>`
          : '<button data-act="sit-out" style="width:100%">Sit out for a while</button>') : ''}
        <p class="small muted">Your seat is saved on this device. Reopen the link to come back with the same balance.</p>
      </div>`;
    } else if (ui.modal?.player) {
      const p = s.players.find((x) => x.id === ui.modal.player);
      if (!p) { ui.modal = null; return ''; }
      title = esc(p.name);
      body = `<div class="stack">
        <div class="center"><span class="bal ${p.balance > 0 ? 'pos' : p.balance < 0 ? 'neg' : ''}" style="font-size:28px">${signed(p.balance)}</span></div>
        <button data-act="make-host" data-id="${p.id}" style="width:100%">Make host</button>
        ${s.status === 'playing' ? `<button data-act="${p.sittingOut ? 'sit-in-other' : 'sit-out-other'}" data-id="${p.id}" style="width:100%">${p.sittingOut ? `Sit in (charges ${fmt(s.settings.ante)} ante)` : 'Sit them out'}</button>` : ''}
        <button class="danger" data-act="remove" data-id="${p.id}" style="width:100%" ${p.balance !== 0 ? 'disabled' : ''}>Remove from room</button>
        ${p.balance !== 0 ? '<p class="small muted">Players with money on the ledger can be sat out, not removed.</p>' : ''}
      </div>`;
    }
    return `<div class="backdrop" data-act="close-modal"><div class="sheet" role="dialog" aria-label="${title}">
      <div class="sheet-head"><h2>${title}</h2><button class="ghost" data-act="close-modal">Close</button></div>
      ${body}
    </div></div>`;
  }

  // ---------- events ----------
  async function act(el, e) {
    const a = el.dataset.act;
    const s = ui.state;
    switch (a) {
      case 'toggle-create': ui.showCreate = !ui.showCreate; captureHome(); render(); break;
      case 'join': {
        captureHome();
        if (!ui.name.trim()) return toast('Pick a nickname first');
        if (ui.joinCode.length !== 4) return toast('Room codes are 4 letters');
        await joinRoom(ui.joinCode, ui.name);
        render();
        break;
      }
      case 'create': {
        captureHome();
        if (!ui.name.trim()) return toast('Pick a nickname first');
        ui.createSettings = readSettings('c', ui.createSettings);
        const res = await send('room:create', { name: ui.name, settings: ui.createSettings, ...identity });
        if (res.ok) enteredRoom(res.code);
        render();
        break;
      }
      case 'share': {
        const url = `${location.origin}/?room=${s.code}`;
        if (navigator.share) navigator.share({ title: 'Join my In-Between table', url }).catch(() => {});
        else {
          try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
        }
        break;
      }
      case 'modal': ui.modal = el.dataset.modal; render(); break;
      case 'close-modal': if (e.target === el) { ui.modal = null; render(); } break;
      case 'player': ui.modal = { player: el.dataset.id }; render(); break;
      case 'toggle-log': ui.showLog = !ui.showLog; render(); break;
      case 'mute':
        Sfx.setMuted(!Sfx.isMuted());
        if (!Sfx.isMuted()) Sfx.play('bet');
        toast(Sfx.isMuted() ? 'Sound off' : 'Sound on');
        render();
        break;
      case 'start': await send('game:start'); break;
      case 'deal': await send('turn:deal'); break;
      case 'pass': await send('turn:pass'); break;
      case 'skip': if (confirm(`Skip ${nameOf(s.turn.playerId)}'s turn?`)) await send('host:skip'); break;
      case 'bet': {
        if (ui.busy) return;
        ui.busy = true;
        await send('turn:bet', { amount: ui.bet, guess: el.dataset.guess });
        ui.busy = false;
        break;
      }
      case 'bet-step': {
        const step = Math.max(1, s.settings.minBet) * Number(el.dataset.step);
        ui.bet = clampBet((ui.bet || 0) + step);
        render();
        break;
      }
      case 'bet-set': ui.bet = clampBet(Number(el.dataset.val)); render(); break;
      case 'sit-in': ui.modal = null; await send('player:sit', { out: false }); break;
      case 'sit-out': ui.modal = null; await send('player:sit', { out: true }); break;
      case 'sit-in-other': ui.modal = null; await send('player:sit', { out: false, playerId: el.dataset.id }); break;
      case 'sit-out-other': ui.modal = null; await send('player:sit', { out: true, playerId: el.dataset.id }); break;
      case 'make-host':
        if (confirm(`Make ${nameOf(el.dataset.id)} the host?`)) { ui.modal = null; await send('host:transfer', { playerId: el.dataset.id }); }
        break;
      case 'remove':
        if (confirm(`Remove ${nameOf(el.dataset.id)}?`)) { ui.modal = null; await send('player:remove', { playerId: el.dataset.id }); }
        break;
      case 'claim': await send('host:claim'); break;
      case 'rename': {
        const name = document.getElementById('rename').value;
        const res = await send('player:rename', { name });
        if (res.ok) { ui.name = name.trim(); storage.set('ib:name', ui.name); ui.modal = null; toast('Nickname saved'); render(); }
        break;
      }
      case 'save-settings': {
        const res = await send('host:settings', { settings: readSettings('s', s.settings) });
        if (res.ok) { ui.modal = null; toast('Settings saved'); render(); }
        break;
      }
      case 'end':
        if (confirm('End the session and settle up? The leftover pot is returned to the players.')) {
          ui.modal = null;
          await send('game:end');
        }
        break;
      case 'new':
        if (confirm('Start a new session? Everyone goes back to zero.')) await send('game:new');
        break;
      case 'leave':
        if (confirm('Leave this room? Your balance stays on the ledger and you can rejoin with the code.')) leaveRoom();
        break;
      default: break;
    }
  }

  function clampBet(n) {
    const { min, max } = ui.state.betLimits;
    return Math.min(Math.max(Math.round(n) || min, min), max);
  }

  function captureHome() {
    const nick = document.getElementById('nick');
    const code = document.getElementById('code');
    if (nick) { ui.name = nick.value.trim(); storage.set('ib:name', ui.name); }
    if (code) ui.joinCode = code.value.toUpperCase().trim();
    if (document.getElementById('c-ante')) ui.createSettings = readSettings('c', ui.createSettings);
  }

  document.addEventListener('click', (e) => {
    const seg = e.target.closest('.seg button');
    if (seg) {
      seg.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === seg));
      return;
    }
    const el = e.target.closest('[data-act]');
    if (el) act(el, e);
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'bet' || e.target.id === 'bet-range') {
      const n = Number(e.target.value);
      if (!Number.isFinite(n)) return;
      ui.bet = n;
      // Update the paired control and the bet button without a full re-render.
      const other = document.getElementById(e.target.id === 'bet' ? 'bet-range' : 'bet');
      if (other) other.value = n;
      const btn = document.querySelector('[data-act="bet"]:not([data-guess])');
      if (btn) btn.textContent = `Bet ${fmt(n)}`;
    }
    if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'bet') { ui.bet = clampBet(Number(e.target.value)); render(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'code' || e.target.id === 'nick') act(document.querySelector('[data-act="join"]'), e);
    if (e.target.id === 'rename') act(document.querySelector('[data-act="rename"]'), e);
  });

  render();
})();
