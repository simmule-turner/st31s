// ═══════════════════════════════════════════════════════════════════════ //
//  DC Calculator UI                                                       //
// ═══════════════════════════════════════════════════════════════════════ //

(function () {
"use strict";

// ── Persistence ───────────────────────────────────────────────────────
const STORE_KEY_CALC   = "dc-calc-state";
const STORE_KEY_DIRECT = "dc-direct-state";

function loadState(key, fallback) {
    try {
        const r = localStorage.getItem(key);
        return r ? JSON.parse(r) : fallback;
    } catch {
        return fallback;
    }
}

function persist(key, s) {
    try {
        localStorage.setItem(key, JSON.stringify(s));
    } catch {}
}

// Convenience wrappers: every call site that persists the main calculator
// or the Direct Console used to spell out the same shape by hand (and had
// drifted slightly in a couple of spots). Keep the shape in one place.
function persistCalc() {
    persist(STORE_KEY_CALC, {
        dcState: calcState.dcState,
        lastx: calcState.lastx,
        output: calcState.output,
        liftEnabled: calcState.liftEnabled
    });
}
function persistDirect() {
    persist(STORE_KEY_DIRECT, {
        dcState: directState.dcState,
        directInput: directState.directInput
    });
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
function isDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
}
initTheme();

// Prevent document/PWA body scrolling and rubber-banding on iOS.
// index.html's own CSS already sets overflow:hidden on html/body for the
// same reason; this duplicates that here and adds `position: fixed`, which
// is the piece Safari actually needs to stop the rubber-band bounce (plain
// overflow:hidden on body is not enough on iOS). Keep both: the CSS covers
// first paint before this script runs, this covers what CSS alone can't.
document.documentElement.style.cssText = "overflow: hidden; height: 100%; width: 100%; position: fixed; overscroll-behavior: none;";
document.body.style.cssText = "overflow: hidden; height: 100%; width: 100%; position: fixed; overscroll-behavior: none; margin: 0; padding: 0;";

// Intercept and block document-level touch moves unless touching a scrollable element
document.addEventListener('touchmove', function (e) {
    let target = e.target;
    let isScrollable = false;
    
    while (target && target !== document.body) {
        const style = window.getComputedStyle(target);
        const overflowY = style.getPropertyValue('overflow-y');
        const overflow = style.getPropertyValue('overflow');
        
        if ((overflowY === 'auto' || overflowY === 'scroll' || overflow === 'auto' || overflow === 'scroll') && target.scrollHeight > target.clientHeight) {
            isScrollable = true;
            break;
        }
        target = target.parentElement;
    }
    
    if (!isScrollable) {
        e.preventDefault();
    }
}, { passive: false });

// ── 1. Calculator State & Engine (Completely Decoupled) ─────────────
const _pc = loadState(STORE_KEY_CALC, {});
const calcState = {
    input:       "",
    shift:       false,
    shiftBlue:   false,
    output:      _pc.output  || "0",
    lastx:       _pc.lastx   || "0",
    dcState:     _pc.dcState || { stack: ["0","0","0","0"], config: { i: 10, o: 10, k: 0 } },
    liftEnabled: (typeof _pc.liftEnabled === "boolean") ? _pc.liftEnabled : true,
    openPopup:   null,
    popupDir:    "above",
};

const engine = new DCEngine({
    DCMath, 
    config: new Map(), 
    loadState: () => calcState.dcState, 
    saveState: (s) => {
        calcState.dcState = s;
        persistCalc();
    },
    log: () => {}, 
    id: "dc-calculator", 
});

// ── 2. Direct Console State & Engine (Completely Decoupled) ──────────
const _pd = loadState(STORE_KEY_DIRECT, {});
const directState = {
    directInput: _pd.directInput || "",
    dcState:     _pd.dcState     || { stack: [], config: { i: 10, o: 10, k: 0 }, registers: {} }
};

const directEngine = new DCEngine({
    DCMath, 
    config: new Map(), 
    loadState: () => directState.dcState, 
    saveState: (s) => {
        directState.dcState = s;
        persistDirect();
    },
    log: () => {}, 
    id: "direct-dc-engine", 
});

// ── Live DOM refs for lightweight updates ────────────────────────────
let xInputEl = null, tValEl = null, zValEl = null, yValEl = null, iokInfoEl = null, lastxBtnEl = null;

// ── DC execution helpers ──────────────────────────────────────────────
function runDC(input) {
    try {
        const result = engine.run(input, false) || " ";
        normalizeStack();
        calcState.output = result;
        persistCalc();
        return result;
    } catch (e) {
        calcState.output = "Error: " + e.toString();
        return calcState.output;
    }
}

function normalizeStack() {
    let s = Array.isArray(calcState.dcState.stack) ? calcState.dcState.stack.map(String) : [];
    if (s.length > 4) {
        s = s.slice(-4);
    } else if (s.length < 4) {
        const fill = s.length ? s[0] : "0";
        while (s.length < 4) s.unshift(fill);
    }
    calcState.dcState.stack = s;
}

function wrapBtnMacro(cmd, print) {
    const cur = calcState.input.trim();
    let prefix = "";
    if (cur) prefix = (calcState.liftEnabled ? "" : "R ") + cur + " ";
    const suffix = (print !== false) ? " p" : "";
    return prefix + cmd + suffix + " 1s=";
}

function doEnter() {
    if (!calcState.input.trim()) {
        calcState.liftEnabled = false;
        runDC("d p 1s=");
    } else {
        const prefix = calcState.liftEnabled ? "" : "R ";
        const wrapped = prefix + calcState.input.trim() + " d p 1s=";
        calcState.liftEnabled = false;
        runDC(wrapped);
        calcState.input = "";
    }
    refreshAfterCalc();
}

function doIns(char) {
    if (calcState.liftEnabled) {
        captureLastX();
        runDC("d 0s=");
        calcState.input = "";
        calcState.liftEnabled = false;
        refreshAfterCalc();
    }
    calcState.input += char;
    refreshIO();
}

function recallLastX() {
    calcState.input = "";
    runDC("R " + calcState.lastx + " p 1s=");
    calcState.liftEnabled = true;
    refreshAfterCalc();
}

function doFunc(cmd, print) {
    captureLastX();
    const wrapped = wrapBtnMacro(cmd, print);
    calcState.liftEnabled = true;
    runDC(wrapped);
    calcState.input = "";
    refreshAfterCalc();
}

function captureLastX() {
    const cur = calcState.input.trim();
    if (cur) {
        calcState.lastx = cur;
    } else {
        const stk = calcState.dcState.stack || [];
        calcState.lastx = stk.length ? String(stk[stk.length - 1]) : "0";
    }
    persistCalc();
}

// ── Popup management ─────────────────────────────────────────────────
function togglePopup(id, triggerEl) {
    if (calcState.openPopup === id) {
        calcState.openPopup = null;
    } else {
        calcState.openPopup = id;
        if (triggerEl) {
            const rect = triggerEl.getBoundingClientRect();
            const itemCount = {conv: 6, more: 5, stat: 6, clear: 3}[id] ?? 6;
            const estimatedH = itemCount * 44 + 8;
            calcState.popupDir = rect.top >= estimatedH ? "above" : "below";
        } else {
            calcState.popupDir = "below";
        }
    }
    render();
}

function closePopup() {
    if (calcState.openPopup) {
        calcState.openPopup = null;
        render();
    }
}

document.addEventListener("click", e => {
    if (calcState.openPopup && !e.target.closest(".pop-wrap")) closePopup();
});

for (const evt of ["copy", "cut", "paste"]) {
    document.addEventListener(evt, e => {
        if (e.target.closest("button") || e.target.closest(".iok-info")) e.preventDefault();
    });
}

// ── dc state accessors ────────────────────────────────────────────────
function cfg(key) { return calcState.dcState.config?.[key] ?? ""; }
function stackAt(offset) {
    const s = calcState.dcState.stack || [];
    const i = s.length - 1 - offset;
    return i >= 0 ? String(s[i]) : "0";
}
function registers() { return calcState.dcState.registers || {}; }

// ═══════════════════════════════════════════════════════════════════ //
//  RENDER                                                             //
// ═══════════════════════════════════════════════════════════════════ //

function render() {
    const app = document.getElementById("app");
    app.innerHTML = "";
    app.appendChild(buildStackPanel());
    app.appendChild(buildDirectDcPanel());
    app.appendChild(buildToolbar());
    app.appendChild(buildGrid6());
    app.appendChild(buildGrid5());
    ensureDetailOverlay();
}

// ── Lightweight refresh ──────────────────────────────────────────────
function refreshIO() {
    if (xInputEl) {
        xInputEl.value = calcState.input || calcState.output;
        scrollXToEnd(xInputEl);
    }
    if (tValEl) tValEl.textContent = stackAt(3);
    if (zValEl) zValEl.textContent = stackAt(2);
    if (yValEl) yValEl.textContent = stackAt(1);
    if (lastxBtnEl) lastxBtnEl.title = "Recall lastx: " + calcState.lastx;
}

function refreshAfterCalc() {
    refreshIO();
    if (iokInfoEl) iokInfoEl.innerHTML = `<span><b>i:</b> ${esc(String(cfg("i")))}</span><span> <b>o:</b> ${esc(String(cfg("o")))}</span><span> <b>k:</b> ${esc(String(cfg("k")))}</span>`;
}

// ── Stack panel (T/Z/Y/X) ────────────────────────────────────────────
function buildStackPanel() {
    const wrap = el("div", "stack-panel");
    wrap.style.cssText = "margin-bottom: 1px;";
    const makeRow = (label, offset) => {
        const row = el("div", "stack-row");
        const lbl = el("span", "stack-label");
        lbl.textContent = label;
        const val = el("span", "stack-value");
        val.textContent = stackAt(offset);
        row.appendChild(lbl);
        row.appendChild(val);
        wrap.appendChild(row);
        return val;
    };
    tValEl = makeRow("T", 3);
    zValEl = makeRow("Z", 2);
    yValEl = makeRow("Y", 1);

    const xRow = el("div", "stack-row x-row");
    const xLbl = el("span", "stack-label");
    xLbl.textContent = "X";
    const xInp = document.createElement("input");
    xInp.type = "text";
    xInp.value = calcState.input || calcState.output;
    xInp.placeholder = "0";
    xInp.readOnly = true;
    xInp.addEventListener("focus", () => {
        xInp.readOnly = false;
        if (!calcState.input) {
            xInp.select();
        }
    });
    xInp.addEventListener("blur",  () => {
        xInp.readOnly = true;
        refreshIO();
    });
    xInp.addEventListener("input",   e => {
        calcState.input = e.target.value;
    });
    xInp.addEventListener("keydown", e => {
        if (e.key === "Enter") doEnter();
    });
    xRow.appendChild(xLbl);
    xRow.appendChild(xInp);
    wrap.appendChild(xRow);
    xInputEl = xInp;
    scrollXToEnd(xInp);
    return wrap;
}

// ── Unified Direct DC Console Panel (Decoupled & Theme-Aware) ────────
// buildDirectDcPanel() runs on every full render() (e.g. after every SHIFT
// keypress, which calls render() to clear the shift layer) and used to
// re-fetch sw.js and reset the header label to "loading..." every single
// time, producing a visible flash while the fetch was in flight. The
// version lookup (and the update-available check it drives) only needs to
// happen once per page load, so its result is cached at module scope and
// reused by every subsequent render instead of being redone.
let _versionLabelCache = null;   // resolved "dc-calc-vNN" string, or null until the first fetch resolves
let _versionFetchStarted = false;

function buildDirectDcPanel() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const dark = isDark();

    // Hand-tuned per-platform offsets for the Direct Console panel.
    // iOS needs its own numbers because (a) env(safe-area-inset-bottom)
    // only exists on iOS (the home-indicator strip), so non-iOS gets 0px,
    // and (b) Safari's chrome (toolbar/URL bar showing or hidden) shifts
    // the visible layout in a way Chrome/Android doesn't, hence the
    // slightly different margin and starting textarea height below.
    // These are visual-fit values, not computed from anything measurable,
    // so verify them on a real iPhone/iPad and a real Android phone after
    // any change here — they can't be meaningfully checked in a headless test.
    const bottomMargin = isIOS ? "-23px" : "-17px";
    const baseTextareaHeight = isIOS ? "66px" : "88px";
    const extraPadding = isIOS ? "calc(env(safe-area-inset-bottom, 34px) + 6px)" : "0px";

    const wrap = el("div", "direct-dc-wrap");
    wrap.style.cssText = `margin: -17px 0px ${bottomMargin} 0px; padding-bottom: ${extraPadding}; display: flex; flex-direction: column; width: 100%; box-sizing: border-box; background: var(--panel-bg, inherit); color: var(--fg, inherit); position: relative; z-index: 2;`;

    const headerBar = document.createElement("div");
    headerBar.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: -2px 0 2px 0;
        padding: 0 2px;
        font-size: 11px;
        font-family: monospace;
        opacity: 0.85;
        white-space: nowrap;
    `;

    const titleSpan = document.createElement("span");
    titleSpan.className = "console-title-label";
    titleSpan.style.cssText = `
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
        flex: 1;
        margin-right: 8px;
    `;
    const cfgI = directState.dcState.config?.i ?? 10;
    const cfgO = directState.dcState.config?.o ?? 10;
    const cfgK = directState.dcState.config?.k ?? 0;
    titleSpan.textContent = `${_versionLabelCache || "loading..."} (i:${cfgI}, o:${cfgO}, k:${cfgK})`;

    const btnContainer = document.createElement("div");
    if (isIOS) {
    btnContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 3px;
        position: relative;
        top: -4px;
        left: 2px;
        z-index: 3;
        flex-shrink: 0;
    `;
    } else {
    btnContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 3px;
        position: relative;
        top: -3px;
        left: 1px;
        z-index: 3;
        flex-shrink: 0;
    `;
    }

    const makeMicroPillBtn = (text, onClick) => {
        const btn = document.createElement("button");
        btn.innerText = text;
        btn.type = "button";
        
        // Prevent buttons from stealing focus from the textarea
        const preventFocusLoss = (e) => {
            e.preventDefault();
        };
        btn.addEventListener("mousedown", preventFocusLoss);
        btn.addEventListener("pointerdown", preventFocusLoss);

        const btnBg = dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)";
        const btnColor = dark ? "#f0f0f0" : "inherit";
        const btnBorder = dark ? "#555555" : "#cccccc";

        btn.style.cssText = `
            margin: 0;
            padding: 2px 7px;
            min-height: 0;
            height: auto;
            font-size: 10px;
            font-family: inherit;
            line-height: 1.2;
            background: ${btnBg};
            color: ${btnColor};
            border: 1px solid ${btnBorder};
            border-radius: 0px;
            cursor: pointer;
            opacity: 0.85;
            white-space: nowrap;
            box-sizing: border-box;
        `;
        btn.addEventListener("mouseover", () => btn.style.opacity = "1");
        btn.addEventListener("mouseout", () => btn.style.opacity = "0.85");
        btn.addEventListener("click", (e) => {
            onClick(e);
        });
        return btn;
    };

    const copyTextBtn = makeMicroPillBtn("Copy Text", (e) => {
        e.preventDefault();
        const textToCopy = directInputEl.value;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(textToCopy).catch(() => {});
        } else {
            directInputEl.select();
            document.execCommand('copy');
        }
    });

    const clearTextBtn = makeMicroPillBtn("Clear", (e) => {
        e.preventDefault();
        directState.directInput = "";
        directInputEl.value = "";
        persistDirect();
    });

    btnContainer.appendChild(copyTextBtn);
    btnContainer.appendChild(clearTextBtn);

    headerBar.appendChild(titleSpan);
    headerBar.appendChild(btnContainer);
    wrap.appendChild(headerBar);

    const directInputEl = document.createElement("textarea");
    directInputEl.className = "direct-dc-textarea";
    directInputEl.setAttribute("autocapitalize", "none");
    directInputEl.setAttribute("autocorrect", "off");
    directInputEl.setAttribute("spellcheck", "false");
    directInputEl.placeholder = "Enter dc commands...";
    
    const textareaBg = dark ? "#1e1e1e" : "#ffffff";
    const textareaColor = dark ? "#f0f0f0" : "#000000";
    const textareaBorder = dark ? "#444444" : "#cccccc";

    directInputEl.style.cssText = `width: 100%; min-height: ${baseTextareaHeight}; font-family: monospace; font-size: 15px; padding: 6px 8px; box-sizing: border-box; resize: vertical; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; -webkit-appearance: none; -webkit-user-select: text; background: ${textareaBg}; color: ${textareaColor}; border: 1px solid ${textareaBorder}; border-radius: 4px;`;
    directInputEl.value = directState.directInput;
    wrap.appendChild(directInputEl);

    // Fetch and parse the active version for the header label, and check
    // for an update, but only on the FIRST render of this panel per page
    // load — not on every render() call (SHIFT keys trigger a full
    // render()). Once _versionLabelCache is set above, every later render
    // reuses it immediately with no fetch and no "loading..." flash.
    if (!_versionFetchStarted) {
        _versionFetchStarted = true;
        fetch('./sw.js?_=' + Date.now())
            .then(res => res.text())
            .then(scriptText => {
                const match = scriptText.match(/const\s+CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
                if (match && match[1]) {
                    const activeVersion = match[1];
                    _versionLabelCache = activeVersion;
                    const cI = directState.dcState.config?.i ?? 10;
                    const cO = directState.dcState.config?.o ?? 10;
                    const cK = directState.dcState.config?.k ?? 0;
                    titleSpan.textContent = `${activeVersion} (i:${cI}, o:${cO}, k:${cK})`;

                    const STORAGE_KEY_VERSION = "dc_active_version";
                    const lastSeenVersion = localStorage.getItem(STORAGE_KEY_VERSION);

                    if (lastSeenVersion && lastSeenVersion !== activeVersion) {
                        setTimeout(() => {
                            if (confirm(`A new version (${activeVersion}) of the DC Calculator is available! Click OK to update and reload.`)) {
                                localStorage.setItem(STORAGE_KEY_VERSION, activeVersion);
                                if ('caches' in window) {
                                    caches.keys().then(names => names.forEach(name => caches.delete(name)));
                                }
                                window.location.reload(true);
                            }
                        }, 500);
                    } else if (!lastSeenVersion) {
                        localStorage.setItem(STORAGE_KEY_VERSION, activeVersion);
                    }
                }
            })
            .catch(() => {
                _versionLabelCache = "dc-calc";
                const cI = directState.dcState.config?.i ?? 10;
                const cO = directState.dcState.config?.o ?? 10;
                const cK = directState.dcState.config?.k ?? 0;
                titleSpan.textContent = `dc-calc (i:${cI}, o:${cO}, k:${cK})`;
            });
    }

    // Dynamically expand downward when focused
    const updateExpandedHeight = () => {
        const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        const windowHeight = window.innerHeight;

        if (viewportHeight >= windowHeight * 0.85 || document.activeElement !== directInputEl) {
            directInputEl.style.height = baseTextareaHeight;
            return;
        }

        const rect = directInputEl.getBoundingClientRect();
        const availableSpace = viewportHeight - rect.top - 20; 
        if (availableSpace > 80) {
            directInputEl.style.height = `${availableSpace}px`;
        }
    };

    directInputEl.addEventListener("focus", () => {
        setTimeout(updateExpandedHeight, 100);
    });

    directInputEl.addEventListener("blur", () => {
        setTimeout(() => {
            if (document.activeElement === directInputEl) return;
            directInputEl.style.height = baseTextareaHeight;
        }, 150);
    });

    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", updateExpandedHeight);
    }

    // Track whether we are currently processing an enter/newline to prevent re-entrancy
    let isProcessingLine = false;

    directInputEl.addEventListener("input", e => {
        if (e.inputType === "insertLineBreak" && !isProcessingLine) {
            isProcessingLine = true;
            
            const fullText = directInputEl.value;
            const lines = fullText.split("\n");
            
            let line = "";
            if (lines.length >= 2) {
                line = lines[lines.length - 2].trim();
            }

            let result = "";
            if (line) {
                try {
                    result = directEngine.run(line) || "";
                } catch (err) {
                    result = "Error: " + err.toString();
                }
            }

            let baseContent = lines.slice(0, lines.length - 2).join("\n");
            if (baseContent) baseContent += "\n";

            let newText = baseContent + line;
            if (result.trim() !== "") {
                newText += "\n" + result;
            }
            newText += "\n";

            directState.directInput = newText;
            directInputEl.value = directState.directInput;
            persistDirect();

            directInputEl.focus();
            directInputEl.selectionStart = directInputEl.value.length;
            directInputEl.selectionEnd = directInputEl.value.length;
            directInputEl.scrollTop = directInputEl.scrollHeight;
            
            isProcessingLine = false;
            return;
        }

        directState.directInput = e.target.value;
        persistDirect();
    });

    setTimeout(() => {
        directInputEl.scrollTop = directInputEl.scrollHeight;
    }, 0);

    return wrap;
}

function scrollXToEnd(inputEl) {
    if (!inputEl) return;
    inputEl.scrollLeft = inputEl.scrollWidth;
}

// ── Toolbar ────────────────────────────────────────────────────────
  function buildToolbar() {
    const bar = el("div", "toolbar");
    bar.style.cssText = "margin-top: 1px;";
    const left = el("div", "tb-left");
    left.appendChild(dualPopupKey("util", "▼", { run: () => { showDetailPopup(); } }, "clear", "clear", [
        ["CLALL", () => {
            calcState.dcState = { stack: ["0","0","0","0"], config: { i: 10, o: 10, k: 0 } };
            calcState.output = "0";
            calcState.lastx = "0";
            calcState.input = "";
            calcState.liftEnabled = true;
            directState.directInput = "";
            directState.dcState = { stack: [], config: { i: 10, o: 10, k: 0 }, registers: {} };
            localStorage.removeItem(STORE_KEY_CALC);
            localStorage.removeItem(STORE_KEY_DIRECT);
            render();
        }],
        ["CL\u03A3", "0 s5 0 s6 0 s7 0 s8 0 s9 0 s0 0sa La 0sb Lb R R 1s= [ lJ 1 - ;a lJ :a lJ 1 - sJ lL x ] sS [ lK lJ 1 - ;a >S ] sC [ 0 lJ >C ] sL [ lI ;a sK lI sJ lL x lK lJ :a lI 1 + sI lI lN >M ] sM", true],
        ["CLSTK", "c 0 0 0 0", true]
    ]));

    const shiftSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 35" width="100%" height="100%" fill="currentColor">
            <path d="M 42,33 L 32,33 L 32,17 L 18,17 L 18,24 L 2,13 L 18,2 L 18,9 L 42,9 Z" stroke-width="0.5" stroke-linejoin="miter"/>
        </svg>
    `;
    const shiftSvgBlueRight = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 35" width="100%" height="100%" fill="currentColor">
            <path d="M 2,33 L 12,33 L 12,17 L 26,17 L 26,24 L 42,13 L 26,2 L 26,9 L 2,9 Z" stroke-width="0.5" stroke-linejoin="miter"/>
        </svg>
    `;

    const shCell = dualBtn(calcState.shift ? "shift-on shift-key" : "util shift-key", { label: shiftSvg, run: () => { calcState.shift = !calcState.shift; calcState.shiftBlue = false; render(); } }, null, null, true);
    left.appendChild(shCell);

    const shBlueCell = dualBtn(calcState.shiftBlue ? "shift-on shift-key" : "util shift-key", { label: shiftSvgBlueRight, run: () => { calcState.shiftBlue = !calcState.shiftBlue; calcState.shift = false; render(); } }, null, null, true);
    shBlueCell.querySelector("button").style.color = "#0066cc";
    left.appendChild(shBlueCell);

    bar.appendChild(left);

    const right = el("div", "tb-right");
    const iokSpan = el("span", "iok-info");
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
    return `${yyyy}${mm}${dd}`;
}

function getDow() {
    const isoDate = xInputEl.value;
    if (typeof isoDate !== 'string' || isoDate.length !== 8) {
        return `R [${isoDate} must be in YYYYMMDD format.]`;
    }
    const year = parseInt(isoDate.substring(0, 4), 10);
    const month = parseInt(isoDate.substring(4, 6), 10) - 1;
    const day = parseInt(isoDate.substring(6, 8), 10);
    const dateObj = new Date(year, month, day);
    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return "R [" + daysOfWeek[dateObj.getDay()] + "]";
}

// ── 6-column grid (rows 1–3) ────────────────────────────────────────
function buildGrid6() {
    const g = el("div", "grid6");

    // Row 1
    g.appendChild(dualBtn("func", withLabel("\u221Ax", runFunc("v")), withLabel("\u2192pol", runFunc(TOPOLAR)), null, false, withLabel("nCr", runFunc(COMB))));
    g.appendChild(dualBtn("func", withLabel("x\u00B2", runFunc("d *")), withLabel("\u2192rec", runFunc(TOREC)), null, false, withLabel("nPr", runFunc(PERM))));
    g.appendChild(dualBtn("func", withLabel("ln", runFunc(LN)), withLabel("lg", runFunc(LG)), null, false, withLabel("jn", runFunc(JN))));
    g.appendChild(dualBtn("func", withLabel("e\u02E3", runFunc(EXP)), withLabel("10\u02E3", runFunc(TEN_X)), null, false, withLabel("sinh", runFunc(SINH))));
    g.appendChild(dualBtn("func", withLabel("y\u02E3", runFunc("^")), withLabel("x!", runFunc(GAMMA)), null, false, withLabel("cosh", runFunc(COSH))));
    g.appendChild(dualBtn("func", withLabel("1/x", runFunc("1r/")), withLabel("\u0394%", runFunc("s_ l_ - l_ / 100 *")), null, false, withLabel("tanh", runFunc(TANH))));

    // Row 2
    g.appendChild(dualBtn("func", withLabel("\u0394days", runFunc(DELTA_DAYS)), withLabel("date+", runFunc(DATE_PLUS)), null, false, withLabel("\u0394ymd", runFunc(DELTA_YMD))));
    g.appendChild(dualPopupKey("func", "t &#x1D58;/&#x1D65;", runFunc(ABC), "const", "const", [
        ["c", "299792458", "2.997e8 m/s, Speed of light"],
        ["h", "0.000000000000000000000000000000000662607015", "6.626e-34 J·s, Planck constant"],
        ["G", "0.0000000000667430", "6.674e-11 m³/kg·s², Gravitational constant"],
        ["N\u2090", "602214076000000000000000", "6.022e23 mol⁻¹, Avogadro's number"],
        ["R", "8.314462618", "8.314 J/mol·K, Universal gas constant"],
        ["k", "0.00000000000000000000001380649", "1.380e-23 J/K, Boltzmann constant"],
        ["q\u2091", "0.0000000000000000001602176634", "1.602e-19 C, Elementary charge"],
        ["\u03B5\u2080", "0.0000000000088541878128", "8.854e-12 F/m, Vacuum permittivity"],
        ["g", "9.80665", "9.807 m/s², Standard gravity"]
    ]));
    g.appendChild(dualPopupKey("func", "&#x02E3;\u221Ay", runFunc(NTHROOT), "stats", "stats", [
        ["n\u03A3", "l5"],
        ["\u03A3x", "l6"],
        ["\u03A3x\u00B2", "l8"],
        ["\u03A3xy", "l0"],
        ["\u03A3y", "l7"],
        ["\u03A3y\u00B2", "l9"],
    ]));
    g.appendChild(dualBtn("func", withLabel("sin", runFunc(SIN)), withLabel("sin\u207B\u00B9", runFunc(ASIN)), null, false, withLabel("sinh\u207B\u00B9", runFunc(ASINH))));
    g.appendChild(dualBtn("func", withLabel("cos", runFunc(COS)), withLabel("cos\u207B\u00B9", runFunc(ACOS)), null, false, withLabel("cosh\u207B\u00B9", runFunc(ACOSH))));
    g.appendChild(dualBtn("func", withLabel("tan", runFunc(TAN)), withLabel("tan\u207B\u00B9", runFunc(ATAN)), null, false, withLabel("tanh\u207B\u00B9", runFunc(ATANH))));

    // Row 3
    g.appendChild(dualBtn("util", withLabel("enter", { run: doEnter }), withLabel("iso-date", runFunc(getIsoDate())), "span2", false, withLabel("load", { run: async () => {
        const text = await loadFile();
        if (text !== "") { doFunc(text); }
    } })));
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
    g.appendChild(dualBtn("util bs-btn", withLabel("\u232B", { run: () => {
        calcState.input = calcState.input.slice(0, -1);
        refreshIO();
    } }), withLabel("dow", runFunc(getDow())), null, false, withLabel("rad\u279C\u00B0", runFunc(R2D))));

    return g;
}

// ── 5-column grid (rows 4–7) ────────────────────────────────────────
function buildGrid5() {
    const g = el("div", "grid5");
    function digit(ch) { return dualBtn("ins", withLabel(ch, runIns(ch)), null); }

    // Row 4
    g.appendChild(dualBtn("func", withLabel("%", runMacro(PERCENT)), withLabel("\u00AC", runMacro(NOT)), null, false, withLabel("\u00B0F\u279C\u00B0C", runFunc("32 - 5.00 * 9 /"))));
    g.appendChild(digit("7"));
    g.appendChild(digit("8"));
    g.appendChild(digit("9"));
    g.appendChild(dualBtn("func", withLabel("\u00F7", runFunc("/")), withLabel("x\u0304", runFunc("K sk 10 k l6 l5 / lk k")), null, false, withLabel("y\u0304", runFunc(YBAR))));

    // Row 5
    g.appendChild(dualBtn("func", withLabel("p", runMacro("p", false)), withLabel("\u2227", runMacro(AND, true)), null, false, withLabel("\u00B0C\u279C\u00B0F", runFunc("9 * 5.00 / 32 +"))));
    g.appendChild(digit("4"));
    g.appendChild(digit("5"));
    g.appendChild(digit("6"));
    g.appendChild(dualBtn("func", withLabel("\u00D7", runFunc("*")), withLabel("y\u0302", runFunc(YHAT)), null, false, withLabel("median", runFunc(MEDIAN))));

    // Row 6
    g.appendChild(dualBtn("func", withLabel("k", runMacro("k", true)), withLabel("\u2228", runMacro(OR, true)), null, false, withLabel("\u03C0", runFunc(PI))));
    g.appendChild(digit("1"));
    g.appendChild(digit("2"));
    g.appendChild(digit("3"));
    g.appendChild(dualBtn("func", withLabel("\u2013", runFunc("-")), withLabel("r", runFunc(CORR)), null, false, withLabel("mode", runFunc(MODE))));

    // Row 7
    const lxCell = dualBtn("util", withLabel("lastx", { run: () => { recallLastX(); } }), withLabel("\u2295", runMacro(XOR)), null, false, withLabel("n!", runFunc(FACTORIAL)));
    lastxBtnEl = lxCell.querySelector("button");
    lastxBtnEl.title = "Recall lastx: " + calcState.lastx;
    g.appendChild(lxCell);
    g.appendChild(digit("0"));
    g.appendChild(digit("."));
    g.appendChild(dualBtn("func", withLabel("\u00B1", runMacro("_1*", true)), withLabel("s", runFunc("Ks_ 10 k l8 l6 d * l5 / - l5 1 - / v l_k")), null, false, withLabel("\u03C3", runFunc(POPULATION))));
    g.appendChild(dualBtn("func", withLabel("+", runFunc("+")), withLabel("\u03A3+", runFunc(SIGMA_PLUS)), null, false, withLabel("\u03A3-", runFunc(SIGMA_MINUS))));

    return g;
}

// ── Stack/Registers overlay ──────────────────────────────────────────
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
    lxTable.innerHTML = `<tbody><tr class="lx-row"><td class="lx-lbl" style="width:60px">lastx:</td><td class="mono" style="font-weight:bold">${esc(calcState.lastx)}</td></tr></tbody>`;
    detailOverlayEl.appendChild(lxTable);

    const rTable = el("table");
    rTable.style.marginTop = "8px";
    rTable.innerHTML += `<thead><tr><th style="width:55px">Reg</th><th>Frames</th></tr></thead>`;
    const rTbody = el("tbody");
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
function btn(cls, label) {
    const b = document.createElement("button");
    b.className = cls;
    b.innerHTML = label;
    return b;
}
function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
}
function esc(s) {
    return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function fBtnSimple(label, cmd, print) {
    const b = btn("func", label);
    b.addEventListener("click", () => doFunc(cmd, print));
    return b;
}
function mBtnSimple(label, cmd, print) {
    return fBtnSimple(label, cmd, print);
}

function dualBtn(cls, main, shift, wrapExtra, noAutoClear, shiftBlue) {
    const wrap = el("div", "key-cell" + (wrapExtra ? " " + wrapExtra : ""));
    const b = document.createElement("button");
    b.className = cls;
    b.innerHTML = main ? main.label : "";
    b.addEventListener("click", e => {
        if (noAutoClear) {
            if (main) main.run(b, e);
            return;
        }
        const shiftWasOn = calcState.shift;
        const shiftBlueWasOn = calcState.shiftBlue;
        if (shiftBlueWasOn && shiftBlue) {
            shiftBlue.run(b, e);
        } else if (shiftWasOn && shift) {
            shift.run(b, e);
        } else if (main) {
            main.run(b, e);
        }
        if (shiftWasOn || shiftBlueWasOn) {
            calcState.shift = false;
            calcState.shiftBlue = false;
            render();
        }
    });
    wrap.appendChild(b);
    const isMenu = calcState.shiftBlue ? (shiftBlue && shiftBlue.menu) : (shift && shift.menu);
    const lbl = el("div", "shift-label-row" + (isMenu ? " menu" : ""));
    if (calcState.shiftBlue) {
        lbl.innerHTML = shiftBlue ? shiftBlue.label : "";
        lbl.style.color = "#0066cc";
    } else {
        lbl.innerHTML = shift ? shift.label : "";
        lbl.style.color = "";
    }
    wrap.appendChild(lbl);
    return wrap;
}

function runIns(ch)            { return { run: () => doIns(ch) }; }
function runFunc(cmd, print)   { return { run: () => doFunc(cmd, print) }; }
function runMacro(cmd, print)  { return runFunc(cmd, print); }
function withLabel(label, descriptor) { return Object.assign({ label }, descriptor); }

function dualPopupKey(cls, mainLabel, mainDescr, shiftId, shiftLabel, entries) {
    const wrap = el("div", "key-cell");
    const popWrap = el("div", "pop-wrap");
    const b = document.createElement("button");
    b.className = cls;
    b.innerHTML = mainLabel || "";
    b.addEventListener("click", e => {
        if (calcState.shift || calcState.shiftBlue) {
            e.stopPropagation();
            calcState.shift = false;
            calcState.shiftBlue = false;
            togglePopup(shiftId, b);
        } else if (mainDescr) {
            mainDescr.run();
        }
    });
    popWrap.appendChild(b);

    const isOpen = calcState.openPopup === shiftId;
    const menu = el("div", "pop-menu" + (isOpen ? " open" : ""));
    menu.setAttribute("data-dir", isOpen ? calcState.popupDir : "above");

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

// ── DC scripts ───────────────────────────────────────────────────────
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
// 0! and 1! are both handled explicitly via register B (base case: discard
// n, push 1, then quit both the B frame and the enclosing F frame with q,
// skipping the recursive multiply below); n>=2 recurses via F exactly as
// before. See the manual's dc-language section for the full trace.
const FACTORIAL = "[R1q]sB[d2>Bd1-d1<F*]dsFx";

// ── Initial Render ───────────────────────────────────────────────────
render();

})();
