// Real-runtime smoke test: loads dcmath.js, dcengine.js, pwa-init.js,
// calc-ui.js in their actual script-tag order inside a jsdom document,
// then exercises the calculator via real button clicks, and separately
// confirms buildDirectDcPanel() constructs without throwing.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <div id="app"></div>
</body></html>`, { url: "https://example.test/dc-calc/index.html", runScripts: "outside-only" });

const { window } = dom;

// Minimal stubs jsdom doesn't provide.
window.matchMedia = window.matchMedia || function () {
    return { matches: false, addListener() {}, removeListener() {} };
};
window.URL.createObjectURL = window.URL.createObjectURL || function () { return "blob:stub"; };
window.navigator.serviceWorker = { register: () => Promise.resolve({}) };
let fetchCallCount = 0;
window.fetch = function (url) {
    fetchCallCount++;
    // Simulate sw.js being fetched for the version-check logic.
    return Promise.resolve({
        text: () => Promise.resolve("const CACHE_NAME = 'dc-calc-v97';\n")
    });
};
window.confirm = () => false;
window.visualViewport = { height: window.innerHeight, addEventListener() {}, removeEventListener() {} };

let failed = false;
function assert(cond, msg) {
    if (!cond) {
        failed = true;
        console.error("FAIL:", msg);
    } else {
        console.log("ok  :", msg);
    }
}

function loadScript(file) {
    const code = fs.readFileSync(path.join(__dirname, file), "utf8");
    window.eval(code);
}

try {
    loadScript("dcmath.js");
    loadScript("dcengine.js");
    loadScript("pwa-init.js");
    loadScript("calc-ui.js");
} catch (e) {
    console.error("FAIL: script load threw:", e);
    process.exit(1);
}

assert(typeof window.DCMath === "function", "window.DCMath is defined");
assert(typeof window.DCEngine === "function", "window.DCEngine is defined");

const doc = window.document;
function clickKeyWithLabel(label) {
    const btns = Array.from(doc.querySelectorAll("button"));
    const b = btns.find(x => x.innerHTML.trim() === label);
    if (!b) throw new Error("no button found with label " + JSON.stringify(label));
    b.dispatchEvent(new window.Event("click", { bubbles: true }));
}

// 2 enter 3 + -> 5
clickKeyWithLabel("2");
clickKeyWithLabel("enter");
clickKeyWithLabel("3");
clickKeyWithLabel("+");

const xInput = doc.querySelector("input");
assert(!!xInput, "X register input exists");
assert(xInput.value.trim() === "5", "2 enter 3 + == 5, got " + JSON.stringify(xInput && xInput.value));

// lastx round-trip
clickKeyWithLabel("lastx");
assert(xInput.value.trim() === "3", "lastx recalls 3, got " + JSON.stringify(xInput.value));

// backspace (dow shift-function key) and shift layer sanity: just ensure shift toggles without throwing
const shiftBtns = Array.from(doc.querySelectorAll("button")).filter(b => b.className && b.className.includes("shift"));
assert(shiftBtns.length >= 1, "shift key(s) present");

// Regression test: pressing SHIFT used to flash the Direct Console's
// version label back to "loading..." because render() rebuilds the whole
// panel (and used to re-fetch sw.js) on every SHIFT press.
async function runAsyncChecks() {
    // Let the first buildDirectDcPanel()'s fetch('./sw.js') resolve.
    await Promise.resolve().then(() => {}).then(() => {}).then(() => {});
    const titleEl1 = doc.querySelector(".console-title-label");
    assert(!!titleEl1, "console title label exists");
    assert(/^dc-calc-v97/.test(titleEl1.textContent), "version label resolved before any SHIFT press, got " + JSON.stringify(titleEl1.textContent));
    const fetchCountBeforeShift = fetchCallCount;

    const shiftKey = Array.from(doc.querySelectorAll("button.shift-key"))[0];
    shiftKey.dispatchEvent(new window.Event("click", { bubbles: true })); // turn SHIFT on (render())
    shiftKey.dispatchEvent(new window.Event("click", { bubbles: true })); // turn SHIFT back off (render() again)

    const titleEl2 = doc.querySelector(".console-title-label");
    assert(!!titleEl2, "console title label still exists after SHIFT presses");
    assert(!/loading/.test(titleEl2.textContent), "no 'loading...' flash after SHIFT presses, got " + JSON.stringify(titleEl2.textContent));
    assert(/^dc-calc-v97/.test(titleEl2.textContent), "version label still correct after SHIFT presses, got " + JSON.stringify(titleEl2.textContent));
    assert(fetchCallCount === fetchCountBeforeShift, "no extra sw.js fetch triggered by SHIFT presses (fetchCallCount stayed " + fetchCallCount + ")");

    // Regression test: n! (FACTORIAL) must now be correct for 0! and 1!, not just n>=2.
    function factorialViaEngine(n) {
        const DCEngine = window.DCEngine;
        const DCMath = window.DCMath;
        const e = new DCEngine({ DCMath, config: new Map(), loadState: () => ({ stack: [], config: { i: 10, o: 10, k: 0 } }), saveState: () => {}, log: () => {}, id: "fact-test" });
        return e.run(n + " [R1q]sB[d2>Bd1-d1<F*]dsFx f", false);
    }
    assert(factorialViaEngine(0) === "1", "0! == 1, got " + JSON.stringify(factorialViaEngine(0)));
    assert(factorialViaEngine(1) === "1", "1! == 1, got " + JSON.stringify(factorialViaEngine(1)));
    assert(factorialViaEngine(5) === "120", "5! == 120, got " + JSON.stringify(factorialViaEngine(5)));

    // Regression tests: GNU dc modular exponentiation (|) and multi-byte P.
    function runDc(src) {
        const e = new window.DCEngine({ DCMath: window.DCMath, config: new Map(), loadState: () => ({ stack: [], config: { i: 10, o: 10, k: 0 } }), saveState: () => {}, log: () => {}, id: "dc-test" });
        return e.run(src, false);
    }
    assert(runDc("4 13 497 | p") === "445", "4 13 497 | == 445, got " + JSON.stringify(runDc("4 13 497 | p")));
    assert(runDc("7 1000000 13 | p") === "9", "7^1000000 mod 13 == 9");
    assert(runDc("5 3 1 | p") === "0", "x^y mod 1 == 0");
    assert(runDc("24930 P") === "ab", "24930 P prints base-256 bytes 'ab', got " + JSON.stringify(runDc("24930 P")));
    assert(runDc("65 P") === "A", "65 P == A");
    assert(runDc("[Hi] P") === "Hi", "[Hi] P == Hi");

    // Regression tests: a runaway ^ is stopped by the time check, and malformed saved registers are rebuilt safely.
    assert(/timed out/.test(runDc("2 9999 ^ 9999 ^ Z p")), "runaway ^ aborts with a timeout message");
    assert(runDc("3 200 ^ Z p") === "96", "ordinary ^ unaffected (3^200 has 96 digits)");
    {
        const evil = { stack: [], registers: { a: { frames: [{ v: "7", array: { "3": "9", abc: "x", "99999": "z" } }, null] }, bb: { frames: [] }, c: "junk" }, config: { i: 10, o: 10, k: 0 } };
        const e = new window.DCEngine({ DCMath: window.DCMath, config: new Map(), loadState: () => evil, saveState: () => {}, log: () => {}, id: "evil-state" });
        assert(e.run("la p", false) === "7", "malformed saved registers are sanitized, valid frame kept");
    }

    console.log(failed ? "\nSMOKE TEST: FAILURES ABOVE" : "\nSMOKE TEST: ALL PASSED");
    process.exit(failed ? 1 : 0);
}
runAsyncChecks();
