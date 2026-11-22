// Push-optimal Sokoban solver: a breadth-first search over pushes, one room at a
// time, with deadlock pruning, stitched together through the hallway.
//
// Why rooms: the generator lays a 1-wide hallway plus rooms of 3-4 boxes, each
// opening onto the hallway through one door, and a box pushed out of a room can
// never come back — so a level's push-optimal count is the sum of its rooms'
// optima. Solving each room on its own turns one huge search into small ones.
//
// A search state is the boxes' squares plus the player's reachable region
// (named by its lowest square). States are expanded in order of pushes made,
// so the first solved state found is push-optimal for that room. Two prunes,
// both safe (they never cut a solvable state): a dead square, from which no
// push — other boxes aside — can ever bring a box onto a goal, and a frozen
// 2x2 block of walls and boxes with a box off its goal. A* with an admissible
// estimate (each box's shortest grid distance to any goal, summed) is the
// fallback when a level is no set of rooms.
//
// Pure: no clock, no randomness, fixed direction order, so two runs write the
// same bytes. Budgets are counts of states expanded, never wall time.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** One search per room may keep this many states before it gives up. */
const ROOM_STATES = 250_000;
/** The fallback search's expansion budget. */
const FALLBACK_STATES = 400_000;
/** [dx, dy, step letter, push letter] — fixed order everywhere, for determinism. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text. Short rows and the outer frame count as walls. */
function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares a box can be pushed from onto some goal: pull back from the goals. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Shortest grid distance from every square to its nearest goal (boxes ignored). */
function goalDistances(level: Level): Int32Array {
  const { w, wall, goals } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [...goals];
  for (const g of goals) dist[g] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = x + dy * w + dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[x]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way;
 * marks them in `seen` with `stamp` and returns the region's lowest square.
 */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d]))
      return true;
  }
  return false;
}

/** State key: the region's lowest square and the boxes' squares. */
const keyOf = (boxes: number[], low: number): string => String.fromCharCode(low, ...boxes);

/** Shortest walk from `from` to `to` around walls and boxes, lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * Push-optimal solution of `level` (or null when the search gives up): a
 * breadth-first search over pushes, or A* when `heuristic` is given (the
 * summed per-box distance to the nearest goal — admissible, so A* stays
 * optimal). Either way the budget is a count of states, never the clock.
 */
function searchPushes(level: Level, maxStates: number, heuristic: Int32Array | null): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  const estimate = (boxes: number[]): number => {
    let s = 0;
    for (const b of boxes) {
      const d = heuristic![b]!;
      if (d < 0) return -1;
      s += d;
    }
    return s;
  };

  // States in discovery order: boxes, player square, parent, the push (from, to).
  const boxesOf: number[][] = [level.boxes];
  const playerOf: number[] = [level.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const index = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, reach(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // Open list: a plain queue for BFS, a heap on pushes + estimate for A*.
  const heap: [number, number][] = [];
  const heapLess = (a: [number, number], b: [number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const heapPush = (e: [number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  const pushesOf: number[] = [0];
  if (heuristic) heapPush([estimate(level.boxes), 0]);
  let head = 0;
  let found = solved(level.boxes) ? 0 : -1;

  while (found < 0 && (heuristic ? heap.length > 0 : head < boxesOf.length)) {
    const s = heuristic ? heapPop()[1] : head++;
    // A* stops when a solved state is popped (its f is then minimal, so the
    // pushes are optimal); BFS may stop when one is generated instead.
    if (heuristic && solved(boxesOf[s]!)) {
      found = s;
      break;
    }
    const boxes = boxesOf[s]!;
    if (boxesOf.length >= maxStates && !heuristic) break;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, playerOf[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (boxesOf.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const est = heuristic ? estimate(next!) : 0;
        if (est < 0) continue;
        index.set(key, boxesOf.length);
        boxesOf.push(next!);
        playerOf.push(b);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        pushesOf.push(pushesOf[s]! + 1);
        if (heuristic) heapPush([pushesOf[s]! + 1 + est, boxesOf.length - 1]);
        if (!heuristic && solved(next!)) {
          found = boxesOf.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = boxesOf[s]!;
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done?: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal), and each part left that holds a box is a
 * room. Null when some part holds more or fewer boxes than goals, a goal
 * falls in the cut, or a box starts in the hallway — then the level is no
 * set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve a level room by room: each room push-optimal in turn, the other
 * rooms' boxes standing as walls (on their goals once their room is done),
 * the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's.
 * Falls back to an A* search over the whole level when the level is no
 * set of rooms, and to nothing when even that gives up.
 */
function solveLevel(level: Level): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let pushes = 0;
    let moves = '';
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms)
        if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = searchPushes(sub, ROOM_STATES, null);
      if (solved === null) return null;
      pushes += solved.pushes;
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    return { pushes, moves };
  }
  const dist = goalDistances(level);
  return searchPushes(level, FALLBACK_STATES, dist);
}

/** Solve one level's text; an empty string when no solution was found. */
function solve(text: string): string {
  const level = parse(text);
  if (level.player < 0) return '';
  const result = solveLevel(level);
  return result === null ? '' : result.moves;
}

for (const id of readdirSync(IN).sort()) {
  const moves = solve(readFileSync(join(IN, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'solution.txt'), `${moves}\n`);
}
