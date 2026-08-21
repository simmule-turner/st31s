// ═══════════════════════════════════════════════════════════════════════
//  DC Calculator UI
// ═══════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // ── Persistence ───────────────────────────────────────────────────────
  const STORE_KEY = "dc-calc-state";
  function loadPersistedState() {
    try { const r = localStorage.getItem(STORE_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
  }
  function persistState(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {}
  }

  // ── Theme ─────────────────────────────────────────────────────────────
  function initTheme() {
    const saved = localStorage.getItem("dc-theme");
    const dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }
  function toggleTheme() {
    const next = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("dc-theme", next);
    render();
  }
  function isDark() { return document.documentElement.getAttribute("data-theme") === "dark"; }
  initTheme();

  // ── Calculator state ──────────────────────────────────────────────────
  const _p = loadPersistedState();
  const state = {
    input:       "",
    shift:       false,
    shiftBlue:   false,
    output:      _p.output  || "0",
    lastx:       _p.lastx   || "0",
    dcState:     _p.dcState || { stack: ["0","0","0","0"], config: { i: 10, o: 10, k: 0 } },
    liftEnabled: (typeof _p.liftEnabled === "boolean") ? _p.liftEnabled : true,
    openPopup:   null,
    popupDir:    "above",
  };

  // ── Live DOM refs for lightweight updates ────────────────────────────
  let xInputEl = null, tValEl = null, zValEl = null, yValEl = null, iokInfoEl = null, lastxBtnEl = null;;
  
  // ── Engine instance ───────────────────────────────────────────────────
  const engine = new DCEngine({
    DCMath,
    config: new Map(),
    loadState: () => state.dcState,
    saveState: (s) => {
      state.dcState = s;
      persistState({ dcState: s, lastx: state.lastx, output: state.output, liftEnabled: state.liftEnabled });
    },
    log: () => {},
    id: "dc-calculator",
  });

  // ── DC execution helpers ──────────────────────────────────────────────
  function runDC(input) {
    try {
      const result = engine.run(input, false) || " ";
      normalizeStack();
      state.output = result;
      persistState({ dcState: state.dcState, lastx: state.lastx, output: state.output, liftEnabled: state.liftEnabled });
      return result;
    } catch (e) {
      state.output = "Error: " + e.toString();
      return state.output;
    }
  }

  // Keeps the dc engine's real stack fixed at exactly 4 levels (T/Z/Y/X) so the
  // engine and the on-screen stack panel are always perfectly in sync — z,
  // rolldown, and rollup all operate on a genuine 4-element array, never a
  // separate display-only copy. Growing past 4 drops the oldest (T) entry;
  // shrinking below 4 replicates the oldest surviving entry upward (true
  // HP-style T-register replication on drop), falling back to "0" only when
  // the stack is completely empty.
  function normalizeStack() {
    let s = Array.isArray(state.dcState.stack) ? state.dcState.stack.map(String) : [];
    if (s.length > 4) {
      s = s.slice(-4);
    } else if (s.length < 4) {
      const fill = s.length ? s[0] : "0";
      while (s.length < 4) s.unshift(fill);
    }
    state.dcState.stack = s;
  }
  
  function wrapBtnMacro(cmd, print) {
    const cur = state.input.trim();
    let prefix = "";
    if (cur) prefix = (state.liftEnabled ? "" : "R ") + cur + " ";
    const suffix = (print !== false) ? " p" : "";
    return prefix + cmd + suffix + " 1s=";
  }

  function doEnter() {
    if (!state.input.trim()) {
      // Enter with no new input always duplicates the existing X (re-lift), regardless of flag
      state.liftEnabled = false;
      runDC("d p 1s=");
    } else {
      // If lift is disabled (last action was Enter/digit-overwrite), pop the stale X first;
      // otherwise the push itself naturally shifts old X down to Y (lift).
      const prefix = state.liftEnabled ? "" : "R ";
      const wrapped = prefix + state.input.trim() + " d p 1s=";
      state.liftEnabled = false;
      runDC(wrapped);
      state.input = "";
    }
    refreshAfterCalc();
  }
  
  function doIns(char) {
    if (state.liftEnabled) {
      captureLastX();
      runDC("d 0s=");
      state.input = "";
      state.liftEnabled = false;
      refreshAfterCalc();
    }
    state.input += char;
    refreshIO();
  }

  // Classic HP LAST X behavior: overwrites the X register in place with the
  // preserved pre-operation value. This is a REPLACE, not an entry —
  // Y/Z/T are completely untouched and the stack height never changes.
  // Crucially, this must NOT call captureLastX(): doing so would overwrite
  // the LAST X register with the value we just recalled, making LAST X
  // unusable for repeated recalls. Any pending typed entry is discarded,
  // matching real HP behavior where LAST X immediately replaces the display.
  function recallLastX() {
    state.input = "";
    runDC("R " + state.lastx + " p 1s=");
    // A function just altered X, so the next digit typed should lift
    // (push) rather than overwrite, same as any other function key.
    state.liftEnabled = true;
    refreshAfterCalc();
  }
 
  // doMacro and doFunc are currently identical; kept as two names since call
  // sites use them to document intent (built-in dc command vs. multi-token
  // macro script), but both delegate to one implementation to avoid drift.
  function doFunc(cmd, print) {
    captureLastX();
    const wrapped = wrapBtnMacro(cmd, print);
    state.liftEnabled = true;
    runDC(wrapped);
    state.input = ""; refreshAfterCalc();
  }
  function doMacro(cmd, print) { doFunc(cmd, print); }

  function captureLastX() {
    const cur = state.input.trim();
    if (cur) { state.lastx = cur; }
    else {
      const stk = state.dcState.stack || [];
      state.lastx = stk.length ? String(stk[stk.length - 1]) : "0";
    }
    persistState({ dcState: state.dcState, lastx: state.lastx, output: state.output, liftEnabled: state.liftEnabled });
  }

  // ── Popup management ─────────────────────────────────────────────────
  function togglePopup(id, triggerEl) {
    if (state.openPopup === id) {
      state.openPopup = null;
    } else {
      state.openPopup = id;
      if (triggerEl) {
        const rect = triggerEl.getBoundingClientRect();
        const itemCount = {conv: 6, more: 5, stat: 6, clear: 3}[id] ?? 6;
        const estimatedH = itemCount * 44 + 8;
        state.popupDir = rect.top >= estimatedH ? "above" : "below";
      } else {
        state.popupDir = "below";
      }
    }
    render();
  }
  function closePopup() { if (state.openPopup) { state.openPopup = null; render(); } }

  document.addEventListener("click", e => {
    if (state.openPopup && !e.target.closest(".pop-wrap")) closePopup();
  });

  for (const evt of ["copy", "cut", "paste"]) {
    document.addEventListener(evt, e => {
      if (e.target.closest("button") || e.target.closest(".iok-info")) e.preventDefault();
    });
  }

  // ── dc state accessors ────────────────────────────────────────────────
  function cfg(key) { return state.dcState.config?.[key] ?? ""; }

  // offset 0=X,1=Y,2=Z,3=T. state.dcState.stack is always length-4 thanks
  // to normalizeStack(), so this reads the engine's real, current data directly.
  function stackAt(offset) {
    const s = state.dcState.stack || [];
    const i = s.length - 1 - offset;
    return i >= 0 ? String(s[i]) : "0";
  }
  function registers()     { return state.dcState.registers || {}; }

  // ═══════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════
  function render() {
    const app = document.getElementById("app");
    app.innerHTML = "";
    app.appendChild(buildStackPanel());
    app.appendChild(buildToolbar());
    app.appendChild(buildGrid6());
    app.appendChild(buildGrid5());
    ensureDetailOverlay();
  }

  // ── Lightweight refresh (avoids full re-render on every keypress) ────
  function refreshIO() {
    if (xInputEl) {
      xInputEl.value = state.input || state.output;
      scrollXToEnd(xInputEl);
    }
    if (tValEl) tValEl.textContent = stackAt(3);
    if (zValEl) zValEl.textContent = stackAt(2);
    if (yValEl) yValEl.textContent = stackAt(1);

    // Dynamically update the lastx tooltip
    if (lastxBtnEl) lastxBtnEl.title = "Recall lastx: " + state.lastx;
  }

  function refreshAfterCalc() {
    refreshIO();
    if (iokInfoEl) iokInfoEl.innerHTML = `<span><b>i:</b> ${esc(String(cfg("i")))}</span><span> <b>o:</b> ${esc(String(cfg("o")))}</span><span> <b>k:</b> ${esc(String(cfg("k")))}</span>`;
  }

  // ── Stack panel (T/Z/Y/X) ────────────────────────────────────────────
  function buildStackPanel() {
    const wrap = el("div", "stack-panel");

    const makeRow = (label, offset) => {
      const row = el("div", "stack-row");
      const lbl = el("span", "stack-label"); lbl.textContent = label;
      const val = el("span", "stack-value"); val.textContent = stackAt(offset);
      row.appendChild(lbl); row.appendChild(val);
      wrap.appendChild(row);
      return val;
    };

    tValEl = makeRow("T", 3);
    zValEl = makeRow("Z", 2);
    yValEl = makeRow("Y", 1);

    const xRow = el("div", "stack-row x-row");
    const xLbl = el("span", "stack-label"); xLbl.textContent = "X";
    const xInp = document.createElement("input");
    xInp.type = "text";
    // The displayed number is always the field's actual VALUE (not a
    // placeholder) — placeholders render via a separate browser overlay
    // that does not reliably participate in scroll/overflow positioning,
    // which is why long numbers couldn't be scrolled into view before.
    xInp.value = state.input || state.output;
    xInp.placeholder = "0";

    // readOnly suppresses the mobile soft-keyboard when calculator buttons are tapped.
    // It is removed only when the user explicitly taps into the input field.
    xInp.readOnly = true;
    xInp.addEventListener("focus", () => {
      xInp.readOnly = false;
      if (!state.input) {
        // If nothing has been typed yet, select the whole displayed result
        // so the user can immediately copy it via the system context menu
        // (e.g. long-press > Copy on mobile) without having to drag
        // selection handles across a long number. If they instead start
        // typing, the selected text is naturally replaced as normal.
        xInp.select();
      }
    });
    xInp.addEventListener("blur",  () => { xInp.readOnly = true; refreshIO(); });
    xInp.addEventListener("input",   e => { state.input = e.target.value; });
    xInp.addEventListener("keydown", e => { if (e.key === "Enter") doEnter(); });
    xRow.appendChild(xLbl); xRow.appendChild(xInp);
    wrap.appendChild(xRow);

    xInputEl = xInp;
    scrollXToEnd(xInp);
    return wrap;
  }

  // Forces the input's horizontal scroll position to its right end so the
  // most recently entered / most significant digits of an overflowing
  // number stay visible, instead of the browser defaulting to show the
  // start of the text. This is done directly via scrollLeft rather than
  // relying on dir="rtl" or other CSS tricks, which proved unreliable
  // across Chrome desktop and Android.
  function scrollXToEnd(inputEl) {
    if (!inputEl) return;
    inputEl.scrollLeft = inputEl.scrollWidth;
  }

  // ── Toolbar ────────────────────────────────────────────────────────
  function buildToolbar() {
    const bar = el("div", "toolbar");
    const left = el("div", "tb-left");

    // ▼, regs
    left.appendChild(dualPopupKey("util", "▼", { run: () => { showDetailPopup(); } }, "clear", "clear", [
      ["CLALL", () => { state.dcState={ stack: ["0","0","0","0"], config: { i: 10, o: 10, k: 0 } }; state.output="0"; state.lastx="0"; state.input=""; state.liftEnabled=true; localStorage.removeItem(STORE_KEY); render(); }],
      ["CL\u03A3", "0 s5 0 s6 0 s7 0 s8 0 s9 0 s0 0sa La 0sb Lb R R 1s= [ lJ 1 - ;a lJ :a lJ 1 - sJ lL x ] sS [ lK lJ 1 - ;a >S ] sC [ 0 lJ >C ] sL [ lI ;a sK lI sJ lL x lK lJ :a lI 1 + sI lI lN >M ] sM", true],
      ["CLSTK", "c 0 0 0 0", true]
    ]));


    // Injected custom orange Pioneer arrow SVG directly onto the button face
    const shiftSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 35" width="100%" height="100%" fill="currentColor">
  <!-- Exact HP 48SX Left-Shift Elbow Arrow (Isolated Graphic) -->
  <path d="M 42,33 
           L 32,33 
           L 32,17 
           L 18,17 
           L 18,24 
           L 2,13 
           L 18,2 
           L 18,9 
           L 42,9 
           Z" 
        stroke-width="0.5"
        stroke-linejoin="miter"/>
</svg>
`;

    const shiftSvgBlueRight = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 35" width="100%" height="100%" fill="currentColor">
  <!-- Exact HP 48SX Right-Shift Elbow Arrow -->
  <path d="M 2,33 
           L 12,33 
           L 12,17 
           L 26,17 
           L 26,24 
           L 42,13 
           L 26,2 
           L 26,9 
           L 2,9 
           Z" 
        stroke-width="0.5"
        stroke-linejoin="miter"/>
</svg>
`;

    const shCell = dualBtn(
      state.shift ? "shift-on shift-key" : "util shift-key", 
      { label: shiftSvg, run: () => { state.shift = !state.shift; state.shiftBlue = false; render(); } }, 
      null, 
      null, 
      true
    );
    left.appendChild(shCell);

    const shBlueCell = dualBtn(
      state.shiftBlue ? "shift-on shift-key" : "util shift-key", 
      { label: shiftSvgBlueRight, run: () => { state.shiftBlue = !state.shiftBlue; state.shift = false; render(); } }, 
      null, 
      null, 
      true
    );
    shBlueCell.querySelector("button").style.color = "#0066cc";
    left.appendChild(shBlueCell);

    bar.appendChild(left);

    const right = el("div", "tb-right");
    const iokSpan = el("span", "iok-info");
    //iokSpan.style.display = "flex";
    iokSpan.style.gap = "10px";
    iokSpan.innerHTML = `<span><b>i:</b> ${esc(String(cfg("i")))}</span><span> <b>o:</b> ${esc(String(cfg("o")))}</span><span> <b>k:</b> ${esc(String(cfg("k")))}</span>`;
    right.appendChild(iokSpan);
    iokInfoEl = iokSpan;

    const themeBtn = document.createElement("button");
    themeBtn.className = "theme-btn";
    themeBtn.textContent = isDark() ? "☀︎" : "☾";
    themeBtn.title = isDark() ? "Switch to light mode" : "Switch to dark mode";
    themeBtn.addEventListener("click", toggleTheme);
    right.appendChild(themeBtn);

    bar.appendChild(right);
    return bar;
  }

async function loadFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return resolve("");
      
      const reader = new FileReader();
      reader.onload = (evt) => resolve(evt.target.result);
      reader.onerror = () => resolve("");
      reader.readAsText(file);
    });
    
    input.addEventListener('cancel', () => resolve(""));
    input.click();
  });
}

function getIsoDate() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`; // Guarantees "20260709" in local time
}

/**
 * Gets the day of the week from a YYYYMMDD string.
 * @param {string} isoDate - The date string in YYYYMMDD format.
 * @returns {string} The name of the day (e.g., "Wednesday").
 */
function getDow() {
  const isoDate = xInputEl.value; // stackAt(0);

  // Ensure the input is a valid 8-character string
  if (typeof isoDate !== 'string' || isoDate.length !== 8) {
    return `R [${isoDate} must be in YYYYMMDD format.]`;
  }

  // Extract components
  const year = parseInt(isoDate.substring(0, 4), 10);
  const month = parseInt(isoDate.substring(4, 6), 10) - 1; // JS Date months are 0-indexed
  const day = parseInt(isoDate.substring(6, 8), 10);

  // Create date object
  const dateObj = new Date(year, month, day);

  // Array mapping 0-6 to day names (0 = Sunday, 6 = Saturday)
  const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  
  // Return the string (or simply return dateObj.getDay() for the integer)
  return "R [" + daysOfWeek[dateObj.getDay()] + "]";
}
  
  // ── 6-column grid (rows 1–3) ────────────────────────────────────────
  function buildGrid6() {
    const g = el("div", "grid6");

    // Row 1
    g.appendChild(dualBtn("func", withLabel("\u221Ax",  runFunc("v")),         withLabel("\u2192pol", runFunc(TOPOLAR)), null, false, withLabel("nCr", runFunc(COMB))));
    g.appendChild(dualBtn("func", withLabel("x\u00B2",  runFunc("d *")),       withLabel("\u2192rec", runFunc(TOREC)), null, false, withLabel("nPr", runFunc(PERM))));
    g.appendChild(dualBtn("func", withLabel("ln",       runFunc(LN)),          withLabel("lg",        runFunc(LG)), null, false, withLabel("jn", runFunc(JN))));
    g.appendChild(dualBtn("func", withLabel("e\u02E3",  runFunc(EXP)),         withLabel("10\u02E3",  runFunc(TEN_X)), null, false, withLabel("sinh", runFunc(SINH))));
    g.appendChild(dualBtn("func", withLabel("y\u02E3",  runFunc("^")),         withLabel("x!",         runFunc(GAMMA)), null, false, withLabel("cosh", runFunc(COSH))));
    g.appendChild(dualBtn("func", withLabel("1/x",      runFunc("1r/")),       withLabel("\u0394%",   runFunc("s_ l_ - l_ / 100 *")), null, false, withLabel("tanh", runFunc(TANH))));

    // Row 2
    g.appendChild(dualBtn("func", withLabel("\u0394days",          runFunc(DELTA_DAYS)), withLabel("date+", runFunc(DATE_PLUS)), null, false, withLabel("\u0394ymd", runFunc(DELTA_YMD))));
    /*
    c: Speed of light ($299792458$)
    h: Planck constant ($6.62607015 \times 10^{-34}$)
    G: Gravitational constant ($6.67430 \times 10^{-11}$)
    NA: Avogadro's number ($6.02214076 \times 10^{23}$)
    R: Universal gas constant ($8.314462618$)
    k: Boltzmann constant ($1.380649 \times 10^{-23}$)
    e: Elementary charge ($1.602176634 \times 10^{-19}$)
    ε₀: Vacuum permittivity ($8.8541878128 \times 10^{-12}$)
    g: Standard gravity ($9.80665$)
    */
    g.appendChild(dualPopupKey("func", "t &#x1D58;/&#x1D65;", runFunc(ABC), "const", "const", [
      ["c",       "299792458",                      "2.997e8 m/s, Speed of light"],
      ["h",       "0.000000000000000000000000000000000662607015", "6.626e-34 J·s, Planck constant"],
      ["G",       "0.0000000000667430",             "6.674e-11 m³/kg·s², Gravitational constant"],
      ["N\u2090", "602214076000000000000000",        "6.022e23 mol⁻¹, Avogadro's number"],
      ["R",       "8.314462618",                    "8.314 J/mol·K, Universal gas constant"],
      ["k",       "0.00000000000000000000001380649", "1.380e-23 J/K, Boltzmann constant"],
      ["q\u2091", "0.0000000000000000001602176634",  "1.602e-19 C, Elementary charge"],
      ["\u03B5\u2080", "0.0000000000088541878128",   "8.854e-12 F/m, Vacuum permittivity"],
      ["g",       "9.80665",                        "9.807 m/s², Standard gravity"]
    ]));
    g.appendChild(dualPopupKey("func", "&#x02E3;\u221Ay", runFunc(NTHROOT), "stats", "stats", [
      ["n\u03A3",       "l5"],
      ["\u03A3x",       "l6"],
      ["\u03A3x\u00B2", "l8"],
      ["\u03A3xy",      "l0"],
      ["\u03A3y",       "l7"],
      ["\u03A3y\u00B2", "l9"],
    ]));
    g.appendChild(dualBtn("func", withLabel("sin", runFunc(SIN)), withLabel("sin\u207B\u00B9", runFunc(ASIN)), null, false, withLabel("sinh\u207B\u00B9", runFunc(ASINH))));
    g.appendChild(dualBtn("func", withLabel("cos", runFunc(COS)), withLabel("cos\u207B\u00B9", runFunc(ACOS)), null, false, withLabel("cosh\u207B\u00B9", runFunc(ACOSH))));
    g.appendChild(dualBtn("func", withLabel("tan", runFunc(TAN)), withLabel("tan\u207B\u00B9", runFunc(ATAN)), null, false, withLabel("tanh\u207B\u00B9", runFunc(ATANH))));

    // Row 3
    g.appendChild(dualBtn("util", withLabel("enter", { run: doEnter }), withLabel("iso-date", runFunc(getIsoDate())), "span2", false, withLabel("load", { run: async () => { const text = await loadFile(); if (text !== "") { doFunc(text); } } })));
    g.appendChild(dualPopupKey("func", "x&#x21C4;y", runMacro("r", true), "conv", "conv", [
      ["fl oz\u279Cml", "29.57354942 *"],
      ["kg\u279Clb", "2.20462262 *"],
      ["km\u279Cmi", "1.609344 /"],
      ["lb\u279Ckg", "2.20462262 /"],
      ["mi\u279Ckm", "1.609344 *"],
      ["ml\u279Cfl oz", "29.57354942 /"],
    ]));
    g.appendChild(dualPopupKey("func", "drop", runMacro("R", true), "more", "more", [
      ["ceil", CEIL],
      ["floor", FLOOR],
      ["gcd", GCD],
      ["lcm", LCM],
      ["pf", PF],
    ]));
    g.appendChild(dualBtn("func", withLabel("r\u25BC", runFunc(ROLLDOWN)), withLabel("r\u25B2", runFunc(ROLLUP)), null, false, withLabel("\u00B0\u279Crad", runFunc(D2R))));
    g.appendChild(dualBtn("util bs-btn", withLabel("\u232B", { run: () => { state.input = state.input.slice(0, -1); refreshIO(); } }), withLabel("dow",runFunc(getDow())), null, false, withLabel("rad\u279C\u00B0", runFunc(R2D))));

    return g;
  }

  // ── 5-column grid (rows 4–7) ────────────────────────────────────────
  function buildGrid5() {
    const g = el("div", "grid5");
 
    // Digits have no shifted meaning, so this is just dualBtn with shift=null —
    // which already auto-clears any pending shift after firing main.run(),
    // identical to what this function used to do by hand.
    function digit(ch) { return dualBtn("ins", withLabel(ch, runIns(ch)), null); }

    // Row 4
    g.appendChild(dualBtn("func", withLabel("%", runMacro(PERCENT)), withLabel("\u00AC", runMacro(NOT)), null, false, withLabel("\u00B0F\u279C\u00B0C", runFunc("32 - 5.00 * 9 /"))));
    g.appendChild(digit("7")); g.appendChild(digit("8")); g.appendChild(digit("9"));
    g.appendChild(dualBtn("func", withLabel("\u00F7", runFunc("/")), withLabel("x\u0304", runFunc("K sk 10 k l6 l5 / lk k")), null, false, withLabel("y\u0304", runFunc(YBAR))));

    // Row 5
    g.appendChild(dualBtn("func", withLabel("p", runMacro("p", false)), withLabel("\u2227", runMacro(AND, true)), null, false, withLabel("\u00B0C\u279C\u00B0F", runFunc("9 * 5.00 / 32 +"))));
    g.appendChild(digit("4")); g.appendChild(digit("5")); g.appendChild(digit("6"));
    g.appendChild(dualBtn("func", withLabel("\u00D7", runFunc("*")), withLabel("y\u0302", runFunc(YHAT)), null, false, withLabel("median", runFunc(MEDIAN))));

    // Row 6
    g.appendChild(dualBtn("func", withLabel("k", runMacro("k", true)), withLabel("\u2228", runMacro(OR, true)), null, false, withLabel("\u03C0", runFunc(PI))));
    g.appendChild(digit("1")); g.appendChild(digit("2")); g.appendChild(digit("3"));
    g.appendChild(dualBtn("func", withLabel("\u2013", runFunc("-")), withLabel("r", runFunc(CORR)), null, false, withLabel("mode", runFunc(MODE))));

    // Row 7
    const lxCell = dualBtn("util", withLabel("lastx", { run: () => { recallLastX(); } }), withLabel("\u2295", runMacro(XOR)), null, false, withLabel("n!", runFunc(FACTORIAL)));
    lastxBtnEl = lxCell.querySelector("button");
    lastxBtnEl.title = "Recall lastx: " + state.lastx;
    g.appendChild(lxCell);
    g.appendChild(digit("0")); g.appendChild(digit("."));
    g.appendChild(dualBtn("func", withLabel("\u00B1", runMacro("_1*", true)), withLabel("s", runFunc("Ks_ 10 k l8 l6 d * l5 / - l5 1 - / v l_k")), null, false, withLabel("\u03C3", runFunc(POPULATION))));
    g.appendChild(dualBtn(
      "func",
      withLabel("+", runFunc("+")),
      withLabel("\u03A3+", runFunc(SIGMA_PLUS)), null, false, withLabel("\u03A3-", runFunc(SIGMA_MINUS))));

    return g;
  }

  // ── Stack/Registers overlay (Last-X + Registers; the live T/Z/Y/X table
  // is intentionally omitted since the stack panel above is always visible) ──
  let detailOverlayEl = null, detailBackdropEl = null;

  function ensureDetailOverlay() {
    const app = document.getElementById("app");
    if (!detailBackdropEl) {
      detailBackdropEl = el("div", "detail-backdrop");
      detailBackdropEl.addEventListener("click", () => {
        detailBackdropEl.classList.remove("open");
        detailOverlayEl.classList.remove("open");
      });
    }
    if (!detailOverlayEl) {
      detailOverlayEl = el("div", "detail-overlay");
    }
    // render() rebuilds #app's children each time (app.innerHTML = ""), which
    // detaches these from the DOM even though the JS references survive —
    // always re-append rather than guarding on detailOverlayEl being truthy.
    app.appendChild(detailBackdropEl);
    app.appendChild(detailOverlayEl);
  }

  function showDetailPopup() {
    ensureDetailOverlay();
    updateDetailContent();
    detailBackdropEl.classList.add("open");
    detailOverlayEl.classList.add("open");
  }
    
  function updateDetailContent() {
    if (!detailOverlayEl) return;
    detailOverlayEl.innerHTML = "";

    const lxTable = el("table");
    lxTable.innerHTML = `<tbody><tr class="lx-row"><td class="lx-lbl" style="width:60px">lastx:</td><td class="mono" style="font-weight:bold">${esc(state.lastx)}</td></tr></tbody>`;
    detailOverlayEl.appendChild(lxTable);

    const rTable = el("table");
    rTable.style.marginTop = "8px";
    rTable.innerHTML += `<thead><tr><th style="width:55px">Reg</th><th>Frames</th></tr></thead>`;

    const rTbody = el("tbody");
    // Sort the register entries alphabetically by the 'name' (the key)
    const sortedRegisters = Object.entries(registers()).sort((a, b) => a[0].localeCompare(b[0]));

    for (const [name, data] of sortedRegisters) {
      const frames = (data?.frames ?? []).slice().reverse();    
      let html = "";
      for (const f of frames) {
        html += `<span style="margin-right:10px;display:inline;white-space:normal"><span class="fv">${esc(String(f.v??""))}</span>`;
        const keys = Object.keys(f.array ?? {}).sort((a,b) => +a - +b);
        if (keys.length) html += " \u2192 ";
        for (const k of keys) html += `<span class="ae">[${esc(k)}]: ${esc(String(f.array[k]))}</span>`;
        html += `</span>`;
      }
      const tr = el("tr");
      tr.innerHTML = `<td style="font-weight:bold">${esc(name)}</td><td class="mono" style="line-height:1.3">${html}</td>`;
      rTbody.appendChild(tr);
    }
    rTable.appendChild(rTbody);
    detailOverlayEl.appendChild(rTable);
  }

  // ── Button factories ───────────────────────────────────────────────
  // Simple single-face button (used inside popup menus / toolbar utility buttons)
  function btn(cls, label) { const b = document.createElement("button"); b.className = cls; b.innerHTML = label; return b; }
  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function esc(s) { return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  // Popup-menu entry buttons (flat list inside an open popup) — single face, reuse existing run helpers
  function fBtnSimple(label, cmd, print) { const b = btn("func", label); b.addEventListener("click", () => doFunc(cmd, print)); return b; }
  // mBtnSimple is currently identical to fBtnSimple; kept as a separate name
  // for call-site clarity (dualPopupKey distinguishes macro vs. func entries).
  function mBtnSimple(label, cmd, print) { return fBtnSimple(label, cmd, print); }
 
  // noAutoClear is set only for the shift toggle key itself, since its job
  // is to SET state.shift — every other key consumes/cancels shift after a
  // single press, matching real HP momentary-shift behavior (press shift,
  // press one key, shift clears — it never stays "locked on").
  function dualBtn(cls, main, shift, wrapExtra, noAutoClear, shiftBlue) {
    const wrap = el("div", "key-cell" + (wrapExtra ? " " + wrapExtra : ""));
    const b = document.createElement("button");
    b.className = cls;
    b.innerHTML = main ? main.label : "";
    b.addEventListener("click", e => {
      if (noAutoClear) { if (main) main.run(b, e); return; }
      const shiftWasOn = state.shift;
      const shiftBlueWasOn = state.shiftBlue;
      
      if (shiftBlueWasOn && shiftBlue) {
        shiftBlue.run(b, e);
      } else if (shiftWasOn && shift) {
        shift.run(b, e);
      } else if (main) {
        main.run(b, e);
      }
      
      if (shiftWasOn || shiftBlueWasOn) {
        state.shift = false;
        state.shiftBlue = false;
        render();
      }
    });
    wrap.appendChild(b);
    
    const isMenu = state.shiftBlue ? (shiftBlue && shiftBlue.menu) : (shift && shift.menu);
    const lbl = el("div", "shift-label-row" + (isMenu ? " menu" : ""));
    if (state.shiftBlue) {
      lbl.innerHTML = shiftBlue ? shiftBlue.label : "";
      lbl.style.color = "#0066cc";
    } else {
      lbl.innerHTML = shift ? shift.label : "";
      lbl.style.color = "";
    }
    wrap.appendChild(lbl);
    return wrap;
  }

  // Run-descriptor helpers
  function runIns(ch)            { return { run: () => doIns(ch) }; }
  function runFunc(cmd, print)   { return { run: () => doFunc(cmd, print) }; }
  // runMacro is currently identical to runFunc (see doMacro/doFunc above);
  // kept as a separate name for call-site clarity, delegating to avoid drift.
  function runMacro(cmd, print)  { return runFunc(cmd, print); }
  function withLabel(label, descriptor) { return Object.assign({ label }, descriptor); }

  // Key cell whose shift slot opens a popup menu. The trigger label sits below
  // the button (underlined, like other shift items); the menu itself is anchored
  // to the button via an inner .pop-wrap so existing popup-positioning logic
  // (rect-based above/below detection) is unaffected by the label underneath.
function dualPopupKey(cls, mainLabel, mainDescr, shiftId, shiftLabel, entries) {
    const wrap = el("div", "key-cell");
    const popWrap = el("div", "pop-wrap");
    const b = document.createElement("button");
    b.className = cls;
    b.innerHTML = mainLabel || "";
    b.addEventListener("click", e => {
      if (state.shift || state.shiftBlue) {
        e.stopPropagation();
        // Opening the menu IS the shifted action — consume shift now so the
        // toolbar shift indicator clears, same as any other shifted key.
        state.shift = false;
        state.shiftBlue = false;
        togglePopup(shiftId, b);
      }
      else if (mainDescr) { mainDescr.run(); }
    });
    popWrap.appendChild(b);

    const isOpen = state.openPopup === shiftId;
    const menu = el("div", "pop-menu" + (isOpen ? " open" : ""));
    menu.setAttribute("data-dir", isOpen ? state.popupDir : "above");
    
    // Sort the entries alphabetically by the label (index 0) before rendering
    const sortedEntries = entries.slice().sort((a, b) => a[0].localeCompare(b[0]));

    for (const entry of sortedEntries) {
      let eb;
      if (typeof entry[1] === "function") {
        eb = btn("func", entry[0]);
        eb.addEventListener("click", entry[1]);
      } else {
        const [label, cmd, print] = entry;
        eb = (print === false) ? mBtnSimple(label, cmd, false) : fBtnSimple(label, cmd, print);
      }      
      
      // If a tooltip string is provided as the 3rd index, apply it to the DOM element
      if (entry[2]) {
        eb.title = entry[2];
      }

      eb.addEventListener("click", closePopup, { capture: true });
      menu.appendChild(eb);
    }
    popWrap.appendChild(menu);
    wrap.appendChild(popWrap);

    const lbl = el("div", "shift-label-row menu");
    lbl.innerHTML = shiftLabel || "";
    wrap.appendChild(lbl);
    return wrap;
  }  
  // ═══════════════════════════════════════════════════════════════════
  //  DC scripts
  // ═══════════════════════════════════════════════════════════════════
  const LN   = "K s_ l_ 10 + k .6931471805599453094172321214581765680755001343602552 sl sx 0 sn lx sm [lm 2 / sm ln 1 + sn 2 lm >D] sD 2 lm >D [lm 2 / sm ln 1 + sn] sB lm 2 =B [lm 2 * sm ln 1 - sn lm 1 >U] sU lm 1 >U lm 1 - lm 1 + / sy ly st ly sa 1 si [ly ly * lt * st la lt li 2 + / + sa li 2 + si lt 0 !=Z] sZ lZ x la 2 * ln ll * + l_ k 1 /";
  const LG   = "K s_ l_ 10 + k 2.3025850929940456840179914546843642076011 sT .6931471805599453094172321214581765680755001343602552 sl sx 0 sn lx sm [lm 2 / sm ln 1 + sn 2 lm >D] sD 2 lm >D [lm 2 / sm ln 1 + sn] sB lm 2 =B [lm 2 * sm ln 1 - sn lm 1 >U] sU lm 1 >U lm 1 - lm 1 + / sy ly st ly sa 1 si [ly ly * lt * st la lt li 2 + / + sa li 2 + si lt 0 !=Z] sZ lZ x la 2 * ln ll * + l_ k lT /";
  const EXP  = "K s_ l_ 10 + k sx 1 st 1 sa 1 si [lx lt * li / st la lt + sa li 1 + si lt 0 !=Y] sY lY x l_ k la 1 /";
  const TEN_X= "K s_ [1 sN 0 lX - sX] sG [1 lR / sR] sV [lF 2.3025850929940456840179914546843642076011 * sx 1 st 1 si [lx lt * li / st la lt + sa li 1 + si lt 0 !=L] sL lL x] sT [lR 1 / sR] sD 0 sN sX lX 0 >G 0 k lX 1 / sI l_ 10 + k lX lI - sF 10 lI ^ sM 1 sa 0 lF !=T la lM * sR 1 lN =V l_ k 0 lN !=D 0 lF !=D lR";
  const GAMMA = "K s_ l_ 30 + k [.6931471805599453094172321214581765680755001343602552 sl sx 0 sn lx sm [lm 2 / sm ln 1 + sn 2 lm >D] sD 2 lm >D [lm 2 / sm ln 1 + sn] sB lm 2 =B [lm 2 * sm ln 1 - sn lm 1 >U] sU lm 1 >U lm 1 - lm 1 + / sy ly st ly sa 1 si [ly ly * lt * st la lt li 2 + / + sa li 2 + si lt 0 !=Z] sZ lZ x la 2 * ln ll * +] sL [sx 1 st 1 sa 1 si [lx lt * li / st la lt + sa li 1 + si lt 0 !=Y] sY lY x la] sE [3.14159265358979323846264338327950288419716939937510 sp lp 2 * sw sr lr sr [lr lw - sr lw lr >W] sW lw lr >W [lr lw + sr lr 0 >X] sX lr 0 >X [lr lw - sr] sV lp lr >V lr st lr sa 1 si [lr lr * lt * _1 * li 2 * li 2 * 1 + * / st la lt + sa li 1 + si lt 0 !=K] sK lK x la] sS 0.91893853320467274178032973640561763986139747363778341 sg 3.14159265358979323846264338327950288419716939937510 sh [sz 1 lz / se le le * sf le 12 / sj le lf * se lj le 360 / - sj le lf * se lj le 1260 / + sj le lf * se lj le 1680 / - sj le lf * se lj le 1188 / + sj le lf * se lj 691 le * 360360 / - sj le lf * se lj le 156 / + sj le lf * se lj 3617 le * 122400 / - sj lz .5 - lz lLx * lz - lg + lj +] sT [lz lb + lLx lc + sc lb 1 + sb 20 lz lb + <R] sR [lh lz * sv 1 lz - lMx lv lSx * lh r / q] sN [lw lj * sw lj 1 - sj lj 1 <I] sI [lz 1 - sj 1 sw lj 1 <I lw q] sW [sz 0 lz !>N lz X 0 =W 0 sc 0 sb 20 lz lb + <R lz lb + lTx lc - lEx] sM lMx l_ k 1 /";
  const JN = "K s_ l_ 10 + k sx sn lx 2 / sh 1 st 0 si [li 1 + si lh lt * li / st li ln >B] sB li ln >B lt sa 0 sm ln 30 + sc [ lm 1 + sj lh lh * lt * _1 * lj lj ln + * / st la lt + sa lj sm lm lc >L ] sL lL x la l_ k 1 /";
  const SIN  = "K s_ l_ 10 + k 3.14159265358979323846264338327950288419716939937510 sp lp 2 * sw sr lr sr [lr lw - sr lw lr >W] sW lw lr >W [lr lw + sr lr 0 >X] sX lr 0 >X [lr lw - sr] sV lp lr >V lr st lr sa 1 si [lr lr * lt * _1 * li 2 * li 2 * 1 + * / st la lt + sa li 1 + si lt 0 !=K] sK lK x l_ k la 1 /";
  const COS = "K s_ l_ 10 + k 3.14159265358979323846264338327950288419716939937510 sp lp 2 * sw sr lr sr [lr lw - sr lw lr >R] sR lw lr >R [lr lw + sr lr 0 >P] sP lr 0 >P [lr lw - sr] sA lp lr >A 1 st 1 sa 1 si [lr lr * lt * _1 * li 2 * 1 - li 2 * * / st la lt + sa li 1 + si lt 0 !=L] sL lL x l_ k la 1 /";
  const TAN = "K s_ l_ 10 + k 3.14159265358979323846264338327950288419716939937510 sp lp 2 * sw sr lr sr [lr lw - sr lw lr >R] sR lw lr >R [lr lw + sr lr 0 >P] sP lr 0 >P [lr lw - sr] sA lp lr >A lr st lr sa 1 si [lr lr * lt * _1 * li 2 * li 2 * 1 + * / st la lt + sa li 1 + si lt 0 !=L] sL lL x 1 st 1 sc 1 si [lr lr * lt * _1 * li 2 * 1 - li 2 * * / st lc lt + sc li 1 + si lt 0 !=M] sM lM x l_ k la lc /";
  const ASIN = "K s_ l_ 10 + k sx 3.14159265358979323846264338327950288419716939937510 sp [lp 2 / l_ k 1 /] s1 lx 1 =1 [lp 2 / _1 * l_ k 1 /] s2 _1 lx =2 [1 lx lx * - v lx r / sx 0 sn [_1 lx * sx 1 sn] sN lx 0 >N 0 sd [lx lx * 1 + v 1 + lx r / sx ld 1 + sd .5 lx >H] sH .5 lx >H lx st lx sa 1 si [lx lx * lt * _1 * st la lt li 2 + / + sa li 2 + si lt 0 !=L] sL lL x la 2 ld ^ * sa [_1 la * sa] sG ln 1 =G la l_ k 1 /] s3 lx lx * s4 l4 1 >3";
  const ACOS = "K s_ l_ 10 + k sx 3.14159265358979323846264338327950288419716939937510 sp [0 l_ k] s1 lx 1 =1 [lp l_ k 1 /] s2 _1 lx =2 [1 lx lx * - v lx r / sx 0 sn [_1 lx * sx 1 sn] sN lx 0 >N 0 sd [lx lx * 1 + v 1 + lx r / sx ld 1 + sd .5 lx >H] sH .5 lx >H lx st lx sa 1 si [lx lx * lt * _1 * st la lt li 2 + / + sa li 2 + si lt 0 !=L] sL lL x la 2 ld ^ * sa [_1 la * sa] sG ln 1 =G la lp 2 / r - l_ k 1 /] s3 lx lx * s4 l4 1 >3";
  const ATAN = "K s_ l_ 10 + k sx 0 sn [_1 lx * sx 1 sn] sN lx 0 >N 0 sd [lx lx * 1 + v 1 + lx r / sx ld 1 + sd .5 lx >H] sH .5 lx >H lx st lx sa 1 si [lx lx * lt * _1 * st la lt li 2 + / + sa li 2 + si lt 0 !=L] sL lL x la 2 ld ^ * sa [_1 la * sa] sG ln 1 =G la l_ k 1 /";
  const GCD  = "[d Sr % Lr r d 0!=g] sg Ks_0k lgx R l_k";
  const LCM  = "[d Sa r d Sb * Lb La lg x R /] sl Ks_0k llx l_k";
  const PF   = "K s_ 0k[n =]sp[lfd lp [ ] & r & sp /dlf%0=Fdvsr]sF[dsf]sJdvsr2sf[dlf%0=Flfdd2%+1+sflr<Jd1<M]dsMx R lp l_k";
  const TO_JULIAN = "K s_ [ 0 k d 10000 / sy d 100 / ly 100 * - sm ly 10000 * lm 100 * + - sd 14 lm - 12 / sa ly 4800 + la - sb lm 12 la * + 3 - sc ld 153 lc * 2 + 5 / + 365 lb * + lb 4 / + lb 100 / - lb 400 / + 32045 - ] sJ"; 
  const DELTA_DAYS = TO_JULIAN + " 0 k lJ x r lJ x r r - l_ k";
  const DATE_PLUS  = TO_JULIAN + " [ 0 k sN lN 68569 + sA 4 lA * 146097 / sB 146097 lB * 3 + 4 / lA r - sA 4000 lA 1 + * 1461001 / sC 1461 lC * 4 / lA r - 31 + sA 80 lA * 2447 / sD 2447 lD * 80 / lA r - sG lD 11 / sA lD 2 + 12 lA * - sH 100 lB 49 - * lC + lA + sI lI 10000 * lH 100 * + lG + ] sF sN lJ x lN + lF x l_ k";
  const DELTA_YMD  = "K s_ 0 k sT sB lB d 10000 / sr lB d 100 / lr 100 * - sn lr 10000 * ln 100 * + - sb lT d 10000 / sR lT d 100 / lR 100 * - sN lR 10000 * lN 100 * + - sD lR lr - sa lN ln - se lD lb - sf [ lR 10000 * lN 100 * + 1 + d 10000 / sY d 100 / lY 100 * - sX lY 10000 * lX 100 * + - sU 14 lX - 12 / sP lY 4800 + lP - sQ lX 12 lP * + 3 - sV lU 153 lV * 2 + 5 / + 365 lQ * + lQ 4 / + lQ 100 / - lQ 400 / + 32045 - 1 - sZ lZ 68569 + sP 4 lP * 146097 / sQ 146097 lQ * 3 + 4 / lP r - sP 4000 lP 1 + * 1461001 / sU 1461 lU * 4 / lP r - 31 + sP 80 lP * 2447 / sV 2447 lV * 80 / lP r - sX lf lX + sf le 1 - se ] sW lf 0 >W [ le 12 + se la 1 - sa ] sK le 0 >K R R la [y ] & le & [m ] & lf & [d] & l_ k";
  const YHAT = "K s_ sx l_ 10 + k l5 l0 * l6 l7 * - l5 l8 * l6 d * - / sm l7 lm l6 * - l5 / sb lm lx * lb + l_ k 1 /";
  const CORR = "K s_ l_ 10 + k l5 l0 * l6 l7 * - sn l5 l8 * l6 d * - su l5 l9 * l7 d * - sv lu lv * v sd ln ld / l_ k 1 /";  
  const ROLLDOWN = "[ sn 1 si [li :R li 1 + si ln 1 + li <P] sP lP x 1 ;R ln si [li ;R li 1 - si 1 li >Q] sQ lQ x ] sD z lD x";
  const ROLLUP   = "[sn 1 si [li :R li 1 + si ln 1 + li <P] sP lP x ln 1 - si [li ;R li 1 - si 0 li >Q] sQ lQ x ln ;R ] sU z lU x";  
  const TOPOLAR = "K s_ l_ 10 + k sb sc 3.14159265358979323846264338327950288419716939937510 sp [ [ lr ] sC [ lr _1 * ] sD [ lp lr - ] sE [ lr lp - ] sF [ 0 lc >C 0 lc !>D] sA [ 0 lc >E 0 lc !>F] sB 0 lb >A 0 lb !>B ] sQ [d 0 >Z] sX [_1 *] sZ [sx 0 sn [_1 lx * sx 1 sn] sN lx 0 >N 0 sd [lx lx * 1 + v 1 + lx r / sx ld 1 + sd .5 lx >H] sH .5 lx >H lx st lx sa 1 si [lx lx * lt * _1 * st la lt li 2 + / + sa li 2 + si lt 0 !=L] sL lL x la 2 ld ^ * sa [_1 la * sa] sG ln 1 =G la] sT lc lb / lX x lT x sr lQ x lb lb * lc lc * + v l_ k 1/ r 1/ r";  
  const TOREC = "K s_ l_ 10 + k sy sx 3.14159265358979323846264338327950288419716939937510 sp lp 2 * sw lx sr [lr lw - sr lw lr >W] sW lw lr >W [lr lw + sr lr 0 >X] sX lr 0 >X [lr lw - sr] sV lp lr >V [lr st lr sa 1 si [lr lr * lt * _1 * li 2 * li 2 * 1 + * / st la lt + sa li 1 + si lt 0 !=K] sK lK x la] sS [1 st 1 sa 1 si [lr lr * lt * _1 * li 2 * 1 - li 2 * * / st la lt + sa li 1 + si lt 0 !=L] sL lL x la] sC lS x ly * lC x ly * l_ k 1/ r 1/ r";
  const NOT = "[K s_ 0 k sA 1 sS 0 sR [1 lA 2 % - lS * lR + sR lA 2 / sA lS 2 * sS lA 0 <M] d sM x l_ k lR] sn ln x";
  const AND = "[K s_ 0 k sB sA 1 sS 0 sR [lA 2 % lB 2 % * lS * lR + sR lA 2 / sA lB 2 / sB lS 2 * sS lA lB + 0 <M] d sM x l_ k lR] sa la x";
  const OR = "[K s_ 0 k sB sA 1 sS 0 sR [lA 2 % lB 2 % + lA 2 % lB 2 % * - lS * lR + sR lA 2 / sA lB 2 / sB lS 2 * sS lA lB + 0 <M] d sM x l_ k lR ] so lo x";
  const XOR = "[K s_ 0 k sB sA 1 sS 0 sR [lA 2 % lB 2 % + 2 % lS * lR + sR lA 2 / sA lB 2 / sB lS 2 * sS lA lB + 0 <M] d sM x l_ k lR] sx lx x";
  const ABC = "K s_ sx lx 0 k 1 / 40 k sa 0 sS 1 su 1 sV 0 sQ la lu * lS + sv la lQ * lV + sW lx la - sr [ 1 lr / d 0 k 1 / 40 k sa sy lu lv su sS lQ lW sQ sV la lu * lS + sv la lQ * lV + sW ly la - sr ] sG [ lG x lv lW / sf lx lf - d * 0.000000000001 <M ] sM [ 32a ] sY [ lv lW / [ ] & ] sZ lr 0.0000000001 <M 0 k lv lW / 0 !=Z lv lW / 0 =Y lv lW % & [/] & lW & l_ k";
  const NTHROOT = "K s_ sR sX l_ 10 + k lX .6931471805599453094172321214581765680755001343602552 sl sx 0 sn lx sm [lm 2 / sm ln 1 + sn 2 lm >D] sD 2 lm >D [lm 2 / sm ln 1 + sn] sB lm 2 =B [lm 2 * sm ln 1 - sn lm 1 >U] sU lm 1 >U lm 1 - lm 1 + / sy ly st ly sa 1 si [ly ly * lt * st la lt li 2 + / + sa li 2 + si lt 0 !=Z] sZ lZ x la 2 * ln ll * + 1 / lR / sx 1 st 1 sa 1 si [lx lt * li / st la lt + sa li 1 + si lt 0 !=Y] sY lY x la 1 / sW lW sL 0 sF 0 sS [ 10 lS ^ sT lW lT * sU lU 0.5 - 0 k 1 / l_ 10 + k sV [lU 0.5 + 0 k 1 / l_ 10 + k sV] sP 0 lU >P lV lT / lS k 1 / sC l_ 10 + k lR d 0 k 1 / l_ 10 + k r - sJ [ lC lR ^ lX - sE lE 0 =G ] sH [ lC sL 1 sF ] sG lJ 0 =H [ lC sL 1 sF ] sG 0.0000000000000000000001 lW lC - d * <G lS 1 + sS lF 0 =Q 15 lS >Q ] sQ lF 0 =Q 15 lS >Q lL l_ k 1 /";
  const PI = "3.14159265358979323846264338327950288419716939937510 1/";
  const FLOOR = "K s_ sx 0 k lx 1 / st lx lt - sr [ lt 1 - st ] sM lr 0 >M lt l_ k";
  const CEIL  = "K s_ sx 0 k lx 1 / st lx lt - sr [ lt 1 + st ] sM lr 0 <M lt l_ k";
  const PERCENT = "[ sx d sy lx ly * 100 / ] sP lP x";
  const SINH = EXP + " se le 1 le / - 2 /"; // sinh(x) = (e^x - 1/e^x) / 2
  const COSH = EXP + " se le 1 le / + 2 /"; // cosh(x) = (e^x + 1/e^x) / 2
  const TANH = EXP + " se 1 le / sf le lf - le lf + /"; // tanh(x) = (e^x - 1/e^x) / (e^x + 1/e^x)
  const ASINH = "d d * 1 + v + " + LN; // asinh(x) = ln(x + sqrt(x^2 + 1))
  const ACOSH = "d d * 1 - v + " + LN; // acosh(x) = ln(x + sqrt(x^2 - 1))
  const ATANH = "d 1 + r 1 r - / " + LN + " 2 /"; // atanh(x) = 1/2 * ln((1 + x) / (1 - x))
  const COMB = "Ks_0k[lr ln * li / sr ln 1 - sn li 1 + si li lk 1 + >c] sc [sk sn 1 sr 1 si li lk 1 + >c lr] sC lC x l_k";
  const PERM = "Ks_0k[lr ln * sr ln 1 - sn lk 1 - sk 0 lk >p] sp [sk sn 1 sr 0 lk >p lr] sP lP x l_k";
  const D2R = "3.14159265358979323846264338327950288419716939937510 * 180 /";
  const R2D = "180 * 3.14159265358979323846264338327950288419716939937510 /";
  const YBAR = "K s_ l_ 10 + k l7 l5 / l_ k 1 /";  
  const MEDIAN = "1 sI lI lN >M [ lN 2 / ;a ] sA [ lN 2 / 1 - ;a lN 2 / ;a + 2 k 2 / 0 k ] sB [ lN 2 % 1 =A lN 2 % 0 =B ] sY lY x";
  const MODE = "1 sI lI lN >M [ lA 1 + sA ] sU [ 1 sA lX sP ] sR [ lA sY lP sV ] sZ [ lT ;a sX lX lP =U lX lP !=R lY lA >Z lT 1 + sT lT lN >B ] sB [ 0 ;a sP lP sV 1 sA 1 sY 1 sT lT lN >B lV ] sX lX x";
  const POPULATION = "K s_ l_ 10 + k l8 l6 d * l5 / - l5 / v l_ k 1 /";
  const SIGMA_PLUS = "[ 0 ] sA sx l= 0 =A sy lx l5 :a ly l5 :b l5 1 + s5 l5 sN l6 lx + s6 l7 ly + s7 l8 lx d * + s8 l9 ly d * + s9 l0 lx ly * + s0";
  const SIGMA_MINUS = "[ 0 ] sA sx l= 0 =A sy 0 si 0 sj 0 sf [li ;b ly =F] sM [lf 0 =G] sF [li sj 1 sf] sG [li ;a lx =M li 1 + si lN li <L] sL lN 0 <L [lj sk [lk 1 + ;a lk :a lk 1 + ;b lk :b lk 1 + sk lN 1 - lk <K] sK lN 1 - lj <K l5 1 - s5 l5 sN l6 lx - s6 l7 ly - s7 l8 lx d * - s8 l9 ly d * - s9 l0 lx ly * - s0] sH lf 1 =H"; 
  const FACTORIAL = "[d1-d1<F*]dsFx";
  // ── Initial Render ───────────────────────────────────────────────────
  render();

})();
