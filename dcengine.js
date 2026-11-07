// ═══════════════════════════════════════════════════════════════════════
//  DCEngine (version 29)
//  dc(1)-style RPN language interpreter. Depends on DCMath.
//  Load order: dcmath.js, then this file, then calc-ui.js.
// ═══════════════════════════════════════════════════════════════════════
const MAX_ARRAY_INDEX = 2048;
const MAX_ARRAY_KEYS  = 1024;
const MAX_BUFFER_CHARS = 8192;
const MAX_EXPONENT    = 9999;

const NUM_RE = /^(_?[0-9A-F]+\.[0-9A-F]*|_?[0-9A-F]*\.[0-9A-F]+|_?[0-9A-F]+)$/;
const isString = v => typeof v === "string" && v.startsWith("[") && v.endsWith("]");
const inner    = v => v.slice(1, -1);
const digitVal = ch => ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;

// Saved state comes from localStorage, so rebuild every field from scratch instead of trusting its shape:
// one-character register names, a bounded list of frames, each with a string value and a bounded numeric-index array.
function cleanState(s, maxScale, maxStack) {
  const scalar = v => (typeof v === "string" || typeof v === "number") ? String(v) : null;
  const num    = (v, lo, hi, d) => (typeof v === "number" && v >= lo && v <= hi) ? v : d;
  const regs   = Object.create(null);
  if (s.registers && typeof s.registers === "object") {
    for (const [name, reg] of Object.entries(s.registers)) {
      if (name.length !== 1) continue;
      regs[name] = { frames: (Array.isArray(reg?.frames) ? reg.frames : []).slice(0, maxStack).filter(f => f && typeof f === "object").map(f => {
        const array = Object.create(null);
        let keys = 0;
        if (f.array && typeof f.array === "object") {
          for (const [idx, val] of Object.entries(f.array)) {
            if (!/^\d+$/.test(idx) || Number(idx) > MAX_ARRAY_INDEX || keys >= MAX_ARRAY_KEYS || scalar(val) === null) continue;
            array[idx] = scalar(val); keys++;
          }
        }
        return { v: scalar(f.v) ?? "0", array };
      }) };
    }
  }
  return {
    stack: (Array.isArray(s.stack) ? s.stack : []).map(v => scalar(v) ?? "0"),
    registers: regs,
    config: { i: num(s.config?.i, 2, 16, 10), o: num(s.config?.o, 2, Infinity, 10), k: num(s.config?.k, 0, maxScale, 0) }
  };
}

// Number literal in input base `base` (digits may exceed the base, as in dc). Throws on arithmetic errors.
function parseNumber(DCMath, t, base, k, maxScale) {
  const clean = t.replace("_", ""), neg = t.startsWith("_");
  if (base === 10 && !/[A-F]/.test(clean)) return new DCMath(t);
  const [intP = "", fracP = ""] = clean.split("."), baseO = new DCMath(base.toString());
  let acc = new DCMath("0");
  for (const ch of intP) acc = acc.mul(baseO, 0).add(new DCMath(digitVal(ch).toString()));
  if (fracP) {
    let fa = new DCMath("0"), pw = new DCMath("1");
    const cs = Math.min(maxScale, Math.max(k, fracP.length * 2, 20));
    for (const ch of fracP) { pw = pw.mul(baseO, 0); fa = fa.add(new DCMath(digitVal(ch).toString()).div(pw, cs)); }
    acc = acc.add(fa);
  }
  const tot = acc.div(new DCMath("1"), clean.includes(".") ? fracP.length : 0);
  return neg ? new DCMath("0").sub(tot) : tot;
}

// Value -> text in output base `rad` (strings print raw).
function display(DCMath, v, rad) {
  if (v === undefined || v === null) return "0";
  try {
    const s = v.toString();
    if (isString(s)) return inner(s);
    if (rad === 10) return s;
    const numObj = new DCMath(s), sign = numObj.isNegative() ? "-" : "", absVal = numObj.abs(), baseDec = new DCMath(rad.toString());
    let tempInt = absVal.stripScale();
    const intDigits = [];
    while (!tempInt.isZero()) {
      const { q, r } = DCMath._divmodMag(tempInt.digits, baseDec.digits, 0);
      let rv = 0; for (let i = r.length - 1; i >= 0; i--) rv = rv * 100 + r[i];
      intDigits.push(rv); tempInt = new DCMath(0); tempInt.digits = q;
    }
    intDigits.reverse();
    const hex = rad <= 16, decDigits = absVal.scale, radDigits = decDigits > 0 ? Math.ceil(decDigits * Math.log(10) / Math.log(rad)) : 0;
    let fracStr = "";
    if (radDigits > 0) {
      let fv = absVal.sub(absVal.stripScale()); fracStr = ".";
      for (let i = 0; i < radDigits; i++) {
        fv = fv.mul(baseDec, radDigits + 1); const d = fv.stripScale(); fv = fv.sub(d);
        const dv = parseInt(d.toString(), 10); fracStr += hex ? dv.toString(16).toUpperCase() : dv.toString() + " ";
      }
      fracStr = fracStr.trimEnd();
    }
    const pw = (rad - 1).toString().length;
    const intStr = intDigits.length > 0
      ? (hex ? intDigits.map(d => d.toString(16).toUpperCase()).join("") : intDigits.map((d, i) => i === 0 ? d.toString() : d.toString().padStart(pw, "0")).join(" "))
      : (absVal.scale > 0 ? "" : "0");
    return sign + intStr + fracStr;
  } catch { return "0"; }
}

function tokenize(s) {
  try {
    const src = s.replace(/#.*$/gm, ""), tokens = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i], nx = src[i + 1] ?? "";
      if (/[\s,]/.test(c)) { i++; continue; }
      if (c === "[") { const st = i; let sd = 1; i++; while (i < src.length && sd > 0) { if (src[i] === "[") sd++; else if (src[i] === "]") sd--; i++; } tokens.push(src.substring(st, i)); continue; }
      const isDot = c === "." && /[0-9A-F]/.test(nx);
      if (c === "_" || isDot || /[0-9A-F]/.test(c)) {
        const st = i; if (c === "_") i++;
        while (i < src.length && /[0-9A-F]/.test(src[i])) i++;
        if (src[i] === "." && /[0-9A-F]/.test(src[i + 1] ?? "")) { i++; while (i < src.length && /[0-9A-F]/.test(src[i])) i++; }
        tokens.push(src.substring(st, i)); continue;
      }
      if (c === "!" && "=><".includes(nx) && nx) { const reg = src[i + 2] ?? ""; tokens.push("!" + nx + reg); i += reg ? 3 : 2; continue; }
      if ("slSL:;<>=".includes(c)) { tokens.push(c + nx); i += nx ? 2 : 1; continue; }
      tokens.push(c); i++;
    }
    return tokens;
  } catch { return []; }
}

// Binary operators: (a, b, scale) -> result or [results...]
const BINOPS = {
  "+": (a, b) => a.add(b),
  "-": (a, b) => a.sub(b),
  "*": (a, b, k) => a.mul(b, k),
  "/": (a, b, k) => a.div(b, k),
  "%": (a, b, k) => a.rem(b, k),
  "~": (a, b, k) => a.divmod(b, k)
};

class DCEngine {
  constructor(env) {
    if (!env.DCMath) throw new Error("DCMath library was not passed to DCEngine.");
    this.env    = env;
    this.DCMath = env.DCMath;
    this.config = env.config ?? new Map();
  }

  run(input, wrap=true) {
    if (!input) return "";
    const DCMath = this.DCMath, cfg = this.config;
    const MAX_EXECUTION_TIME_MS = cfg.get("MAX_EXECUTION_TIME_MS") ?? 5000;
    const MAX_RECURSION         = cfg.get("MAX_RECURSION")         ?? 1000;
    const MAX_SCALE             = cfg.get("MAX_SCALE")             ?? 110;
    const MAX_STACK_SIZE        = cfg.get("MAX_STACK_SIZE")        ?? 1000;

    let bracketDepth = 0;
    for (let i = 0; i < input.length; i++) {
      if (input[i] === "[") bracketDepth++;
      else if (input[i] === "]") bracketDepth--;
      if (bracketDepth < 0)  return `Syntax Error: Unbalanced brackets (unexpected closing bracket at position ${i}). Execution aborted.`;
      if (bracketDepth > 500) return "Syntax Error: Bracket nesting depth exceeds safe limits (max 500). Execution aborted.";
    }
    if (bracketDepth !== 0) return "Syntax Error: Unbalanced brackets (missing closing bracket). Execution aborted.";

    const state = cleanState(this.env.loadState() || {}, MAX_SCALE, MAX_STACK_SIZE);
    const { stack, registers: regs, config: conf } = state;
    let buffer = "";
    let executionStack = [tokenize(input)];
    const startTime = Date.now(), deadline = startTime + MAX_EXECUTION_TIME_MS;

    // ── helpers ──────────────────────────────────────────────────────────
    const fail      = msg => { buffer += msg + "\n"; };
    const halt      = msg => { fail(msg); executionStack.length = 0; };
    const need      = n => stack.length >= n || (fail("stack empty"), false);             // enough operands?
    const numeric   = n => need(n) && (!stack.slice(-n).some(isString) || (fail("non-numeric value"), false));
    const ident     = (cmd, arg, kind="a register") => !!arg || (fail(`Runtime error: Command '${cmd}' requires ${kind} identifier`), false);
    const getValue  = v => { if (v === undefined || v === null) return new DCMath("0"); try { const s = v.toString(); return new DCMath(isString(s) ? inner(s) : s); } catch { return new DCMath("0"); } };
    const popNum    = () => stack.length === 0 ? undefined : getValue(stack.pop());
    const toInt     = n => parseInt(n.stripScale().toString(), 10);
    const pushMath  = o => stack.push(o ? o.toString() : "0");
    const top       = () => stack[stack.length - 1];
    const shown     = v => display(DCMath, v, conf.o);
    const appendBuf = str => { if (buffer.length + str.length > MAX_BUFFER_CHARS) { buffer += "... [Output truncated for safety]\n"; executionStack.length = 0; return false; } buffer += str; return true; };
    const timeout   = () => { const e = new Error("timeout"); e.name = "DCTimeout"; throw e; };
    const guard     = fn => { try { fn(); } catch (e) { if (e && e.name === "DCTimeout") halt("Execution aborted: Operation timed out"); else { fail("Arithmetic error: " + e.message); stack.push("0"); } } };

    const wrapNumber = (str, nl) => {
      const LL = wrap ? 69 : 10000;
      if (str.length <= LL) return str + (nl ? "\n" : "");
      let res = "", pos = 0;
      for (; pos + LL < str.length; pos += LL) res += str.substring(pos, pos + LL) + "\\\n";
      return res + str.substring(pos) + (nl ? "\n" : "");
    };
    const show = (v, nl) => { const f = shown(v); return isString(v) ? (nl ? f + "\n" : f) : wrapNumber(f, nl); };

    const getOrInitReg = arg => {
      const rc = (typeof arg === "string" && arg.length > 0) ? arg[0] : "_";
      const r = regs[rc] ??= { frames: [] };
      if (r.frames.length === 0) r.frames.push({ v: "0", array: Object.create(null) });
      return r.frames[r.frames.length - 1];
    };

    const parseMacro = content => {
      let depth = 0;
      for (let i = 0; i < content.length; i++) { if (content[i] === "[") depth++; else if (content[i] === "]") depth--; if (depth < 0) break; }
      if (depth !== 0) { fail("Syntax Error: Unbalanced brackets inside macro."); return []; }
      return tokenize(content);
    };
    // Run a string value as a macro; push anything else back.
    const exec = m => { if (isString(m)) executionStack.push(parseMacro(inner(m))); else stack.push(m); };

    // ── main loop ────────────────────────────────────────────────────────
    try {
      while (executionStack.length > 0) {
        const stop = Date.now() > deadline ? "Execution aborted: Operation timed out"
                   : executionStack.length > MAX_RECURSION ? "recursion too deep"
                   : stack.length > MAX_STACK_SIZE ? "stack overflow" : null;
        if (stop) { halt(stop); break; }
        const cq = executionStack[executionStack.length - 1];
        if (cq.length === 0) { executionStack.pop(); continue; }
        const t = cq.shift();

        if (t[0] === "[") { stack.push(t); continue; }

        if (NUM_RE.test(t)) {
          try { pushMath(parseNumber(DCMath, t, conf.i, conf.k, MAX_SCALE)); } catch (e) { fail(e.message); }
          continue;
        }
        if (t === "_" || t === ".") { pushMath(new DCMath("0")); continue; }

        const cmd = t[0], arg = t.substring(1);

        switch (cmd) {
          // printing
          case "p": if (need(1)) appendBuf(show(top(), true)); break;
          case "f": for (let i = stack.length - 1; i >= 0; i--) if (!appendBuf(show(stack[i], true))) break; break;
          case "n": if (need(1)) appendBuf(show(stack.pop(), false)); break;
          case "P": {
            if (!need(1)) break;
            const val = stack.pop();
            if (isString(val)) { appendBuf(inner(val)); break; }
            // a number prints as base-256 bytes of its integer part's absolute value, most significant first (GNU dc)
            const digits = getValue(val).stripScale().toString().replace(/^-/, "");
            if (/^\d+$/.test(digits)) { let n = BigInt(digits); const bytes = []; do { bytes.push(Number(n & 255n)); n >>= 8n; } while (n > 0n); appendBuf(String.fromCharCode(...bytes.reverse())); }
            break;
          }
          // arithmetic
          case "+": case "-": case "*": case "/": case "%": case "~": case "^": {
            if (!numeric(2)) break;
            const b = getValue(top());
            if (cmd === "^") {
              if (b.scale !== 0) fail("Runtime warning: non-zero scale in exponent");
              if (Math.abs(toInt(b)) > MAX_EXPONENT) { fail("exponent too large"); break; }
            } else if ("/%~".includes(cmd) && b.isZero()) { fail(cmd === "%" ? "remainder by zero" : "divide by zero"); break; }
            stack.pop(); const a = popNum();
            guard(() => {
              const r = cmd === "^" ? a.pow(b.scale === 0 ? b : b.stripScale(), conf.k, deadline) : BINOPS[cmd](a, b, conf.k);
              if (Array.isArray(r)) r.forEach(pushMath); else pushMath(r);
            });
            break;
          }
          case "|": { // modular exponentiation: base exponent modulus | -> (base ^ exponent) mod modulus
            if (!numeric(3)) break;
            const m = popNum(), e = popNum(), bs = popNum();
            if (m.scale || e.scale || bs.scale) { fail("Runtime error: | requires integer arguments"); break; }
            if (m.isZero()) { fail("remainder by zero"); break; }
            if (e.isNegative()) { fail("negative exponent"); break; }
            guard(() => {
              const M = BigInt(m.toString());
              let result = 1n % M, base = BigInt(bs.toString()) % M, ex = BigInt(e.toString());
              for (; ex > 0n; ex >>= 1n) {
                // A single | can run far longer than one command normally does, so honor the execution-time cap here too.
                if (Date.now() > deadline) timeout();
                if (ex & 1n) result = result * base % M;
                base = base * base % M;
              }
              stack.push(result.toString());
            });
            break;
          }
          case "v": if (numeric(1)) { try { pushMath(popNum().sqrt(conf.k)); } catch (e) { fail(e.message); stack.push("0"); } } break;
          // stack
          case "c": stack.length = 0; break;
          case "d": if (need(1)) stack.push(top()); break;
          case "r": if (need(2)) { const x = stack.pop(), y = stack.pop(); stack.push(x, y); } break;
          case "R": if (need(1)) stack.pop(); break;
          case "z": stack.push(stack.length.toString()); break;
          // registers and arrays
          case "s": case "S": {
            if (!need(1) || !ident(cmd, arg)) { stack.pop(); break; }
            const rc = arg[0], vs = stack.pop().toString();
            if (cmd === "s") getOrInitReg(rc).v = vs;
            else (regs[rc] ??= { frames: [] }).frames.push({ v: vs, array: Object.create(null) });
            break;
          }
          case "l": if (ident(cmd, arg)) stack.push(getOrInitReg(arg[0]).v); break;
          case "L": {
            if (!ident(cmd, arg)) break;
            const rc = arg[0];
            if (regs[rc]?.frames.length > 0) stack.push(regs[rc].frames.pop().v);
            else fail(`stack register '${rc}' (0${rc.charCodeAt(0).toString(8)}) is empty`);
            break;
          }
          case ":": case ";": {
            if (!need(cmd === ":" ? 2 : 1) || !ident(cmd, arg, "an array")) break;
            const io = getValue(top()); if (io.scale !== 0) { fail("array index must be a nonnegative integer"); break; }
            const iv = parseInt(io.toString(), 10);
            if (iv < 0 || iv >= MAX_ARRAY_INDEX || isNaN(iv)) { fail(iv < 0 ? "negative index" : "index too big"); break; }
            const cf = getOrInitReg(arg);
            if (cmd === ":") {
              stack.pop();
              if (Object.keys(cf.array).length >= MAX_ARRAY_KEYS && cf.array[iv] === undefined) { fail("array overflow"); stack.pop(); break; }
              cf.array[iv] = stack.pop().toString();
            } else { stack.pop(); stack.push(cf.array[iv] || "0"); }
            break;
          }
          // precision and bases
          case "k": case "i": case "o": {
            if (!numeric(1)) break;
            const v = toInt(popNum());
            if (cmd === "k") { if (v >= 0 && v <= MAX_SCALE) conf.k = v; else fail(v < 0 ? "scale must be a nonnegative number" : "scale too large"); }
            else if (cmd === "i") { if (v >= 2 && v <= 16) conf.i = v; else fail("input base must be a number between 2 and 16"); }
            else if (v >= 2) conf.o = v; else fail("output base must be a number greater than 1");
            break;
          }
          case "K": case "I": case "O": stack.push(conf[cmd.toLowerCase()].toString()); break;
          // strings and macros
          case "a": {
            if (!need(1)) break;
            const val = stack.pop();
            stack.push("[" + (isString(val) ? inner(val).charAt(0) : String.fromCharCode(Math.abs(toInt(getValue(val))) % 256)) + "]");
            break;
          }
          case "x": if (need(1)) exec(stack.pop()); break;
          case "?": { if (typeof window !== "undefined" && window.prompt) { const ui = window.prompt("dc.js interactive input:", ""); if (ui) executionStack[executionStack.length - 1].unshift(...tokenize(ui)); } break; }
          case "&": {
            if (!need(2)) break;
            const s2 = stack.pop(), s1 = stack.pop(), txt = v => isString(v) ? inner(v) : shown(v);
            stack.push("[" + txt(s1) + txt(s2) + "]");
            break;
          }
          // conditionals: a b >X runs X if b > a
          case ">": case "<": case "=": case "!": {
            if (!numeric(2)) break;
            const neg = cmd === "!", op = neg ? arg[0] : cmd, reg = neg ? arg.slice(1) : arg;
            const tos = popNum(), cmp = tos.compareTo(popNum());
            const ok = ((op === ">" && cmp > 0) || (op === "<" && cmp < 0) || (op === "=" && cmp === 0)) !== neg;
            if (ok && reg && regs[reg]?.frames?.length > 0) exec(regs[reg].frames[regs[reg].frames.length - 1].v);
            break;
          }
          // status inquiry
          case "Z": { if (!need(1)) break; const v = (stack.pop() || "0").toString(); stack.push(isString(v) ? Math.max(0, v.length - 2).toString() : v.replace(/^[-_]|\./g, "").length.toString()); break; }
          case "X": if (need(1)) stack.push(popNum().scale.toString()); break;
          // quitting
          case "q": executionStack.length = Math.max(0, executionStack.length - 2); break;
          case "Q": if (need(1)) { for (let n = toInt(popNum()), i = 0; i < n && executionStack.length > 0; i++) executionStack.pop(); } break;
          default: fail(`${cmd} (0${cmd.charCodeAt(0).toString(8)}) is unimplemented`);
        }
      }
    } catch (e) { buffer += `\nFatal Execution Error: ${e.message || e}\n`; }

    const result = buffer.trim() || " ";
    this.env.saveState(state);
    return result;
  }
}

if (typeof window !== "undefined") window.DCEngine = DCEngine;
