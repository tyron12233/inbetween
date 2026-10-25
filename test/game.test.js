const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../server/game');

function setup(n = 3, settings = {}) {
  const room = game.createRoom({
    code: 'TEST',
    host: { id: 'p0', secret: 's0', name: 'Host' },
    settings: { ante: 10, minBet: 5, maxBet: 100, postMultiplier: 2, ...settings },
  });
  for (let i = 1; i < n; i++) game.addPlayer(room, { id: `p${i}`, secret: `s${i}`, name: `P${i}` });
  game.startGame(room, 'p0');
  return room;
}

// Force the next cards off the deck: the last element is drawn first.
function stack(room, ...cards) {
  room.deck = [...cards].reverse();
}

function ledgerTotal(room) {
  return room.players.reduce((a, p) => a + p.balance, 0) + room.pot;
}

test('start antes everyone in', () => {
  const room = setup(3);
  assert.equal(room.pot, 30);
  assert.deepEqual(room.players.map((p) => p.balance), [-10, -10, -10]);
  assert.equal(room.turn.playerId, 'p0');
  assert.equal(ledgerTotal(room), 0);
});

test('aces are low', () => {
  assert.equal(game.rankValue('AS'), 1);
  assert.equal(game.rankValue('KD'), 13);
  assert.equal(game.rankValue('10H'), 10);
});

test('judge: between, outside, post', () => {
  assert.equal(game.judge(['3S', '9H'], '5C').outcome, 'win');
  assert.equal(game.judge(['9H', '3S'], '5C').outcome, 'win');
  assert.equal(game.judge(['3S', '9H'], 'KC').outcome, 'lose');
  assert.equal(game.judge(['3S', '9H'], 'AC').outcome, 'lose');
  assert.equal(game.judge(['3S', '9H'], '9D').outcome, 'post');
  assert.equal(game.judge(['AS', 'KH'], 'AD').outcome, 'post');
});

test('judge: pair posts call higher/lower', () => {
  assert.equal(game.judge(['7S', '7H'], '9C', 'higher').outcome, 'win');
  assert.equal(game.judge(['7S', '7H'], '9C', 'lower').outcome, 'lose');
  assert.equal(game.judge(['7S', '7H'], '2C', 'lower').outcome, 'win');
});

test('judge: pair tie is broken by suit ♣ < ♠ < ♥ < ♦', () => {
  // posts 7♠ 7♥: 7♦ is above both, 7♣ below both
  assert.equal(game.judge(['7S', '7H'], '7D', 'higher').outcome, 'win');
  assert.equal(game.judge(['7S', '7H'], '7D', 'lower').outcome, 'lose');
  assert.equal(game.judge(['7S', '7H'], '7C', 'lower').outcome, 'win');
  assert.equal(game.judge(['7S', '7H'], '7C', 'higher').outcome, 'lose');
  // posts 7♣ 7♦: 7♠ / 7♥ sit between them → post hit
  assert.equal(game.judge(['7C', '7D'], '7S', 'higher').outcome, 'post');
  assert.equal(game.judge(['7D', '7C'], '7H', 'lower').outcome, 'post');
});

test('winning a bet takes from the pot', () => {
  const room = setup(3);
  stack(room, '3S', '9H', '5C');
  game.dealPosts(room, 'p0');
  game.placeBet(room, 'p0', { amount: 20 });
  assert.equal(room.players[0].balance, 10);
  assert.equal(room.pot, 10);
  assert.equal(room.turn.playerId, 'p1');
  assert.equal(room.lastHand.outcome, 'win');
  assert.equal(ledgerTotal(room), 0);
});

test('post hit pays the room multiplier', () => {
  const room = setup(3, { postMultiplier: 3 });
  stack(room, '3S', '9H', '9C');
  game.dealPosts(room, 'p0');
  game.placeBet(room, 'p0', { amount: 10 });
  assert.equal(room.players[0].balance, -40);
  assert.equal(room.pot, 60);
  assert.equal(ledgerTotal(room), 0);
});

test('bet limits: host min/max, capped at the pot', () => {
  const room = setup(2, { minBet: 5, maxBet: 50 });
  assert.deepEqual(game.betLimits(room), { min: 5, max: 20 });
  stack(room, '3S', '9H', '5C');
  game.dealPosts(room, 'p0');
  assert.throws(() => game.placeBet(room, 'p0', { amount: 21 }), game.GameError);
  assert.throws(() => game.placeBet(room, 'p0', { amount: 4 }), game.GameError);
  assert.throws(() => game.placeBet(room, 'p0', { amount: 7.5 }), game.GameError);
});

test('pair posts require a call', () => {
  const room = setup(2);
  stack(room, '7S', '7H', '9C');
  game.dealPosts(room, 'p0');
  assert.throws(() => game.placeBet(room, 'p0', { amount: 10 }), /higher or lower/);
  game.placeBet(room, 'p0', { amount: 10, guess: 'higher' });
  assert.equal(room.lastHand.outcome, 'win');
});

test('clearing the pot triggers a re-ante', () => {
  const room = setup(3);
  stack(room, '2S', 'KH', '7C');
  game.dealPosts(room, 'p0');
  game.placeBet(room, 'p0', { amount: 30 });
  assert.equal(room.pot, 30);
  assert.deepEqual(room.players.map((p) => p.balance), [10, -20, -20]);
  assert.equal(ledgerTotal(room), 0);
});

test('pass moves the turn without money', () => {
  const room = setup(3);
  stack(room, '4S', '5H');
  game.dealPosts(room, 'p0');
  game.pass(room, 'p0');
  assert.equal(room.turn.playerId, 'p1');
  assert.equal(room.pot, 30);
});

test('only the current player can act', () => {
  const room = setup(3);
  assert.throws(() => game.dealPosts(room, 'p1'), /not your turn/);
  game.dealPosts(room, 'p0');
  assert.throws(() => game.dealPosts(room, 'p0'), /already dealt/);
});

test('turn order skips players sitting out, sitting in pays the ante', () => {
  const room = setup(3);
  game.setSittingOut(room, 'p1', 'p1', true);
  game.dealPosts(room, 'p0');
  game.pass(room, 'p0');
  assert.equal(room.turn.playerId, 'p2');
  game.setSittingOut(room, 'p1', 'p1', false);
  assert.equal(room.players[1].balance, -20);
  assert.equal(room.pot, 40);
  assert.equal(ledgerTotal(room), 0);
});

test('late joiners sit out until they ante in', () => {
  const room = setup(2);
  game.addPlayer(room, { id: 'late', secret: 'x', name: 'Late' });
  assert.equal(game.getPlayer(room, 'late').sittingOut, true);
  assert.throws(() => game.setSittingOut(room, 'p1', 'late', false), /host/);
  game.setSittingOut(room, 'late', 'late', false);
  assert.equal(game.getPlayer(room, 'late').balance, -10);
});

test('nicknames are unique and editable', () => {
  const room = setup(2);
  assert.throws(() => game.addPlayer(room, { id: 'x', secret: 'x', name: 'host' }), /taken/);
  game.renamePlayer(room, 'p1', 'Bunso');
  assert.equal(room.players[1].name, 'Bunso');
  assert.throws(() => game.renamePlayer(room, 'p0', 'bunso'), /taken/);
});

test('ending refunds the leftover pot and settles up', () => {
  const room = setup(3);
  stack(room, '2S', 'KH', '7C');
  game.dealPosts(room, 'p0');
  game.placeBet(room, 'p0', { amount: 20 }); // p0 +20, pot 10
  game.endGame(room, 'p0');
  // pot of 10 split by contributions (10 each) → 4/3/3 with largest remainder
  const balances = room.players.map((p) => p.balance);
  assert.equal(balances.reduce((a, b) => a + b, 0), 0);
  assert.equal(room.pot, 0);
  const owed = {};
  for (const t of room.settlement.transfers) {
    owed[t.from] = (owed[t.from] || 0) - t.amount;
    owed[t.to] = (owed[t.to] || 0) + t.amount;
  }
  for (const p of room.players) assert.equal(owed[p.id] || 0, p.balance);
});

test('proportional split adds up exactly', () => {
  const parts = game.proportionalSplit(100, { a: 1, b: 1, c: 1 });
  assert.equal(Object.values(parts).reduce((x, y) => x + y, 0), 100);
  assert.deepEqual(game.proportionalSplit(10, {}), {});
});

test('settleUp nets debts with few transfers', () => {
  const t = game.settleUp([
    { id: 'a', balance: 50 },
    { id: 'b', balance: -30 },
    { id: 'c', balance: -20 },
    { id: 'd', balance: 0 },
  ]);
  assert.deepEqual(t, [
    { from: 'b', to: 'a', amount: 30 },
    { from: 'c', to: 'a', amount: 20 },
  ]);
});

test('random play keeps the ledger balanced', () => {
  const room = setup(4, { postMultiplier: 3, minBet: 1, maxBet: 1000 });
  for (let i = 0; i < 2000; i++) {
    const id = room.turn.playerId;
    game.dealPosts(room, id);
    const { min, max } = game.betLimits(room);
    if (Math.random() < 0.2) game.pass(room, id);
    else {
      const amount = min + Math.floor(Math.random() * (max - min + 1));
      game.placeBet(room, id, { amount, guess: Math.random() < 0.5 ? 'higher' : 'lower' });
    }
    assert.equal(ledgerTotal(room), 0);
    assert.ok(room.pot > 0);
  }
  game.endGame(room, 'p0');
  assert.equal(room.players.reduce((a, p) => a + p.balance, 0), 0);
});

test('host-only actions are guarded', () => {
  const room = setup(2);
  assert.throws(() => game.updateSettings(room, 'p1', { ante: 5 }), /host/);
  assert.throws(() => game.endGame(room, 'p1'), /host/);
  assert.throws(() => game.claimHost(room, 'p1', true), /still here/);
  game.claimHost(room, 'p1', false);
  assert.equal(room.hostId, 'p1');
});

test('publicView hides secrets and the deck', () => {
  const room = setup(2);
  const view = game.publicView(room);
  assert.equal(JSON.stringify(view).includes('"secret"'), false);
  assert.equal(view.deck, undefined);
  assert.equal(view.deckCount, 52);
});
