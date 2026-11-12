// Gas limits are deliberately small: a caller must prepay whatever is attached, and a guest
// account only holds 0.15 testnet NEAR. Real use is 3 to 5 Tgas per call.
// Arf's page. No backend: it reads the contract over NEAR RPC and signs transactions in the
// browser with a guest key that the contract's public "doorman" key lets it create.

import { KeyPair, Near, TGAS, b64decode, formatUnits, hex, sha256, unhex, utf8, verifyEd25519 } from './near-lite.js';
import { SEAL_CSS, SEAL_SVG } from './seal.js';

const D = window.ARF_CONFIG;
const C = D.contract;
const near = new Near(D.rpc);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  cfg: null,
  judgeKeys: [],
  dash: null,
  syncedAt: 0,
  me: null, // { id, key }
  near: null, // my NEAR balance (yocto, BigInt)
  dao: null, // DAO balance
  busy: new Set(),
  seen: null, // keys of activity already shown
  act: null, // transient pup act: { cls, until }
  quip: null, // { text, label, until }
  watching: null, // { id, since }
  focus: null, // joke shown in the verdict card
  proof: null, // { id, checks }
  proofOpen: false,
  farewellShown: 0, // generation whose swim-away we already animated
};

// ------------------------------------------------------------------ small helpers

const ICON = {
  fish: '<svg viewBox="0 0 64 40" aria-hidden="true"><path d="M6 20c8-12 22-16 34-12 6 2 10 6 13 10 3-4 6-7 9-8-2 5-2 13 0 20-3-1-6-4-9-8-3 4-7 8-13 10C28 36 14 32 6 20z" fill="#ff9d5c"/><path d="M12 20c7-8 17-11 27-9 4 1 8 4 10 7-3 5-8 8-13 9-9 2-17-1-24-7z" fill="#ffb87a"/><circle cx="18" cy="17" r="3" fill="#1b2a4a"/><circle cx="17" cy="16" r="1" fill="#fff"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-8-5.3-8-11.2C4 6.6 6.4 4.5 9 4.5c1.4 0 2.5.6 3 1.6.5-1 1.6-1.6 3-1.6 2.6 0 5 2.1 5 5.3C20 15.7 12 21 12 21z" fill="#ff7aa8"/></svg>',
  belly: '<svg viewBox="0 0 64 40" aria-hidden="true"><path d="M6 20c8-12 22-16 34-12 6 2 10 6 13 10 3-4 6-7 9-8-2 5-2 13 0 20-3-1-6-4-9-8-3 4-7 8-13 10C28 36 14 32 6 20z" fill="#35c997"/><circle cx="18" cy="17" r="3" fill="#1b2a4a"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18.5a3 3 0 1 1-2-2.8V5l11-2v11.5a3 3 0 1 1-2-2.8V7.4L9 8.7z" fill="currentColor"/></svg>',
};
const FACE = SEAL_SVG.replace('viewBox="0 0 440 320"', 'viewBox="96 62 190 190"').replace('class="seal"', 'class="seal" data-stage="0"');

const ADJ = ['Sunny', 'Cozy', 'Brave', 'Sleepy', 'Jolly', 'Fuzzy', 'Salty', 'Bubbly', 'Frosty', 'Lucky', 'Mighty', 'Gentle', 'Zippy', 'Snowy', 'Merry', 'Dizzy'];
const NOUN = ['Puffin', 'Narwhal', 'Otter', 'Walrus', 'Penguin', 'Orca', 'Beluga', 'Krill', 'Tern', 'Husky', 'Lemming', 'Albatross', 'Manatee', 'Dolphin', 'Starfish', 'Bear'];

/** Guests get a friendly display name derived from their account id; real names are shown as is. */
function nick(accountId) {
  if (!accountId) return 'someone';
  const m = accountId.match(/^g-([0-9a-f]{12})\./);
  if (!m) return accountId.replace(/\.testnet$/, '');
  const n = parseInt(m[1].slice(0, 6), 16);
  return `${ADJ[n % 16]} ${NOUN[(n >> 4) % 16]}`;
}
const who = (id) => `<span title="${esc(id)}">${esc(nick(id))}${S.me && id === S.me.id ? ' (you)' : ''}</span>`;

const arf = (v, digits = 0) => formatUnits(v, 18, digits);
function compact(v) {
  const n = Number(BigInt(v) / 10n ** 12n) / 1e6;
  if (n >= 1e9) return (n / 1e9).toFixed(3) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
const nearAmt = (v, digits = 2) => formatUnits(v, 24, digits);
function span(secs) {
  secs = Math.max(0, Math.floor(secs));
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
const ago = (at) => {
  const dt = (liveNow() || at) - at;
  return dt < 5 ? 'just now' : span(dt) + ' ago';
};
const STAGE = ['newborn', 'weaner', 'juvenile', 'grown seal'];
const txLink = (hash) => `${D.explorer}/txns/${hash}`;
const acctLink = (id) => `${D.explorer}/address/${id}`;

/**
 * Sets innerHTML only when it actually changed. The page re-renders several times a second;
 * replacing a button's content between mousedown and mouseup would swallow the click.
 * Returns true if the DOM was touched (so handlers need re-binding).
 */
const lastHtml = new WeakMap();
function setHTML(el, html) {
  if (lastHtml.get(el) === html) return false;
  lastHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

function toast(text, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), err ? 6000 : 3500);
}

// ------------------------------------------------------------------ live projection between polls

function liveNow() {
  if (!S.dash) return 0;
  return S.dash.state.now + (performance.now() - S.syncedAt) / 1000;
}

/** The contract's arithmetic, replayed locally so the meters move smoothly between polls. */
function live() {
  const s = S.dash.state, c = S.cfg;
  const dt = (performance.now() - S.syncedAt) / 1000;
  const now = s.now + dt;
  if (!s.present) return { now, present: false };
  const ageSecs = now - s.born_at;
  const ageDays = Math.floor(ageSecs / c.day_secs);
  const drainMult = 1 + Math.min(ageDays, c.drain_growth_cap_days) * c.drain_growth_bps / 10000;
  const awake = Math.max(0, dt - Math.max(0, s.nap_until - s.now));
  const belly = Math.max(0, s.fullness_bps / 100 - awake * (100 / c.full_drain_secs) * drainMult);
  const mood = Math.max(0, s.mood_bps / 100 - dt * (100 / c.mood_decay_secs));
  const hunger = 100 - belly;
  const ageMult = 1 + Math.min(ageDays, c.age_bonus_cap_days) * c.age_bonus_bps / 10000;
  const pantry = Number(BigInt(s.pantry) / 10n ** 12n) / 1e6;
  const feedReward = pantry * (c.feed_max_ppm / 1e6) * (hunger / 100) ** 2 * ageMult * (1 + (c.mood_bonus_max_bps / 10000) * (mood / 100));
  return {
    now, present: belly > 0, belly, mood, hunger, ageSecs, ageDays,
    napping: now < s.nap_until, napLeft: s.nap_until - now,
    leavesIn: Math.max(0, s.leaves_at - now),
    feedReward,
    jokeReward: (score) => pantry * (c.joke_ppm[score] / 1e6) * ageMult,
    canFeed: hunger * 1e7 >= c.min_hunger,
    stage: ageDays >= 10 ? 3 : ageDays >= 5 ? 2 : ageDays >= 2 ? 1 : 0,
  };
}

// ------------------------------------------------------------------ guest account

const STORE = `arf:${C}:guest`;

function loadGuest() {
  try {
    const g = JSON.parse(localStorage.getItem(STORE) || 'null');
    return g ? { id: g.id, key: KeyPair.fromString(g.secret) } : null;
  } catch {
    return null;
  }
}

async function ensureGuest() {
  if (S.me) return S.me;
  const key = KeyPair.random();
  const doorman = KeyPair.fromString(D.doorman_key);
  const { value: id } = await near.call(C, doorman, C, 'welcome_guest', { public_key: key.publicKeyString }, { gas: 30n * TGAS });
  for (let i = 0; i < 30 && !(await near.account(id)); i++) await sleep(400);
  localStorage.setItem(STORE, JSON.stringify({ id, secret: key.toString() }));
  S.me = { id, key };
  toast(`You are ${nick(id)}. No wallet needed.`);
  await refreshBalances();
  renderAccount();
  return S.me;
}

async function refreshBalances() {
  const [mine, dao] = await Promise.all([S.me ? near.account(S.me.id) : null, near.account(D.colony_dao)]);
  S.near = mine ? BigInt(mine.amount) : null;
  S.dao = dao ? BigInt(dao.amount) : null;
}

// ------------------------------------------------------------------ actions

async function run(name, fn) {
  if (S.busy.has(name)) return;
  S.busy.add(name);
  paint();
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast(e.message ? e.message.charAt(0).toUpperCase() + e.message.slice(1) : 'Something went wrong', true);
  } finally {
    S.busy.delete(name);
    paint();
  }
}

const doFeed = () =>
  run('feed', async () => {
    const me = await ensureGuest();
    const absent = !live().present;
    const r = await near.call(me.id, me.key, C, 'feed', {}, { gas: 15n * TGAS, deposit: BigInt(S.cfg.fish_price) });
    if (!absent) tossFish();
    setAct('is-munching', 1500);
    plus(`+${arf(r.value)} ARF`);
    await poll(true);
    refreshBalances().then(renderAccount);
  });

const doJoke = () =>
  run('joke', async () => {
    const text = $('jokeText').value.trim();
    if (!text) return toast('Type a joke first', true);
    const me = await ensureGuest();
    const r = await near.call(me.id, me.key, C, 'tell_joke', { text }, { gas: 15n * TGAS, deposit: BigInt(S.cfg.joke_fee) });
    $('jokeText').value = '';
    countChars();
    S.watching = { id: r.value, since: performance.now() };
    setAct('is-thinking', 60000);
    say('Hmm, let me think…', 'Arf is listening', 60000);
    await poll(true);
    refreshBalances().then(renderAccount);
  });

const doLullaby = () =>
  run('lullaby', async () => {
    const me = await ensureGuest();
    await near.call(me.id, me.key, C, 'lullaby', {}, { gas: 15n * TGAS });
    note('♪');
    plus(`-${arf(S.cfg.lullaby_cost)} ARF burned`, true);
    await poll(true);
  });

const doRefund = (id) =>
  run('refund', async () => {
    const me = await ensureGuest();
    await near.call(me.id, me.key, C, 'refund_joke', { joke_id: id }, { gas: 10n * TGAS });
    S.watching = null;
    setAct(null);
    toast('Joke fee refunded');
    await poll(true);
    refreshBalances().then(renderAccount);
  });

const doRotate = () =>
  run('rotate', async () => {
    const me = await ensureGuest();
    const r = await near.call(me.id, me.key, C, 'rotate_council', {}, { gas: 60n * TGAS });
    toast(r.value ? 'The colony council has been seated' : 'The DAO refused the new council', !r.value);
    await poll(true);
  });

const doFlush = () =>
  run('flush', async () => {
    const me = await ensureGuest();
    await near.call(me.id, me.key, C, 'flush_treasury', {}, { gas: 10n * TGAS });
    toast('Fees sent to the colony treasury');
    await Promise.all([poll(true), refreshBalances()]);
    paint();
  });

/** Re-checks a verdict in the browser from chain data alone. */
async function checkProof(joke) {
  const checks = [];
  const add = (ok, text) => checks.push({ ok, text });
  try {
    const request = await near.view(C, 'judge_request', { joke_id: joke.id });
    const body = JSON.parse(request);
    add(body.model === S.cfg.model && body.messages[0].content === S.cfg.rubric, `The request the contract built uses the model ${body.model} and the published rubric`);
    add(body.messages[1].content.endsWith('Joke: ' + joke.text), 'It contains exactly this joke, nothing more');
    const requestHash = hex(sha256(utf8(request)));
    const key = S.judgeKeys[joke.key_index];
    const text = `${S.cfg.model}:${requestHash}:${joke.response_hash}`;
    if (key && key.algo === 'Ed25519') {
      const ok = verifyEd25519(b64decode(joke.signature), utf8(text), unhex(key.key));
      add(ok, ok ? 'The signature over request and response hashes is valid for the registered judge key' : 'The signature does NOT match');
    } else add(false, 'This verdict was signed with a key type this page cannot check (the contract did)');
    add(true, `Signed text: ${S.cfg.model}:${requestHash.slice(0, 10)}…:${joke.response_hash.slice(0, 10)}…`);
  } catch (e) {
    add(false, 'Could not check: ' + e.message);
  }
  S.proof = { id: joke.id, checks };
  renderVerdict();
}

// ------------------------------------------------------------------ pup acting and effects

function setAct(cls, ms = 0) {
  S.act = cls ? { cls, until: performance.now() + ms } : null;
  paintPup();
}

function say(text, label, ms = 7000) {
  S.quip = { text, label, until: performance.now() + ms };
  paintBubble();
}

function fxEl(html) {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  const el = t.firstChild;
  $('fx').append(el);
  el.addEventListener('animationend', () => el.remove());
  setTimeout(() => el.remove(), 4000);
  return el;
}

function tossFish() {
  const fx = $('fx').getBoundingClientRect();
  const btn = $('feedBtn')?.getBoundingClientRect();
  const pup = $('pup').getBoundingClientRect();
  const x0 = btn ? btn.left + btn.width / 2 - fx.left - 37 : fx.width - 80;
  const y0 = btn ? btn.top - fx.top - 20 : fx.height / 2;
  const x1 = pup.left + pup.width * 0.43 - fx.left - 37;
  const y1 = pup.top + pup.height * 0.62 - fx.top - 20;
  fxEl(`<div class="fish" style="--x0:${x0}px;--y0:${y0}px;--x1:${x1}px;--y1:${y1}px">${ICON.fish}</div>`);
}

const plus = (text, burn = false) => fxEl(`<div class="plus${burn ? ' burn' : ''}">${esc(text)}</div>`);
const note = (text) => fxEl(`<div class="note" style="--dx:40px;--r:8deg">${esc(text)}</div>`);

function arfs(count) {
  const pup = $('pup').getBoundingClientRect(), fx = $('fx').getBoundingClientRect();
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const x = pup.left - fx.left + pup.width * (0.15 + Math.random() * 0.6);
      const y = pup.top - fx.top + pup.height * (0.05 + Math.random() * 0.3);
      fxEl(`<div class="arf" style="left:${x}px;top:${y}px;--dx:${Math.round(Math.random() * 80 - 40)}px;--r:${Math.round(Math.random() * 30 - 15)}deg">Arf!</div>`);
    }, i * 360);
  }
}

function splash() {
  for (let i = 0; i < 14; i++) {
    const a = Math.PI * (0.15 + 0.7 * Math.random());
    const d = 90 + Math.random() * 170;
    fxEl(`<div class="splash" style="--dx:${Math.round(Math.cos(a) * d * (Math.random() < 0.5 ? -1 : 1))}px;--dy:${-Math.round(Math.sin(a) * d)}px"></div>`);
  }
}

/** He just swam away: play it, and (if we have an account) ask the contract to record it. */
function farewell(generation, burned) {
  if (S.farewellShown >= generation) return;
  S.farewellShown = generation;
  const pup = $('pup');
  pup.classList.remove('absent');
  pup.classList.add('leaving');
  splash();
  setTimeout(splash, 500);
  setTimeout(() => plus(`${compact(burned)} ARF burned`, true), 700);
  setTimeout(() => {
    pup.classList.add('absent');
    pup.classList.remove('leaving');
  }, 1500);
  if (S.me && !S.busy.has('poke')) {
    S.busy.add('poke');
    near.call(S.me.id, S.me.key, C, 'poke', {}, { gas: 10n * TGAS }).catch(() => {}).finally(() => {
      S.busy.delete('poke');
      poll(true);
    });
  }
}

function showVerdict(joke, mine) {
  S.focus = joke;
  S.proof = null;
  const laughed = joke.score >= S.cfg.laugh_threshold;
  if (laughed) {
    setAct('is-clapping', Math.max(3, joke.score) * 360 + 300);
    arfs(joke.score);
    if (joke.reward !== '0') setTimeout(() => plus(`+${arf(joke.reward)} ARF`), 500);
  } else setAct('is-unimpressed', 2600);
  say(joke.quip || (laughed ? 'Arf arf arf!' : '…'), `${joke.score}/10 for ${mine ? 'your' : nick(joke.author) + "'s"} joke`, 9000);
  renderVerdict();
}

/** Turns new activity (mine or anyone's) into something the pup visibly does. */
function react(dash) {
  const key = (a) => `${a.at}:${a.kind}:${a.who}:${a.amount}`;
  const first = S.seen === null;
  if (first) S.seen = new Set();
  const fresh = dash.recent.filter((a) => !S.seen.has(key(a))).reverse();
  for (const a of dash.recent) S.seen.add(key(a));
  if (first) {
    if (!dash.state.present) S.farewellShown = dash.state.generation;
    return;
  }
  for (const a of fresh) {
    const mine = S.me && a.who === S.me.id;
    if (a.kind === 'fed' && !mine) {
      setAct('is-munching', 1400);
      say(`Yum! Thank you, ${nick(a.who)}!`, 'fish', 4000);
    } else if (a.kind === 'left') {
      farewell(a.generation, a.amount);
    } else if (a.kind === 'arrived') {
      $('pup').classList.remove('leaving', 'absent');
      $('pup').classList.add('arriving');
      splash();
      setTimeout(() => $('pup').classList.remove('arriving'), 1300);
      say('Arf! Hello!', 'a new pup', 4000);
    } else if (a.kind === 'lullaby' && !mine) note('♪');
    else if ((a.kind === 'laugh' || a.kind === 'groan') && !mine) {
      const joke = dash.jokes.find((j) => j.status === 'Judged' && j.author === a.who && j.judged_at === a.at);
      if (joke) showVerdict(joke, false);
    }
  }
}

// ------------------------------------------------------------------ polling

let polling = false;
async function poll(force = false) {
  if (polling && !force) return;
  polling = true;
  try {
    const dash = await near.view(C, 'get_dashboard', { account_id: S.me ? S.me.id : null });
    S.dash = dash;
    S.syncedAt = performance.now();
    react(dash);
    if (S.watching) {
      const mine = dash.jokes.find((j) => j.id === S.watching.id) || (await near.view(C, 'get_joke', { joke_id: S.watching.id }));
      if (mine && mine.status === 'Judged') {
        S.watching = null;
        showVerdict(mine, true);
        refreshBalances().then(renderAccount);
      } else if (mine && mine.status === 'Refunded') {
        S.watching = null;
        setAct(null);
      }
    }
    if (!S.focus) S.focus = dash.jokes.find((j) => j.status === 'Judged') || null;
    paint();
  } catch (e) {
    console.warn('poll failed', e);
  } finally {
    polling = false;
  }
}

// ------------------------------------------------------------------ rendering

function renderAccount() {
  const el = $('account');
  if (!S.me) {
    if (setHTML(el, `<button class="btn ghost" id="guestBtn">${S.busy.has('guest') ? '<span class="spin"></span> Creating…' : 'Play as guest'}</button>`)) $('guestBtn').onclick = () => run('guest', ensureGuest);
    $('guestBtn').disabled = S.busy.has('guest');
    return;
  }
  const mine = S.dash?.me;
  setHTML(el, `<div class="chip" title="${esc(S.me.id)}"><span class="avatar">${esc(nick(S.me.id)[0])}</span><span>${esc(nick(S.me.id))}</span>
    <span class="bal near"><b>${S.near == null ? '…' : nearAmt(S.near)}</b> NEAR</span>
    <span class="bal"><b>${mine ? compact(mine.arf) : '0'}</b> ARF</span></div>`);
}

function paintPup() {
  const seal = $('pup').querySelector('.seal');
  if (!seal || !S.dash) return;
  const l = live();
  const pup = $('pup');
  if (!l.present) {
    const s = S.dash.state;
    // The chain says he was here at the last poll and our clock says his belly just hit zero.
    if (s.present && s.generation > S.farewellShown) farewell(s.generation, (BigInt(s.pantry) * BigInt(S.cfg.starve_burn_bps)) / 10000n);
    else if (!pup.classList.contains('leaving')) pup.classList.add('absent');
  } else pup.classList.remove('absent', 'leaving');
  const cls = ['seal'];
  const acting = S.act && performance.now() < S.act.until ? S.act.cls : null;
  if (l.present) {
    if (acting) cls.push(acting);
    else if (l.napping) cls.push('is-asleep');
    else {
      if (l.hunger > 55) cls.push('is-hungry');
      if (l.hunger > 85) cls.push('is-starving');
      if (l.mood > 60 && l.hunger <= 55) cls.push('is-happy');
    }
    seal.dataset.stage = l.stage;
  }
  const next = cls.join(' ');
  if (seal.getAttribute('class') !== next) seal.setAttribute('class', next);
}

function paintBubble() {
  const b = $('bubble');
  if (!S.dash) return;
  const l = live();
  let text = null, label = null;
  if (S.quip && performance.now() < S.quip.until) ({ text, label } = S.quip);
  else if (!l.present) text = null;
  else if (l.napping) [text, label] = ['Zzz… fish… zzz…', 'asleep'];
  else if (l.hunger > 85) [text, label] = ['I am SO hungry… one fish? Please?', 'starving'];
  else if (l.hunger > 55) [text, label] = ['My tummy is rumbling!', 'hungry'];
  else [text, label] = [`Tell me a joke about ${S.dash.state.theme}!`, 'Arf says'];
  if (!text) {
    b.hidden = true;
    return;
  }
  const html = `${label ? `<small>${esc(label)}</small>` : ''}${esc(text)}`;
  if (b.dataset.html !== html) {
    b.dataset.html = html;
    b.innerHTML = html;
    b.hidden = false;
    b.style.animation = 'none';
    void b.offsetWidth;
    b.style.animation = '';
  }
  b.hidden = false;
}

function renderVitals() {
  const s = S.dash.state, l = live();
  const el = $('vitals');
  if (!el.dataset.built) {
    el.dataset.built = '1';
    el.innerHTML = `<h3 id="vName"></h3><div class="sub" id="vSub"></div>
      <div class="meter"><div class="row"><span>${ICON.belly} Belly</span><b id="vBelly"></b></div><div class="bar belly" id="vBellyBar"><i></i></div></div>
      <div class="meter"><div class="row"><span>${ICON.heart} Mood</span><b id="vMood"></b></div><div class="bar mood"><i id="vMoodBar"></i></div></div>
      <div class="count" id="vCount"></div>
      <div class="facts"><div><b id="vFeeds"></b>fish eaten</div><div><b id="vLaughs"></b>laughs</div><div><b id="vCarers"></b>carers</div></div>`;
  }
  if (!l.present) {
    $('vName').textContent = s.generation ? 'The floe is empty' : 'No pup yet';
    $('vSub').textContent = s.generation ? `Pup #${s.generation} swam away ${ago(s.left_at)}` : 'Be the first to call one';
    $('vBelly').textContent = $('vMood').textContent = '–';
    $('vBellyBar').firstChild.style.width = $('vMoodBar').style.width = '0%';
    $('vCount').className = 'count';
    $('vCount').innerHTML = 'A fish calls a new pup<b>ready when you are</b>';
  } else {
    $('vName').textContent = `Pup #${s.generation}`;
    $('vSub').textContent = `${STAGE[l.stage]}, ${span(l.ageSecs)} old`;
    $('vBelly').textContent = l.belly.toFixed(0) + '%';
    $('vMood').textContent = l.mood.toFixed(0) + '%';
    $('vBellyBar').className = 'bar belly' + (l.belly < 15 ? ' danger' : l.belly < 45 ? ' warn' : '');
    $('vBellyBar').firstChild.style.width = l.belly + '%';
    $('vMoodBar').style.width = l.mood + '%';
    $('vCount').className = 'count' + (l.leavesIn < S.cfg.full_drain_secs * 0.15 ? ' danger' : '');
    $('vCount').innerHTML = l.napping ? `Asleep, not getting hungrier<b>${span(l.napLeft)} of nap left</b>` : `Swims away if nobody feeds him in<b>${span(l.leavesIn)}</b>`;
  }
  $('vFeeds').textContent = s.feeds;
  $('vLaughs').textContent = s.laughs;
  $('vCarers').textContent = s.carers;
}

function renderActions() {
  const s = S.dash.state, c = S.cfg, l = live();
  const el = $('actions');
  if (!el.dataset.built) {
    el.dataset.built = '1';
    el.innerHTML = `<h3>Give him a fish</h3><p class="hint">The hungrier he is, the bigger your treat.</p>
      <button class="btn big" id="feedBtn"></button>
      <div class="earn" id="feedEarn"></div>
      <div class="divider"></div>
      <h3>Make him laugh</h3>
      <span class="theme" id="themeChip"></span>
      <p class="hint joke-hint">An AI judge scores it. A 7 or more is a laugh.</p>
      <textarea id="jokeText" maxlength="${c.max_joke_len}" placeholder="Why did the seal cross the ocean?…"></textarea>
      <div class="jokebar"><span class="left" id="jokeLeft"></span><button class="btn mint" id="jokeBtn"></button></div>
      <div id="pending"></div>
      <div class="divider"></div>
      <div class="rowbtn"><p>Sing a lullaby: he naps for ${span(c.lullaby_secs)} and stops getting hungry. Burns ${compact(c.lullaby_cost)} ARF.</p><button class="btn ghost small" id="lullBtn"></button></div>`;
    $('feedBtn').onclick = doFeed;
    $('jokeBtn').onclick = doJoke;
    $('lullBtn').onclick = doLullaby;
    $('jokeText').oninput = countChars;
    $('jokeText').onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doJoke();
    };
    countChars();
  }
  const fb = $('feedBtn');
  const feeding = S.busy.has('feed');
  fb.disabled = feeding || (l.present && !l.canFeed);
  setHTML(fb, feeding ? '<span class="spin"></span> Tossing…' : `<span style="width:44px;display:inline-flex">${ICON.fish}</span><span>${l.present ? 'Give a fish' : 'Call a pup with a fish'}<span class="sub">${nearAmt(c.fish_price)} NEAR</span></span>`);
  setHTML(
    $('feedEarn'),
    !l.present
      ? `You would earn about <b>${compact(s.feed_reward)} ARF</b>`
      : l.canFeed
        ? `Right now a fish earns <b>${Math.round(l.feedReward).toLocaleString('en-US')} ARF</b>`
        : 'He is full. Come back when he is hungry.',
  );
  $('themeChip').textContent = `Today's theme: ${s.theme}`;
  const jb = $('jokeBtn');
  jb.disabled = S.busy.has('joke') || !!S.watching;
  setHTML(jb, S.busy.has('joke') ? '<span class="spin"></span> Sending…' : `Tell joke<span class="sub">${nearAmt(c.joke_fee)} NEAR</span>`);
  const lb = $('lullBtn');
  const mine = S.dash.me ? BigInt(S.dash.me.arf) : 0n;
  lb.disabled = S.busy.has('lullaby') || !l.present || l.napping || l.now < s.lullaby_ready_at || mine < BigInt(c.lullaby_cost);
  setHTML(lb, S.busy.has('lullaby') ? '<span class="spin"></span>' : 'Lullaby');
  lb.title = mine < BigInt(c.lullaby_cost) ? 'You need ARF for that: feed him or make him laugh first' : '';

  const p = $('pending');
  if (S.watching) {
    const waited = (performance.now() - S.watching.since) / 1000;
    const canRefund = waited >= c.joke_timeout_secs;
    const changed = setHTML(p, `<p class="hint" style="margin:10px 0 0">${waited < 20 ? 'Waiting for the judge…' : 'The judge is quiet. It only answers while someone runs a relayer.'}
      ${waited >= 20 ? (canRefund ? `<button class="btn ghost small" id="refundBtn">Take my fee back</button>` : ` You can take your fee back in ${span(c.joke_timeout_secs - waited)}.`) : ''}</p>`);
    if (changed && $('refundBtn')) $('refundBtn').onclick = () => doRefund(S.watching.id);
  } else setHTML(p, '');
}

function countChars() {
  const t = $('jokeText');
  if (t) $('jokeLeft').textContent = `${t.value.length}/${S.cfg.max_joke_len}`;
}

function renderVerdict() {
  const el = $('verdictCard');
  const j = S.focus;
  if (!j) {
    setHTML(el, `<h2>The verdict</h2><p class="muted">Nobody has told a joke yet. The first verdict will show up here, with the proof that the judge really said it.</p>`);
    return;
  }
  const laughed = j.score >= S.cfg.laugh_threshold;
  const key = S.judgeKeys[j.key_index];
  const proof = S.proof && S.proof.id === j.id ? S.proof : null;
  const changed = setHTML(el, `<h2>The verdict <small>joke #${j.id} by ${who(j.author)}</small></h2>
    <div class="vgrid"><div>
      <div class="dial"><div class="big${laughed ? '' : ' low'}">${j.score}<small>/10</small></div>
        <div><div class="quote">“${esc(j.quip)}”</div>
        <div class="claps">${Array.from({ length: 10 }, (_, i) => `<i class="${i < j.score ? 'on' : ''}"></i>`).join('')}</div>
        <div class="muted" style="margin-top:6px">${laughed ? `A laugh: <b>+${arf(j.reward)} ARF</b>` : 'Not a laugh: nothing paid'}</div></div></div>
      <p style="font-weight:700">“${esc(j.text)}”</p>
      <span class="badge">Signature checked by the contract</span>
    </div>
    <div class="proof">
      <div class="line"><span>Judge</span><span>${esc(S.cfg.model)} on NEAR AI Cloud, inside secure hardware</span></div>
      <div class="line"><span>Judge key</span><span class="mono">${esc(key ? key.key.slice(0, 16) + '…' + key.key.slice(-8) : '?')}</span></div>
      <div class="line"><span>Response hash</span><span class="mono">${esc(j.response_hash.slice(0, 16))}…${esc(j.response_hash.slice(-8))}</span></div>
      <div class="line"><span>Delivered by</span><span>${who(j.relayer)} (a relayer cannot change it)</span></div>
      ${proof ? `<ul class="checks">${proof.checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${esc(c.text)}</li>`).join('')}</ul>` : `<button class="btn ghost small" id="proofBtn" style="margin-top:10px">Check it yourself</button>`}
    </div></div>`);
  if (changed && $('proofBtn')) $('proofBtn').onclick = () => checkProof(j);
}

function renderPantry() {
  const s = S.dash.state;
  const total = BigInt(s.pantry) + BigInt(s.circulating) + BigInt(s.burned);
  const pc = (v) => (Number((BigInt(v) * 100000n) / total) / 1000).toFixed(2) + '%';
  setHTML($('pantryCard'), `<h2>The pantry</h2>
    <p class="muted">All 1,000,000,000 ARF started here. Nobody was given any. It only leaves as treats, and it burns when a pup is neglected.</p>
    <div class="supply"><i class="p" style="width:${pc(s.pantry)}"></i><i class="c" style="width:${pc(s.circulating)}"></i><i class="b" style="width:${pc(s.burned)}"></i></div>
    <div class="legend">
      <div><span style="--c:#6f9bff">Still in the pantry</span><b>${compact(s.pantry)}</b></div>
      <div><span style="--c:#35c997">Earned by carers</span><b>${compact(s.circulating)}</b></div>
      <div><span style="--c:#ff5a4d">Burned</span><b>${compact(s.burned)}</b></div>
    </div>
    <p class="muted" style="margin-top:12px">Longest-lived pup: <b style="color:var(--ink)">${s.best_age_secs ? `${span(s.best_age_secs)}${s.best_generation ? ` (pup #${s.best_generation})` : ' (and counting)'}` : 'none yet'}</b></p>`);
}

function renderTop() {
  const top = S.dash.top;
  setHTML($('topCard'), `<h2>Best carers ${S.dash.state.generation ? `<small>of pup #${S.dash.state.generation}</small>` : ''}</h2>
    ${top.length ? `<ol class="list">${top.slice(0, 6).map((t, i) => `<li class="${S.me && t.account_id === S.me.id ? 'me' : ''}"><span class="rank">${i + 1}</span><span class="who">${who(t.account_id)}</span><span class="val">${t.points} pts</span></li>`).join('')}</ol>` : '<p class="muted">Nobody yet. A fish for a hungry pup scores more than one for a full pup. A laugh scores ten times the joke.</p>'}
    <p class="muted" style="margin-top:12px">The top ${5} get seats on the colony council.</p>`);
}

function renderJokes() {
  const jokes = S.dash.jokes;
  setHTML($('jokesCard'), `<h2>Latest jokes <small>${S.dash.state.jokes} told</small></h2>
    ${jokes.length ? jokes.slice(0, 5).map((j) => {
      const laughed = j.score >= S.cfg.laugh_threshold;
      const cls = j.status === 'Pending' ? 'pending' : laughed ? 'laugh' : '';
      return `<div class="joke"><div class="score ${cls}">${j.status === 'Judged' ? j.score : j.status === 'Pending' ? '…' : '↩'}</div>
        <div class="text">${esc(j.text)}</div>
        <div class="meta"><span>${who(j.author)}</span><span>${ago(j.told_at)}</span>
        ${j.status === 'Judged' ? `<q>${esc(j.quip)}</q>${laughed ? `<span class="tag ok">+${compact(j.reward)} ARF</span>` : ''}` : j.status === 'Pending' ? '<span class="tag wait">waiting for the judge</span>' : '<span class="tag">refunded</span>'}</div></div>`;
    }).join('') : '<p class="muted">No jokes yet.</p>'}`);
}

function renderColony() {
  const s = S.dash.state, council = S.dash.council;
  const changed = setHTML($('colonyCard'), `<h2>The colony</h2>
    <p class="muted">Every fish and joke fee goes to a Sputnik DAO. Its council is not elected: it is whoever cares most.</p>
    <div class="legend">
      <div><span style="--c:#ffc94d">Treasury</span><b>${S.dao == null ? '…' : nearAmt(S.dao, 3)} NEAR</b></div>
      <div><span style="--c:#9ab9ff">Fees waiting here</span><b>${nearAmt(s.treasury_accrued, 3)} NEAR</b></div>
    </div>
    <p style="margin:12px 0 6px;font-weight:800">Council</p>
    ${council.length ? `<ol class="list">${council.map((a, i) => `<li><span class="rank">${i + 1}</span><span class="who">${who(a)}</span></li>`).join('')}</ol>` : '<p class="muted">Not seated yet.</p>'}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
      <button class="btn ghost small" id="rotateBtn" ${S.busy.has('rotate') ? 'disabled' : ''}>${S.busy.has('rotate') ? '<span class="spin"></span> Seating…' : 'Seat the top carers'}</button>
      <button class="btn ghost small" id="flushBtn" ${S.busy.has('flush') || s.treasury_accrued === '0' ? 'disabled' : ''}>Send fees to treasury</button>
    </div>
    <p class="muted" style="margin-top:10px"><a href="${acctLink(D.colony_dao)}" target="_blank" rel="noopener">${esc(D.colony_dao)}</a></p>`);
  if (changed) {
    $('rotateBtn').onclick = doRotate;
    $('flushBtn').onclick = doFlush;
  }
}

function renderFeed() {
  const line = (a) => {
    if (a.kind === 'fed') return `${who(a.who)} gave a fish <span class="tag ok">+${compact(a.amount)}</span>`;
    if (a.kind === 'laugh') return `${who(a.who)} got a ${a.score}/10 laugh <span class="tag ok">+${compact(a.amount)}</span>`;
    if (a.kind === 'groan') return `${who(a.who)} got a ${a.score}/10 groan`;
    if (a.kind === 'lullaby') return `${who(a.who)} sang a lullaby <span class="tag no">-${compact(a.amount)}</span>`;
    if (a.kind === 'arrived') return `Pup #${a.generation} arrived`;
    return `Pup #${a.generation} swam away <span class="tag no">${compact(a.amount)} burned</span>`;
  };
  setHTML($('feedCard'), `<h2>What just happened</h2>
    ${S.dash.recent.length ? `<ul class="list">${S.dash.recent.slice(0, 7).map((a) => `<li><span class="who" style="white-space:normal">${line(a)}</span><span class="muted" style="font-size:12.5px;white-space:nowrap">${ago(a.at)}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}`);
}

function renderPast() {
  const h = S.dash.history;
  setHTML($('pastCard'), `<h2>Pups before him <small>${S.dash.state.generations_past} so far</small></h2>
    ${h.length ? `<ul class="list">${h.map((g) => `<li><span class="rank">${g.generation}</span><span class="who" style="white-space:normal">lived ${span(g.left_at - g.born_at)}, ${g.feeds} fish, ${g.laughs} laughs, ${g.carers} carers</span><span class="tag no">${compact(g.burned)} burned</span></li>`).join('')}</ul>` : '<p class="muted">No pup has swum away yet. Keep it that way.</p>'}`);
}

function renderRules() {
  const c = S.cfg;
  const el = $('rulesCard');
  if (el.dataset.built) return;
  el.dataset.built = '1';
  el.innerHTML = `<h2>The rules, all of them</h2>
    <ol>
      <li><b>One pup, shared by everyone.</b> His belly empties in ${span(c.full_drain_secs)} when he is newborn, and ${c.drain_growth_bps / 100}% faster for each day he has lived.</li>
      <li><b>A fish costs ${nearAmt(c.fish_price)} NEAR and pays ARF from the pantry.</b> The treat grows with the square of his hunger, so waiting pays, until somebody else feeds him first.</li>
      <li><b>If his belly hits zero he swims away</b> and ${c.starve_burn_bps / 100}% of the pantry is destroyed. The next fish calls a new pup.</li>
      <li><b>A joke costs ${nearAmt(c.joke_fee)} NEAR.</b> An AI judge on NEAR AI Cloud scores it 0 to 10. From ${c.laugh_threshold} up it is a laugh and pays from the pantry (a 10 pays ${c.joke_ppm[10] / 10000}% of it). Laughs lift his mood, and a happy pup gives up to ${c.mood_bonus_max_bps / 100}% more for fish.</li>
      <li><b>Nobody can fake a verdict.</b> The contract builds the judge's request itself and only pays if the answer carries the judge's signature over that exact request and response.</li>
      <li><b>The fees belong to the colony.</b> They go to a Sputnik DAO whose council is the ${5} best carers.</li>
      <li><b>No owner, no knobs.</b> Every number above was fixed when the contract was created. Model: <span class="mono">${esc(c.model)}</span>.</li>
    </ol>`;
}

function renderFoot() {
  $('foot').innerHTML = `<span>Runs on NEAR testnet. ARF has no value.</span>
    <span>Contract <a href="${acctLink(C)}" target="_blank" rel="noopener">${esc(C)}</a></span>
    ${D.source ? `<span><a href="${esc(D.source)}" target="_blank" rel="noopener">Source code</a></span>` : ''}
    <span>Built at NEAR HACKATHON</span>`;
}

function paint() {
  if (!S.dash) return;
  renderAccount();
  renderVitals();
  renderActions();
  renderVerdict();
  renderPantry();
  renderTop();
  renderJokes();
  renderColony();
  renderFeed();
  renderPast();
  renderRules();
  paintPup();
  paintBubble();
  const gone = $('gone');
  if (!live().present && S.dash.state.generation > 0) {
    gone.hidden = false;
    setHTML(gone, `<h3>He swam away</h3><p>Nobody fed pup #${S.dash.state.generation} in time, and ${S.cfg.starve_burn_bps / 100}% of the pantry burned.</p>`);
  } else gone.hidden = true;
}

// ------------------------------------------------------------------ start

async function start() {
  const style = document.createElement('style');
  style.textContent = SEAL_CSS;
  document.head.append(style);
  $('pup').innerHTML = SEAL_SVG;
  $('brandMark').innerHTML = FACE;
  S.me = loadGuest();
  renderFoot();
  renderAccount();
  [S.cfg, S.judgeKeys] = await Promise.all([near.view(C, 'get_config'), near.view(C, 'get_judge_keys')]);
  if (S.me && !(await near.account(S.me.id))) {
    localStorage.removeItem(STORE);
    S.me = null;
  }
  await Promise.all([poll(true), refreshBalances()]);
  paint();
  setInterval(() => poll(), 2500);
  setInterval(() => S.watching && poll(), 900);
  setInterval(() => refreshBalances().then(() => S.dash && (renderAccount(), renderColony())), 12000);
  setInterval(() => {
    if (!S.dash) return;
    renderVitals();
    renderActions();
    paintPup();
    paintBubble();
  }, 400);
}

window.arf = { S, poll, live }; // handy in the console
start().catch((e) => {
  console.error(e);
  toast('Could not reach NEAR testnet: ' + e.message, true);
});
