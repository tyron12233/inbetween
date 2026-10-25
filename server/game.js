// Pure In-Between game rules. A room is a plain JSON object; every action
// mutates it in place and throws a GameError when the move isn't allowed.

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
// Suit order used to break ties on pair posts: clubs (flower) < spades < hearts < diamonds.
const SUITS = ['C', 'S', 'H', 'D'];
const SUIT_NAMES = { C: 'clubs', S: 'spades', H: 'hearts', D: 'diamonds' };

const DEFAULT_SETTINGS = {
  ante: 10,
  minBet: 10,
  maxBet: 100,
  postMultiplier: 2,
  currency: '₱',
};

const LOG_LIMIT = 60;

class GameError extends Error {}

function fail(msg) {
  throw new GameError(msg);
}

// Aces are always low: A=1 ... K=13.
function rankValue(card) {
  return RANKS.indexOf(card.slice(0, -1)) + 1;
}

function suitValue(card) {
  return SUITS.indexOf(card.slice(-1));
}

function cardLabel(card) {
  const sym = { C: '♣', S: '♠', H: '♥', D: '♦' };
  return card.slice(0, -1) + sym[card.slice(-1)];
}

function freshDeck(random = Math.random) {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function validateSettings(input, base = DEFAULT_SETTINGS) {
  const s = { ...base };
  const intField = (key, min, max) => {
    if (input[key] === undefined) return;
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < min || n > max) fail(`${key} must be a whole number between ${min} and ${max}`);
    s[key] = n;
  };
  intField('ante', 1, 1_000_000);
  intField('minBet', 1, 1_000_000);
  intField('maxBet', 1, 1_000_000);
  intField('postMultiplier', 1, 3);
  if (input.currency !== undefined) {
    const c = String(input.currency).trim().slice(0, 4);
    s.currency = c;
  }
  if (s.minBet > s.maxBet) fail('Minimum bet cannot be more than the maximum bet');
  return s;
}

function cleanName(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!n) fail('Pick a nickname');
  return n;
}

function createRoom({ code, host, settings = {}, now = Date.now() }) {
  const room = {
    code,
    createdAt: now,
    updatedAt: now,
    hostId: host.id,
    settings: validateSettings(settings),
    players: [],
    status: 'lobby', // lobby | playing | ended
    pot: 0,
    potContrib: {},
    deck: [],
    shuffles: 0,
    turn: null, // { playerId, phase: 'deal' | 'decide', posts: [] }
    lastHand: null,
    handNo: 0,
    settlement: null,
    log: [],
  };
  addPlayer(room, host, now);
  return room;
}

function getPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function requirePlayer(room, id) {
  const p = getPlayer(room, id);
  if (!p) fail('You are not in this room');
  return p;
}

function requireHost(room, id) {
  if (room.hostId !== id) fail('Only the host can do that');
}

function log(room, text, now = Date.now()) {
  room.log.push({ t: now, text });
  if (room.log.length > LOG_LIMIT) room.log.splice(0, room.log.length - LOG_LIMIT);
}

function money(room, n) {
  return `${room.settings.currency}${n}`;
}

function assertUniqueName(room, name, exceptId) {
  const taken = room.players.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
  if (taken) fail(`"${name}" is already taken in this room`);
}

function addPlayer(room, { id, secret, name }, now = Date.now()) {
  const clean = cleanName(name);
  assertUniqueName(room, clean);
  const player = {
    id,
    secret,
    name: clean,
    balance: 0,
    // Players who join a game already in progress sit out until they ante in.
    sittingOut: room.status === 'playing',
    joinedAt: now,
  };
  room.players.push(player);
  log(room, `${clean} joined`, now);
  return player;
}

function renamePlayer(room, playerId, name) {
  const p = requirePlayer(room, playerId);
  const clean = cleanName(name);
  if (clean === p.name) return;
  assertUniqueName(room, clean, playerId);
  log(room, `${p.name} is now ${clean}`);
  p.name = clean;
}

function activePlayers(room) {
  return room.players.filter((p) => !p.sittingOut);
}

function chargeAnte(room, player) {
  const a = room.settings.ante;
  player.balance -= a;
  room.pot += a;
  room.potContrib[player.id] = (room.potContrib[player.id] || 0) + a;
}

function anteAll(room) {
  const active = activePlayers(room);
  for (const p of active) chargeAnte(room, p);
  log(room, `Everyone antes ${money(room, room.settings.ante)} — pot is ${money(room, room.pot)}`);
}

function startGame(room, byId) {
  requireHost(room, byId);
  if (room.status === 'playing') fail('The game is already running');
  if (room.status === 'ended') fail('Start a new session first');
  for (const p of room.players) p.sittingOut = false;
  if (activePlayers(room).length < 2) fail('Need at least 2 players to start');
  room.status = 'playing';
  room.pot = 0;
  room.potContrib = {};
  room.deck = freshDeck();
  room.shuffles = 1;
  anteAll(room);
  room.turn = { playerId: activePlayers(room)[0].id, phase: 'deal', posts: [] };
}

function nextActiveAfter(room, playerId) {
  const n = room.players.length;
  const start = room.players.findIndex((p) => p.id === playerId);
  for (let k = 1; k <= n; k++) {
    const p = room.players[(start + k + n) % n];
    if (!p.sittingOut) return p;
  }
  return null;
}

function advanceTurn(room) {
  const current = room.turn ? room.turn.playerId : room.players[room.players.length - 1]?.id;
  const next = nextActiveAfter(room, current);
  room.turn = next ? { playerId: next.id, phase: 'deal', posts: [] } : null;
}

function draw(room) {
  if (room.deck.length === 0) {
    room.deck = freshDeck();
    room.shuffles += 1;
    log(room, 'Deck reshuffled');
  }
  return room.deck.pop();
}

function requireTurn(room, playerId, phase) {
  if (room.status !== 'playing') fail('The game is not running');
  if (!room.turn || room.turn.playerId !== playerId) fail("It's not your turn");
  if (room.turn.phase !== phase) fail(phase === 'deal' ? 'Cards are already dealt' : 'Deal your cards first');
}

function dealPosts(room, playerId) {
  requireTurn(room, playerId, 'deal');
  // Make sure a full hand (two posts + third card) comes from one deck.
  if (room.deck.length < 3) {
    room.deck = freshDeck();
    room.shuffles += 1;
    log(room, 'Deck reshuffled');
  }
  room.turn.posts = [draw(room), draw(room)];
  room.turn.phase = 'decide';
}

function isPair(posts) {
  return rankValue(posts[0]) === rankValue(posts[1]);
}

function betLimits(room) {
  const max = Math.min(room.settings.maxBet, room.pot);
  const min = Math.min(room.settings.minBet, max);
  return { min, max };
}

// Decide how a hand plays out. Returns { outcome: 'win' | 'lose' | 'post', reason }.
function judge(posts, third, guess) {
  const t = rankValue(third);
  if (!isPair(posts)) {
    const lo = Math.min(rankValue(posts[0]), rankValue(posts[1]));
    const hi = Math.max(rankValue(posts[0]), rankValue(posts[1]));
    if (t === lo || t === hi) return { outcome: 'post', reason: 'Hit the post' };
    if (t > lo && t < hi) return { outcome: 'win', reason: 'In between' };
    return { outcome: 'lose', reason: 'Outside the posts' };
  }
  const r = rankValue(posts[0]);
  let dir;
  if (t > r) dir = 'higher';
  else if (t < r) dir = 'lower';
  else {
    // Same rank as the pair: the suit decides (♣ < ♠ < ♥ < ♦).
    const s = suitValue(third);
    const s1 = suitValue(posts[0]);
    const s2 = suitValue(posts[1]);
    if (s > Math.max(s1, s2)) dir = 'higher';
    else if (s < Math.min(s1, s2)) dir = 'lower';
    else return { outcome: 'post', reason: `Same rank, ${SUIT_NAMES[third.slice(-1)]} sits between the posts` };
    const why = `Same rank, ${SUIT_NAMES[third.slice(-1)]} is ${dir}`;
    return dir === guess ? { outcome: 'win', reason: why } : { outcome: 'lose', reason: why };
  }
  return dir === guess
    ? { outcome: 'win', reason: `Called ${guess}` }
    : { outcome: 'lose', reason: `It was ${dir}` };
}

function placeBet(room, playerId, { amount, guess }) {
  requireTurn(room, playerId, 'decide');
  const player = requirePlayer(room, playerId);
  const posts = room.turn.posts;
  const pair = isPair(posts);
  if (pair && guess !== 'higher' && guess !== 'lower') fail('Call higher or lower');
  const bet = Number(amount);
  const { min, max } = betLimits(room);
  if (max < 1) fail('The pot is empty');
  if (!Number.isInteger(bet) || bet < min || bet > max) fail(`Bet between ${money(room, min)} and ${money(room, max)}`);

  const third = draw(room);
  const { outcome, reason } = judge(posts, third, pair ? guess : undefined);
  let delta;
  if (outcome === 'win') {
    delta = bet;
    room.pot -= bet;
  } else {
    const loss = outcome === 'post' ? bet * room.settings.postMultiplier : bet;
    delta = -loss;
    room.pot += loss;
    room.potContrib[playerId] = (room.potContrib[playerId] || 0) + loss;
  }
  player.balance += delta;
  room.handNo += 1;
  room.lastHand = {
    id: room.handNo,
    playerId,
    posts,
    third,
    bet,
    guess: pair ? guess : null,
    outcome,
    reason,
    delta,
  };
  const call = pair ? ` (${guess})` : '';
  const verb = delta >= 0 ? `wins ${money(room, delta)}` : `pays ${money(room, -delta)}`;
  log(room, `${player.name} bet ${money(room, bet)}${call} on ${cardLabel(posts[0])} ${cardLabel(posts[1])}, drew ${cardLabel(third)} — ${reason.toLowerCase()}, ${verb}`);

  if (room.pot === 0) {
    log(room, `${player.name} cleaned out the pot!`);
    room.potContrib = {};
    anteAll(room);
  }
  advanceTurn(room);
}

function pass(room, playerId, byHost = false) {
  if (byHost) {
    if (room.status !== 'playing' || !room.turn) fail('Nobody to skip');
    playerId = room.turn.playerId;
  } else {
    requireTurn(room, playerId, 'decide');
  }
  const p = getPlayer(room, playerId);
  const what = room.turn.posts.length ? ` on ${room.turn.posts.map(cardLabel).join(' ')}` : '';
  log(room, byHost ? `Host skipped ${p.name}` : `${p.name} passed${what}`);
  advanceTurn(room);
}

function setSittingOut(room, byId, targetId, out) {
  const target = requirePlayer(room, targetId);
  if (byId !== targetId) requireHost(room, byId);
  if (target.sittingOut === out) return;
  if (out) {
    target.sittingOut = true;
    log(room, `${target.name} is sitting out`);
    if (room.turn && room.turn.playerId === targetId) advanceTurn(room);
    return;
  }
  target.sittingOut = false;
  if (room.status === 'playing') {
    chargeAnte(room, target);
    log(room, `${target.name} sat in and anted ${money(room, room.settings.ante)}`);
    if (!room.turn) advanceTurn(room);
  } else {
    log(room, `${target.name} is back`);
  }
}

function removePlayer(room, byId, targetId) {
  requireHost(room, byId);
  if (targetId === room.hostId) fail('Hand off host before removing yourself');
  const target = requirePlayer(room, targetId);
  if (target.balance !== 0 || room.potContrib[targetId]) {
    fail(`${target.name} has money on the ledger — sit them out instead`);
  }
  if (room.turn && room.turn.playerId === targetId) advanceTurn(room);
  room.players = room.players.filter((p) => p.id !== targetId);
  log(room, `${target.name} was removed`);
}

function updateSettings(room, byId, input) {
  requireHost(room, byId);
  room.settings = validateSettings(input, room.settings);
  const s = room.settings;
  log(room, `Settings: ante ${money(room, s.ante)}, bets ${money(room, s.minBet)}–${money(room, s.maxBet)}, post hit ${s.postMultiplier}x`);
}

function transferHost(room, byId, targetId) {
  requireHost(room, byId);
  const target = requirePlayer(room, targetId);
  room.hostId = target.id;
  log(room, `${target.name} is now the host`);
}

function claimHost(room, byId, hostConnected) {
  const p = requirePlayer(room, byId);
  if (hostConnected) fail('The host is still here');
  room.hostId = p.id;
  log(room, `${p.name} took over as host`);
}

// Split `total` across ids in proportion to weights, using the largest-remainder
// method so the parts are whole numbers that add up exactly to `total`.
function proportionalSplit(total, weights) {
  const ids = Object.keys(weights).filter((id) => weights[id] > 0);
  const sum = ids.reduce((a, id) => a + weights[id], 0);
  if (!ids.length || sum === 0) return {};
  const parts = ids.map((id) => {
    const exact = (total * weights[id]) / sum;
    return { id, base: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = total - parts.reduce((a, p) => a + p.base, 0);
  parts.sort((a, b) => b.rem - a.rem);
  for (const p of parts) {
    if (left <= 0) break;
    p.base += 1;
    left -= 1;
  }
  return Object.fromEntries(parts.map((p) => [p.id, p.base]));
}

// Fewest-ish transfers: repeatedly match the biggest debtor with the biggest creditor.
function settleUp(players) {
  const debtors = players.filter((p) => p.balance < 0).map((p) => ({ id: p.id, amt: -p.balance }));
  const creditors = players.filter((p) => p.balance > 0).map((p) => ({ id: p.id, amt: p.balance }));
  const transfers = [];
  while (debtors.length && creditors.length) {
    debtors.sort((a, b) => b.amt - a.amt);
    creditors.sort((a, b) => b.amt - a.amt);
    const d = debtors[0];
    const c = creditors[0];
    const amt = Math.min(d.amt, c.amt);
    transfers.push({ from: d.id, to: c.id, amount: amt });
    d.amt -= amt;
    c.amt -= amt;
    if (d.amt === 0) debtors.shift();
    if (c.amt === 0) creditors.shift();
  }
  return transfers;
}

function endGame(room, byId) {
  requireHost(room, byId);
  if (room.status !== 'playing') fail('The game is not running');
  // Whatever is left in the pot goes back to the people who paid into it.
  const refunds = proportionalSplit(room.pot, room.potContrib);
  for (const [id, amt] of Object.entries(refunds)) {
    const p = getPlayer(room, id);
    if (p) p.balance += amt;
  }
  if (room.pot > 0) log(room, `Leftover pot of ${money(room, room.pot)} returned to the players who paid in`);
  room.pot = 0;
  room.potContrib = {};
  room.status = 'ended';
  room.turn = null;
  room.settlement = {
    refunds,
    balances: Object.fromEntries(room.players.map((p) => [p.id, p.balance])),
    transfers: settleUp(room.players),
  };
  log(room, 'Session ended — time to settle up');
}

function newSession(room, byId) {
  requireHost(room, byId);
  if (room.status === 'playing') fail('End the current session first');
  for (const p of room.players) {
    p.balance = 0;
    p.sittingOut = false;
  }
  room.status = 'lobby';
  room.pot = 0;
  room.potContrib = {};
  room.turn = null;
  room.lastHand = null;
  room.settlement = null;
  room.deck = [];
  log(room, 'New session — balances reset to zero');
}

// What everyone in the room is allowed to see: no secrets, no deck order.
function publicView(room, connectedIds = new Set()) {
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    status: room.status,
    pot: room.pot,
    deckCount: room.deck.length,
    shuffles: room.shuffles,
    turn: room.turn,
    lastHand: room.lastHand,
    betLimits: betLimits(room),
    settlement: room.settlement,
    log: room.log.slice(-30),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      balance: p.balance,
      sittingOut: p.sittingOut,
      connected: connectedIds.has(p.id),
    })),
  };
}

module.exports = {
  RANKS,
  SUITS,
  DEFAULT_SETTINGS,
  GameError,
  rankValue,
  suitValue,
  freshDeck,
  validateSettings,
  createRoom,
  getPlayer,
  addPlayer,
  renamePlayer,
  startGame,
  dealPosts,
  placeBet,
  pass,
  judge,
  isPair,
  betLimits,
  setSittingOut,
  removePlayer,
  updateSettings,
  transferHost,
  claimHost,
  proportionalSplit,
  settleUp,
  endGame,
  newSession,
  publicView,
};
