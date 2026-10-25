// Keeps rooms in memory and mirrors them to a JSON file so a restart
// doesn't wipe the ledger.
const fs = require('fs');
const path = require('path');

const ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1000;

class Store {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'rooms.json') : null;
    this.rooms = new Map();
    this.timer = null;
    if (this.file) this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const cutoff = Date.now() - ROOM_TTL_MS;
      for (const room of data.rooms || []) {
        if (room.updatedAt >= cutoff) this.rooms.set(room.code, room);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Could not read saved rooms:', err.message);
    }
  }

  get(code) {
    return this.rooms.get(code);
  }

  set(room) {
    this.rooms.set(room.code, room);
    this.save();
  }

  touch(room) {
    room.updatedAt = Date.now();
    this.save();
  }

  // Debounced so a burst of actions becomes a single write.
  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 300);
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ rooms: [...this.rooms.values()] }));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
