// Sixty days of four different colonies, using the same arithmetic as the contract and the
// `live` rules from presets.mjs. Deterministic (fixed seed): run it twice, get the same numbers.
//
//   node scripts/sim.mjs          prints the summary, writes docs/sim.csv, docs/simulation.svg
//                                 and docs/SIMULATION.md
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/testnet.mjs';
import { PRESETS } from './presets.mjs';

const P = PRESETS.live;
const GENESIS = 1e9; // ARF
const DAYS = 60;
const STEP = 300; // seconds per simulation step
const FISH = Number(P.fish_price) / 1e24;
const JOKE_NET = (Number(P.joke_fee) - Number(P.relayer_tip)) / 1e24;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How often the judge laughs at 7, 8, 9, 10, loosely matching what we saw from the real judge. */
const laughScore = (r) => (r < 0.35 ? 7 : r < 0.75 ? 8 : r < 0.93 ? 9 : 10);

// A policy looks at the pup each step and says how many fish and laughs happen in that step.
const jokesPerStep = (perDay, rnd) => (rnd() < (perDay * STEP) / 86400 ? 1 : 0);
const SCENARIOS = [
  {
    key: 'devoted',
    name: 'Devoted',
    blurb: 'Someone is always around. He is fed as soon as his belly drops below 60%, and hears about 12 good jokes a day.',
    policy: ({ pup, rnd }) => ({ fish: !pup || pup.belly < 60 ? 1 : 0, laughs: jokesPerStep(12, rnd) }),
  },
  {
    key: 'greedy',
    name: 'Greedy',
    blurb: 'Everyone waits for the biggest treat: nobody feeds him above 12% belly, and below that someone shows up only one time in five. Two jokes a day.',
    policy: ({ pup, rnd }) => ({ fish: !pup ? (rnd() < 0.2 ? 2 : 0) : pup.belly < 12 && rnd() < 0.2 ? 3 : 0, laughs: jokesPerStep(2, rnd) }),
  },
  {
    key: 'fairweather',
    name: 'Fair-weather',
    blurb: 'A lively colony from 08:00 to midnight that tops him up before bed, and nobody at all for eight hours every night.',
    policy: ({ pup, hour, rnd }) => {
      if (hour < 8) return { fish: 0, laughs: 0 };
      const bedtime = hour >= 23.5;
      return { fish: !pup || pup.belly < (bedtime ? 95 : 60) ? 1 : 0, laughs: jokesPerStep(8, rnd) };
    },
  },
  {
    key: 'abandoned',
    name: 'Abandoned',
    blurb: 'Devoted for ten days, then everybody leaves for good.',
    policy: ({ pup, day, rnd }) => (day >= 10 ? { fish: 0, laughs: 0 } : { fish: !pup || pup.belly < 60 ? 1 : 0, laughs: jokesPerStep(12, rnd) }),
  },
];

function simulate(s) {
  const rnd = rng(20261114);
  let pantry = GENESIS, circulating = 0, burned = 0, pup = null;
  let pups = 0, longest = 0, fish = 0, laughs = 0, fees = 0;
  const daily = [];
  const ageMult = (t, bps, cap) => 1 + (Math.min(Math.floor((t - pup.born) / P.day_secs), cap) * bps) / 1e4;
  const arrive = (t) => {
    pup = { born: t, belly: (P.start_fullness / 1e9) * 100, mood: 50 };
    pups++;
  };
  for (let t = 0; t <= DAYS * 86400; t += STEP) {
    if (pup) {
      pup.belly -= (100 / P.full_drain_secs) * ageMult(t, P.drain_growth_bps, P.drain_growth_cap_days) * STEP;
      pup.mood = Math.max(0, pup.mood - (100 / P.mood_decay_secs) * STEP);
      if (pup.belly <= 0) {
        const burn = (pantry * P.starve_burn_bps) / 1e4;
        pantry -= burn;
        burned += burn;
        longest = Math.max(longest, t - pup.born);
        pup = null;
      }
    }
    const act = s.policy({ pup, rnd, day: t / 86400, hour: (t % 86400) / 3600 });
    for (let i = 0; i < act.fish; i++) {
      if (!pup) arrive(t);
      const hunger = 100 - pup.belly;
      if (hunger < (P.min_hunger / 1e9) * 100) break;
      const reward = pantry * (P.feed_max_ppm / 1e6) * (hunger / 100) ** 2 * ageMult(t, P.age_bonus_bps, P.age_bonus_cap_days) * (1 + (P.mood_bonus_max_bps / 1e4) * (pup.mood / 100));
      pantry -= reward;
      circulating += reward;
      pup.belly = Math.min(100, pup.belly + (P.fish_points / 1e9) * 100);
      fish++;
      fees += FISH;
    }
    for (let i = 0; i < act.laughs; i++) {
      if (!pup) arrive(t);
      const score = laughScore(rnd());
      const reward = pantry * (P.joke_ppm[score] / 1e6) * ageMult(t, P.age_bonus_bps, P.age_bonus_cap_days);
      pantry -= reward;
      circulating += reward;
      pup.mood = Math.min(100, pup.mood + (score - P.laugh_threshold + 1) * (P.mood_per_point / 1e9) * 100);
      laughs++;
      fees += JOKE_NET;
    }
    if (t % 86400 === 0) daily.push({ day: t / 86400, pantry: (pantry / GENESIS) * 100, circulating: (circulating / GENESIS) * 100, burned: (burned / GENESIS) * 100, pups });
  }
  if (pup) longest = Math.max(longest, DAYS * 86400 - pup.born);
  return { ...s, daily, pups, longest, fish, laughs, fees, end: daily[daily.length - 1] };
}

const runs = SCENARIOS.map(simulate);

// ---------------------------------------------------------------- outputs

const fmt = (n, d = 1) => n.toFixed(d);
const dur = (s) => (s >= 86400 ? `${fmt(s / 86400)} days` : `${fmt(s / 3600)} hours`);
console.table(
  Object.fromEntries(
    runs.map((r) => [r.name, { 'earned %': fmt(r.end.circulating, 2), 'burned %': fmt(r.end.burned, 2), 'pantry %': fmt(r.end.pantry, 2), pups: r.pups, 'longest life': dur(r.longest), fish: r.fish, laughs: r.laughs, 'fees (NEAR)': fmt(r.fees, 2) }]),
  ),
);

const docs = join(ROOT, 'docs');
mkdirSync(docs, { recursive: true });
writeFileSync(
  join(docs, 'sim.csv'),
  ['day,scenario,earned_pct,burned_pct,pantry_pct,pups_so_far', ...runs.flatMap((r) => r.daily.map((d) => [d.day, r.key, d.circulating.toFixed(4), d.burned.toFixed(4), d.pantry.toFixed(4), d.pups].join(',')))].join('\n') + '\n',
);

// Chart: two panels with the same unit (% of the genesis supply), four scenarios each.
// Colours are the first four slots of a palette checked for colour-blind separation; every line
// is also labelled directly, and the same numbers are in the table below and in sim.csv.
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500'];
const W = 1040, H = 430, TOP = 104, BOTTOM = 372;
const panels = [
  { title: 'Earned by carers', sub: 'ARF that left the pantry as treats, % of supply', key: 'circulating', x0: 56, x1: 372 },
  { title: 'Burned by neglect', sub: 'ARF destroyed when a pup swam away, % of supply', key: 'burned', x0: 566, x1: 882 },
];
const niceStep = (v) => [0.5, 1, 2, 5, 10, 20, 25, 50].find((s) => v / s <= 5) || 100;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sixty simulated days of four colonies: share of the ARF supply earned by carers and share burned by neglect">
<style>
  .bg{fill:#fcfcfb}.ink{fill:#0b0b0b}.ink2{fill:#52514e}.mute{fill:#898781}.grid{stroke:#e1e0d9}.axis{stroke:#c3c2b7}
  ${LIGHT.map((c, i) => `.s${i}{stroke:${c}}.f${i}{fill:${c}}`).join('')}
  text{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
  .ring{stroke:#fcfcfb}
  @media (prefers-color-scheme: dark){
    .bg{fill:#1a1a19}.ink{fill:#f0efec}.ink2{fill:#c3c2b7}.grid{stroke:#2c2c2a}.axis{stroke:#383835}.ring{stroke:#1a1a19}
    ${DARK.map((c, i) => `.s${i}{stroke:${c}}.f${i}{fill:${c}}`).join('')}
  }
</style>
<rect class="bg" width="${W}" height="${H}" rx="14"/>
<text class="ink" x="24" y="34" font-size="18" font-weight="700">Sixty days, four colonies</text>
<text class="ink2" x="24" y="56" font-size="13">Same rules, different behaviour. Simulated with the contract's arithmetic and the live parameters.</text>
`;
// legend
let lx = 24;
runs.forEach((r, i) => {
  svg += `<line class="s${i}" x1="${lx}" x2="${lx + 18}" y1="78" y2="78" stroke-width="2.5" stroke-linecap="round"/><circle class="f${i}" cx="${lx + 9}" cy="78" r="4"/><text class="ink2" x="${lx + 26}" y="82.5" font-size="13">${r.name}</text>`;
  lx += 44 + r.name.length * 7.6;
});
for (const p of panels) {
  const top = Math.max(...runs.map((r) => Math.max(...r.daily.map((d) => d[p.key]))));
  const step = niceStep(top);
  const ticks = Math.max(1, Math.ceil(top / step));
  const max = ticks * step;
  const X = (day) => p.x0 + ((p.x1 - p.x0) * day) / DAYS;
  const Y = (v) => BOTTOM - ((BOTTOM - TOP - 34) * v) / max;
  svg += `<text class="ink" x="${p.x0}" y="${TOP}" font-size="14" font-weight="700">${p.title}</text><text class="mute" x="${p.x0}" y="${TOP + 17}" font-size="12">${p.sub}</text>`;
  for (let i = 0; i <= ticks; i++) {
    const v = step * i;
    svg += `<line class="${i ? 'grid' : 'axis'}" x1="${p.x0}" x2="${p.x1}" y1="${Y(v)}" y2="${Y(v)}" stroke-width="1"/><text class="mute" x="${p.x0 - 8}" y="${Y(v) + 4}" font-size="11.5" text-anchor="end">${v % 1 ? v.toFixed(1) : v}%</text>`;
  }
  for (const d of [0, 15, 30, 45, 60]) svg += `<text class="mute" x="${X(d)}" y="${BOTTOM + 18}" font-size="11.5" text-anchor="middle">${d ? 'day ' + d : '0'}</text>`;
  // direct labels at the line ends, nudged apart so they never collide
  const ends = runs.map((r, i) => ({ i, y: Y(r.end[p.key]), text: `${r.name} ${fmt(r.end[p.key], r.end[p.key] < 10 ? 2 : 1)}%` })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
  for (let k = ends.length - 1; k >= 0; k--) if (ends[k].y > BOTTOM - 2) { ends[k].y = BOTTOM - 2 - (ends.length - 1 - k) * 15; }
  for (let k = ends.length - 2; k >= 0; k--) if (ends[k + 1].y - ends[k].y < 15) ends[k].y = ends[k + 1].y - 15;
  runs.forEach((r, i) => {
    const pts = r.daily.map((d) => `${X(d.day).toFixed(1)},${Y(d[p.key]).toFixed(1)}`).join(' ');
    svg += `<polyline class="s${i}" points="${pts}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle class="f${i} ring" cx="${X(DAYS)}" cy="${Y(r.end[p.key]).toFixed(1)}" r="4.5" stroke-width="2"/>`;
  });
  for (const e of ends) svg += `<circle class="f${e.i}" cx="${p.x1 + 14}" cy="${e.y - 4}" r="3.5"/><text class="ink2" x="${p.x1 + 22}" y="${e.y}" font-size="12">${e.text}</text>`;
}
svg += '</svg>\n';
writeFileSync(join(docs, 'simulation.svg'), svg);

writeFileSync(
  join(docs, 'SIMULATION.md'),
  `# Sixty days, four colonies

Generated by \`node scripts/sim.mjs\` (deterministic, no network). It replays the contract's
arithmetic with the \`live\` parameters from \`scripts/presets.mjs\` in ${STEP / 60}-minute steps.

![Share of supply earned by carers and share burned by neglect over sixty simulated days](simulation.svg)

| Colony | What they do | Earned | Burned | Left in pantry | Pups | Longest life | Fish | Laughs | Fees to the colony |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${runs.map((r) => `| ${r.name} | ${r.blurb} | ${fmt(r.end.circulating, 2)}% | ${fmt(r.end.burned, 2)}% | ${fmt(r.end.pantry, 2)}% | ${r.pups} | ${dur(r.longest)} | ${r.fish} | ${r.laughs} | ${fmt(r.fees, 2)} NEAR |`).join('\n')}

Day-by-day numbers are in [sim.csv](sim.csv).

## What the numbers say

- **Care is the only way supply enters circulation.** Nothing is ever minted: ARF moves from the
  pantry to carers, or is destroyed.
- **Waiting pays the individual and costs the colony.** The greedy colony earns more per fish
  (the treat grows with the square of his hunger) and still loses pups, and each loss burns 10% of
  what is left.
- **An older pup needs a more attentive colony.** His belly empties 5% faster per day of age, so a
  colony that sleeps eight hours can raise a young pup and then starts losing him. That is what
  resets the fair-weather colony again and again.
- **An abandoned floe burns once, not forever.** After the pup leaves, the pantry is untouched until
  somebody calls a new pup.
- Rewards are a share of what is left in the pantry, so emission slows by itself as the pantry
  empties. It never reaches zero and never needs a halving schedule.
`,
);
console.log('wrote docs/sim.csv, docs/simulation.svg, docs/SIMULATION.md');
