// The pup. One inline SVG; every look (hungry, happy, clapping, asleep, munching) is a CSS class
// on the root element, so the rest of the page only ever says how he feels.

export const SEAL_SVG = `
<svg class="seal" viewBox="0 0 440 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Arf, a baby seal">
  <defs>
    <radialGradient id="furBody" cx="42%" cy="30%" r="80%">
      <stop offset="0" stop-color="var(--fur-hi)"/>
      <stop offset="0.7" stop-color="var(--fur)"/>
      <stop offset="1" stop-color="var(--fur-lo)"/>
    </radialGradient>
    <radialGradient id="furHead" cx="40%" cy="32%" r="75%">
      <stop offset="0" stop-color="var(--fur-hi)"/>
      <stop offset="0.75" stop-color="var(--fur)"/>
      <stop offset="1" stop-color="var(--fur-lo)"/>
    </radialGradient>
    <radialGradient id="eyeShine" cx="35%" cy="30%" r="80%">
      <stop offset="0" stop-color="#3b4263"/>
      <stop offset="1" stop-color="#151827"/>
    </radialGradient>
  </defs>

  <ellipse class="s-shadow" cx="225" cy="286" rx="168" ry="17"/>

  <g class="s-all">
    <!-- tail -->
    <g class="s-tail">
      <path d="M352 232 C378 214 404 208 414 222 C420 234 398 246 372 250 Z" fill="var(--fur-lo)"/>
      <path d="M356 246 C384 244 408 252 410 266 C408 278 382 274 358 264 Z" fill="var(--fur-lo)"/>
    </g>

    <!-- body -->
    <g class="s-body">
      <path d="M96 236 C92 186 150 158 236 160 C318 162 372 196 372 238 C372 272 322 286 232 286 C142 286 100 278 96 236 Z" fill="url(#furBody)"/>
      <path d="M118 262 C170 284 300 286 356 258 C340 280 296 286 232 286 C170 286 132 282 118 262 Z" fill="var(--fur-lo)" opacity=".55"/>
      <g class="s-spots" fill="var(--spot)">
        <ellipse cx="268" cy="190" rx="13" ry="8"/><ellipse cx="304" cy="206" rx="10" ry="6"/>
        <ellipse cx="330" cy="228" rx="8" ry="5"/><ellipse cx="284" cy="218" rx="7" ry="4.5"/>
        <ellipse cx="246" cy="180" rx="7" ry="4"/><ellipse cx="318" cy="186" rx="6" ry="4"/>
      </g>
      <g class="s-rumble" fill="none" stroke="#8fb4dd" stroke-width="4" stroke-linecap="round">
        <path d="M262 232 q8 -8 16 0 t16 0"/><path d="M270 250 q7 -7 14 0 t14 0"/>
      </g>
    </g>

    <!-- flippers -->
    <g class="s-flip s-flip-l"><path d="M150 252 C122 250 92 262 86 280 C90 292 128 290 162 274 Z" fill="var(--fur)" stroke="var(--fur-lo)" stroke-width="2"/></g>
    <g class="s-flip s-flip-r"><path d="M238 256 C268 252 300 262 306 280 C302 292 262 292 230 276 Z" fill="var(--fur)" stroke="var(--fur-lo)" stroke-width="2"/></g>

    <!-- head -->
    <g class="s-head">
      <circle cx="190" cy="158" r="88" fill="url(#furHead)"/>
      <g class="s-tuft" fill="none" stroke="var(--fur-lo)" stroke-width="4" stroke-linecap="round">
        <path d="M178 76 q4 -12 12 -14"/><path d="M192 74 q2 -12 -2 -18"/><path d="M204 78 q8 -8 16 -8"/>
      </g>
      <ellipse class="s-blush" cx="124" cy="190" rx="16" ry="10"/>
      <ellipse class="s-blush" cx="256" cy="190" rx="16" ry="10"/>

      <!-- eyes: open, happy, asleep -->
      <g class="s-eyes-open">
        <g class="s-eye"><ellipse cx="152" cy="152" rx="15" ry="18" fill="url(#eyeShine)"/><circle cx="146" cy="145" r="6" fill="#fff"/><circle cx="158" cy="160" r="2.6" fill="#fff" opacity=".85"/></g>
        <g class="s-eye"><ellipse cx="228" cy="152" rx="15" ry="18" fill="url(#eyeShine)"/><circle cx="222" cy="145" r="6" fill="#fff"/><circle cx="234" cy="160" r="2.6" fill="#fff" opacity=".85"/></g>
      </g>
      <g class="s-eyes-happy" fill="none" stroke="#1b1f33" stroke-width="7" stroke-linecap="round">
        <path d="M136 158 q16 -22 32 0"/><path d="M212 158 q16 -22 32 0"/>
      </g>
      <g class="s-eyes-sleep" fill="none" stroke="#1b1f33" stroke-width="6" stroke-linecap="round">
        <path d="M137 150 q15 12 30 0"/><path d="M213 150 q15 12 30 0"/>
      </g>
      <g class="s-brows" fill="none" stroke="#6f7f9c" stroke-width="5" stroke-linecap="round">
        <path d="M134 126 q14 -10 30 -2"/><path d="M246 126 q-14 -10 -30 -2"/>
      </g>
      <path class="s-tear" d="M168 172 q-7 12 0 18 q7 -6 0 -18 Z" fill="#8fd3ff"/>

      <!-- muzzle -->
      <ellipse cx="190" cy="196" rx="46" ry="32" fill="var(--fur-hi)"/>
      <g class="s-mouth-open"><ellipse cx="190" cy="212" rx="17" ry="15" fill="#5b2333"/><ellipse cx="190" cy="220" rx="10" ry="7" fill="#ff8fa3"/></g>
      <path class="s-mouth" d="M190 196 q-11 15 -24 5 M190 196 q11 15 24 5" fill="none" stroke="#2a2f45" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M176 180 q14 -9 28 0 q-3 15 -14 16 q-11 -1 -14 -16 Z" fill="#2a2f45"/>
      <ellipse cx="185" cy="183" rx="4" ry="2" fill="#fff" opacity=".5"/>
      <g fill="#9aabc4"><circle cx="160" cy="202" r="2.2"/><circle cx="152" cy="194" r="2.2"/><circle cx="163" cy="191" r="2.2"/><circle cx="220" cy="202" r="2.2"/><circle cx="228" cy="194" r="2.2"/><circle cx="217" cy="191" r="2.2"/></g>
      <g class="s-whiskers" fill="none" stroke="#a9b8cf" stroke-width="2.4" stroke-linecap="round">
        <path d="M150 196 q-26 -6 -46 -2"/><path d="M150 202 q-24 4 -44 12"/><path d="M230 196 q26 -6 46 -2"/><path d="M230 202 q24 4 44 12"/>
      </g>
    </g>
  </g>

  <g class="s-zzz" fill="#fff" font-family="Fredoka, sans-serif" font-weight="700">
    <text x="292" y="96" font-size="30">z</text><text x="318" y="66" font-size="38">z</text><text x="350" y="30" font-size="46">Z</text>
  </g>
</svg>`;

export const SEAL_CSS = `
.seal { --fur:#f7fbff; --fur-hi:#ffffff; --fur-lo:#cfdff0; --spot:#8fa3bd; overflow:visible; display:block; width:100%; height:auto; }
.seal[data-stage="1"] { --fur:#e9f0f7; --fur-hi:#fbfdff; --fur-lo:#b9cbe0; }
.seal[data-stage="2"] { --fur:#d3dee9; --fur-hi:#eef4f9; --fur-lo:#9fb4cb; }
.seal[data-stage="3"] { --fur:#b9c7d6; --fur-hi:#dbe5ee; --fur-lo:#8298b2; --spot:#5f738c; }
.seal .s-shadow { fill: rgba(30,70,130,.20); }
.seal .s-spots { opacity:0; }
.seal[data-stage="1"] .s-spots { opacity:.35; }
.seal[data-stage="2"] .s-spots { opacity:.7; }
.seal[data-stage="3"] .s-spots { opacity:1; }
.seal .s-blush { fill:#ff9db0; opacity:.55; }
.seal .s-eyes-happy, .seal .s-eyes-sleep, .seal .s-mouth-open, .seal .s-zzz, .seal .s-brows, .seal .s-tear, .seal .s-rumble { opacity:0; }
.seal .s-all { transform-origin: 225px 286px; animation: s-breathe 3.6s ease-in-out infinite; }
.seal .s-head { transform-origin: 190px 240px; }
.seal .s-eye { transform-origin: 190px 152px; animation: s-blink 4.6s infinite; }
.seal .s-tail { transform-origin: 356px 244px; animation: s-wag 2.8s ease-in-out infinite; }
.seal .s-flip-l { transform-origin: 156px 262px; }
.seal .s-flip-r { transform-origin: 234px 264px; }
.seal .s-mouth-open { transform-origin: 190px 204px; }

@keyframes s-breathe { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.012,1.028); } }
@keyframes s-blink { 0%,94%,100% { transform: scaleY(1); } 97% { transform: scaleY(.08); } }
@keyframes s-wag { 0%,100% { transform: rotate(0); } 50% { transform: rotate(-7deg); } }

/* hungry: big wet eyes, worried brows, rumbling tummy */
.seal.is-hungry .s-brows, .seal.is-hungry .s-rumble { opacity:1; }
.seal.is-hungry .s-rumble { animation: s-rumble .7s ease-in-out infinite; }
.seal.is-hungry .s-head { animation: s-droop 2.4s ease-in-out infinite; }
.seal.is-starving .s-tear { opacity:1; animation: s-tear 1.8s ease-in infinite; }
@keyframes s-rumble { 0%,100% { transform: translateX(0); } 50% { transform: translateX(5px); } }
@keyframes s-droop { 0%,100% { transform: rotate(0); } 50% { transform: rotate(-3deg) translateY(3px); } }
@keyframes s-tear { 0% { transform: translateY(0); opacity:1; } 100% { transform: translateY(26px); opacity:0; } }

/* happy */
.seal.is-happy .s-blush { opacity:.85; }
.seal.is-happy .s-tail { animation-duration: .9s; }

/* thinking: head tilt */
.seal.is-thinking .s-head { animation: s-tilt 1.6s ease-in-out infinite; }
@keyframes s-tilt { 0%,100% { transform: rotate(-7deg); } 50% { transform: rotate(7deg); } }

/* clapping and laughing */
.seal.is-clapping .s-eyes-open { opacity:0; }
.seal.is-clapping .s-eyes-happy, .seal.is-clapping .s-mouth-open { opacity:1; }
.seal.is-clapping .s-mouth { opacity:0; }
.seal.is-clapping .s-blush { opacity:1; }
.seal.is-clapping .s-all { animation: s-bounce .36s ease-in-out infinite; }
.seal.is-clapping .s-head { animation: s-laugh .36s ease-in-out infinite; }
.seal.is-clapping .s-flip-l { animation: s-clap-l .36s ease-in-out infinite; }
.seal.is-clapping .s-flip-r { animation: s-clap-r .36s ease-in-out infinite; }
.seal.is-clapping .s-tail { animation-duration: .36s; }
@keyframes s-bounce { 0%,100% { transform: translateY(0) scale(1,1); } 50% { transform: translateY(-12px) scale(1.02,1.03); } }
@keyframes s-laugh { 0%,100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg) translateY(-4px); } }
@keyframes s-clap-l { 0%,100% { transform: rotate(0) translate(0,0); } 50% { transform: rotate(-64deg) translate(38px,-22px); } }
@keyframes s-clap-r { 0%,100% { transform: rotate(0) translate(0,0); } 50% { transform: rotate(64deg) translate(-38px,-22px); } }

/* munching */
.seal.is-munching .s-mouth { opacity:0; }
.seal.is-munching .s-mouth-open { opacity:1; animation: s-munch .28s ease-in-out infinite; }
.seal.is-munching .s-eyes-open { opacity:0; }
.seal.is-munching .s-eyes-happy { opacity:1; }
.seal.is-munching .s-head { animation: s-nod .28s ease-in-out infinite; }
@keyframes s-munch { 0%,100% { transform: scale(1,1); } 50% { transform: scale(.9,.25); } }
@keyframes s-nod { 0%,100% { transform: translateY(0); } 50% { transform: translateY(5px); } }

/* groan: unimpressed */
.seal.is-unimpressed .s-eyes-open { opacity:0; }
.seal.is-unimpressed .s-eyes-sleep { opacity:1; }
.seal.is-unimpressed .s-brows { opacity:1; }

/* asleep */
.seal.is-asleep .s-eyes-open { opacity:0; }
.seal.is-asleep .s-eyes-sleep { opacity:1; }
.seal.is-asleep .s-zzz { opacity:1; }
.seal.is-asleep .s-zzz text { animation: s-zzz 2.6s ease-in-out infinite; }
.seal.is-asleep .s-zzz text:nth-child(2) { animation-delay: .5s; }
.seal.is-asleep .s-zzz text:nth-child(3) { animation-delay: 1s; }
.seal.is-asleep .s-all { animation-duration: 5.5s; }
.seal.is-asleep .s-head { transform: rotate(-5deg) translateY(8px); }
@keyframes s-zzz { 0% { transform: translate(0,10px); opacity:0; } 30% { opacity:1; } 100% { transform: translate(14px,-22px); opacity:0; } }

@media (prefers-reduced-motion: reduce) { .seal * { animation: none !important; } }
`;
