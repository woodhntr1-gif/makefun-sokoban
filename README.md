# makefun-sokoban

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/woodhntr1-gif/makefun-sokoban/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/woodhntr1-gif/makefun-sokoban/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.

## How it works

The generator builds every level from a 1-wide hallway plus rooms of 3–4
boxes, each opening onto the hallway through one door, and a box pushed out
of a room can never come back — so a level's push-optimal count is the sum
of its rooms' optima. This solver exploits that: it cuts the dead squares
of the hallway row out of the floor, takes each part left that holds boxes
as a room, solves every room push-optimally on its own, and stitches the
rooms' move sequences together with corridor walks between doors.

Inside a room the search is a breadth-first search over pushes (a state is
the boxes' squares plus the player's reachable region), so the first solved
state found is push-optimal for that room. It prunes two deadlocks that
can never be undone — a dead square, from which no push can ever bring a
box onto a goal, and a frozen 2×2 block of walls and boxes with a box off
its goal. When a level is no set of rooms, an A* search over pushes with
an admissible estimate (each box's shortest grid distance to any goal,
summed) takes over.

Honest note: the solver is deterministic and budgets by work (state
counts), never by the clock — two runs write the same bytes. Its practice
numbers are in the Verification section below; the scored set is drawn
after the deadline, so those numbers are a rehearsal, not a promise.

## Run it

The harness runs `node /bot/main.ts`, which reads every instance from
`/input/<id>/level.txt` and writes `/output/<id>/solution.txt` (moves in
LURD). Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`
stand in for `/input` and `/output`.

## Verification

Checked on the kit's practice set (5 instances): all solved in the
practice-optimal push counts, total score 1,000,000, well inside the
60-second wall budget; two runs produce byte-identical outputs. The
house baseline (plain-astar 1.0.0) scores strictly below it on the same
set — see the build notes for the measured numbers.
