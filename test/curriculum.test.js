import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Chess } from '../vendor/chess.js';
import { SKILLS, GROUPS, learningPath, puzzlesFor, newSkillProgress, nextPuzzle, recordPuzzle, skillStatus, applyPassed, LEVELS } from '../src/curriculum.js';

const bank = JSON.parse(readFileSync(new URL('../vendor/puzzles.json', import.meta.url)));

test('every skill is complete and its puzzles exist', () => {
  for (const s of SKILLS) {
    assert.ok(GROUPS.some((g) => g.key === s.group), s.id);
    assert.ok(s.lesson.length >= 2 && s.prompt && s.apply.focus, s.id);
    if (s.source === 'puzzles') assert.ok(puzzlesFor(bank, s).length >= 60, s.id);
  }
});

test('puzzle solutions are legal from the shown position', () => {
  for (const s of SKILLS.filter((x) => x.source === 'puzzles')) {
    for (const p of puzzlesFor(bank, s).slice(0, 10)) {
      const c = new Chess(p.fen);
      for (const u of p.moves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    }
  }
  const mate = puzzlesFor(bank, SKILLS.find((s) => s.id === 'mate')).find((p) => p.theme === 'mateIn1');
  const c = new Chess(mate.fen);
  for (const u of mate.moves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  assert.ok(c.isCheckmate());
});

test('adaptive levels and mastery', () => {
  const skill = SKILLS.find((s) => s.id === 'fork');
  const puzzles = puzzlesFor(bank, skill);
  const sp = newSkillProgress();
  let round = 0;
  const first = nextPuzzle(puzzles, sp, round);
  assert.ok(first.rating < LEVELS[0].max);
  for (let i = 0; i < 3; i++) recordPuzzle(sp, nextPuzzle(puzzles, sp, round), true, round++);
  assert.equal(sp.level, 1);
  recordPuzzle(sp, nextPuzzle(puzzles, sp, round), false, round++);
  recordPuzzle(sp, nextPuzzle(puzzles, sp, round), false, round++);
  assert.equal(sp.level, 0);
  // A missed puzzle comes back after a few rounds.
  const missedId = Object.entries(sp.seen).find(([, v]) => !v.ok)[0];
  round += 3;
  assert.equal(nextPuzzle(puzzles, sp, round).id, missedId);
  for (let i = 0; i < 14; i++) recordPuzzle(sp, nextPuzzle(puzzles, sp, round), true, round++);
  sp.lesson = true;
  let st = skillStatus(skill, sp, null);
  assert.equal(st.steps.find((x) => x.key === 'exercises').done, true);
  assert.equal(st.state, 'learning');
  sp.apply = { passed: true };
  st = skillStatus(skill, sp, null);
  assert.equal(st.state, 'mastered');
});

test('learning path follows your weaknesses', () => {
  const path = learningPath([{ key: 'habit:castled10', impact: 0.5 }, { key: 'tag:hangs', impact: 0.2 }], []);
  assert.equal(path[0].skill.id, 'king');
  assert.equal(path[0].reason.key, 'habit:castled10');
  assert.ok(path.findIndex((p) => p.skill.id === 'hanging') < path.findIndex((p) => p.skill.id === 'fork'));
  assert.equal(learningPath()[0].skill.id, 'hanging');
});

test('apply checks', () => {
  const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ move: { color: 'w', fullmove: i + 1, tags: [] }, analysis: { w: { castled: i >= 6 }, dominance: 5 }, engine: { grade: { key: 'good' } }, ...extra }));
  assert.ok(applyPassed(SKILLS.find((s) => s.id === 'fork'), mk(10), 'w').passed);
  const blunder = mk(10);
  blunder[4].engine = { grade: { key: 'blunder' } };
  assert.ok(!applyPassed(SKILLS.find((s) => s.id === 'fork'), blunder, 'w').passed);
  assert.ok(applyPassed(SKILLS.find((s) => s.id === 'king'), mk(10), 'w').passed);
  assert.ok(!applyPassed(SKILLS.find((s) => s.id === 'king'), mk(5), 'w').passed);
});
