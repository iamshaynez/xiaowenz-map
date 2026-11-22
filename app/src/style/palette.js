import { rampOf, channels } from './core.js';

// Every colour the renderer uses goes through one table: base colour -> index -> five-step ramp.
// The GPU reads the table as a texture, so swapping the table swaps the season without touching geometry.
export class Palette {
  constructor() {
    this.colors = [];
    this.ids = new Map();
  }

  id(c) {
    const key = `${c[0]},${c[1]},${c[2]}`;
    let i = this.ids.get(key);
    if (i === undefined) {
      i = this.colors.length;
      this.ids.set(key, i);
      this.colors.push([c[0], c[1], c[2]]);
    }
    return i;
  }

  // Replace the table with these colours, in this order, one row each. The baked data refers to a
  // colour by its place in a list of names, where two names may share a colour (a pavement and a
  // plaza can be the same grey): they must keep a row each, or every colour after them would shift.
  seat(list) {
    this.colors = list.map(c => [c[0], c[1], c[2]]);
    this.ids = new Map();
    this.colors.forEach((c, i) => {
      const key = c.join(',');
      if (!this.ids.has(key)) this.ids.set(key, i);
    });
    return this;
  }

  // RGBA8, width 5 (levels), height = number of colours
  bytes() {
    const out = new Uint8Array(this.colors.length * 5 * 4);
    this.colors.forEach((c, i) => rampOf(c).forEach((p, level) => {
      const [r, g, b] = channels(p);
      out.set([r, g, b, 255], (i * 5 + level) * 4);
    }));
    return out;
  }
}
