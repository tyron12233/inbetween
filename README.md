# In-Between

A multiplayer In-Between (Acey-Deucey) table for your phones. Everyone joins with a 4-letter room code and a nickname, with no accounts and no login. The app deals the cards and keeps a running ledger. Real cash changes hands at the end, guided by a settle-up list.

## How a game works

1. One person creates a room and becomes the **host**. They set the ante, min/max bet, the post-hit multiplier and the currency symbol.
2. Everyone else opens the shared link (or types the code) and picks a nickname.
3. The host taps **Start game**. Everyone antes into the pot.
4. On your turn, tap **Deal** to see your two posts, then bet or pass.
   - **Third card lands between the posts**: you win your bet from the pot.
   - **Outside the posts**: your bet goes into the pot.
   - **Hits a post** (same rank as a post): you pay your bet × the room's post multiplier (1×, 2× or 3×).
   - **Pair posts**: call **Higher** or **Lower** instead. If the third card is the same rank as the pair, the suit decides, in the order ♣ clubs (flower) < ♠ spades < ♥ hearts < ♦ diamonds. Above both posts' suits counts as higher, below both counts as lower, and between them counts as a post hit.
   - Aces are always low.
   - Bets must fall within the host's min/max and can never exceed the pot.
5. When someone empties the pot, everyone re-antes automatically.
6. A **Who pays who** panel on the table shows, after every hand, exactly who would pay whom and how much if you stopped now. Your own line is highlighted, with a summary like "You pay ₱130 in total".
7. The host taps **Ledger → End session & settle up** to lock it in. Whatever is left in the pot goes back to the players in proportion to what they put in. The app then lists who pays whom, using as few transfers as possible.

### Other things you can do

- **Change your nickname** any time (tap your name, top right).
- **Sit out** for a while. Sitting back in during a game costs one ante. People who join mid-game sit out until they ante in.
- The host can **skip** an AFK player, sit people out, change settings, hand off host, or remove people with a zero balance.
- If the host drops off, anyone can **take over as host**.
- **Sound effects** for dealing, flips, bets, wins, losses and post hits. Tap 🔊 to mute (remembered per phone). On iPhone, the ring/silent switch also silences them.
- Your seat is remembered on your device. Reloading or reopening the link puts you back with the same balance.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # rules + ledger tests
```

**Playing at home on the same Wi-Fi:** run `npm start` on a laptop. Everyone then opens `http://<laptop-ip>:3000` on their phone.

Rooms are saved to `data/rooms.json` (set `DATA_DIR` to move it), so restarting the server doesn't lose the ledger. Rooms idle for 14 days are dropped.

## Deploy

- **Render (free):** create a new Blueprint from this repo and it picks up `render.yaml`. The free tier sleeps after ~15 min idle, so the first visit takes a minute to wake it. It also has no persistent disk, so a redeploy or restart clears rooms. End and settle a session before redeploying.
- **Anywhere with Docker:** `docker build -t inbetween . && docker run -p 3000:3000 -v inbetween-data:/data inbetween`. On Fly.io, Railway and similar hosts, mount a volume at `/data` to keep rooms across restarts.

## Code map

- `server/game.js` holds all game rules and ledger maths as pure functions (unit-tested in `test/game.test.js`).
- `server/index.js` is the Express + Socket.IO server. Every action is validated server-side, then the new state is broadcast to the room.
- `server/store.js` keeps rooms in memory and saves them to a JSON file.
- `public/` is the mobile web client (plain HTML/CSS/JS, no build step).

## Credits

Card art: [FREE Pixel Art Playing Cards](https://kerenel.itch.io/pixelart-cards) by KereneL, CC0. See `public/cards/LICENSE.txt`.

Sound effects: [Casino Audio](https://kenney.nl/assets/casino-audio) and [Music Jingles](https://kenney.nl/assets/music-jingles) by Kenney, CC0. See `public/sounds/LICENSE.txt`.
