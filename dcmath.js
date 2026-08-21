// ═══════════════════════════════════════════════════════════════════════
//  DCMath (version 28)
//  Arbitrary-precision decimal arithmetic used by DCEngine.
//  No dependencies. Load this file before dcengine.js.
// ═══════════════════════════════════════════════════════════════════════
class DCMath {
  constructor(input, scale = 0) {
    this.digits = []; this.scale = 0; this.sign = 1;
    if (input instanceof DCMath) { this.digits = [...input.digits]; this.scale = input.scale; this.sign = input.sign; return; }
    if (typeof input === "number") {
      this._parseString(input.toString());
      if (scale > this.scale) { this.digits = DCMath._mulMag(this.digits, DCMath._pow10(scale - this.scale)); this.scale = scale; }
      return;
    }
    if (typeof input === "string") this._parseString(input.trim());
  }
  _parseString(str) {
    if (!str) return;
    let neg = false;
    if (str.startsWith("_") || str.startsWith("-")) { neg = true; str = str.slice(1); }
    const dotPos = str.indexOf(".");
    const intStr = dotPos === -1 ? str : str.slice(0, dotPos);
    const fracStr = dotPos === -1 ? "" : str.slice(dotPos + 1);
    this.scale = fracStr.length;
    const combined = (intStr + fracStr).replace(/^0+/, "") || "0";
    if (combined === "0") return;
    this.sign = neg ? -1 : 1;
    this.digits = [];
    for (let i = combined.length; i > 0; i -= 2) this.digits.push(parseInt(combined.substring(Math.max(0, i - 2), i), 10));
    this._trimLeadingZeros();
  }
  isZero()     { return this.digits.length === 0; }
  isNegative() { return this.sign === -1 && !this.isZero(); }
  isPositive() { return this.sign === 1  && !this.isZero(); }
  abs()     { const r = new DCMath(this); r.sign = 1;          return r; }
  negate()  { if (this.isZero()) return new DCMath(this); const r = new DCMath(this); r.sign = -this.sign; return r; }
  compareTo(other) {
    let a, b;
    if (this.scale === other.scale) { a = this; b = other; } else [a, b] = DCMath._alignScales(this, other);
    if (a.isZero() && b.isZero()) return 0;
    if (a.sign !== b.sign) return a.sign > b.sign ? 1 : -1;
    const cmp = DCMath._cmpMag(a.digits, b.digits);
    return a.sign === 1 ? cmp : -cmp;
  }
  equals(other) { return this.compareTo(other) === 0; }
  stripScale() {
    if (this.scale === 0) return new DCMath(this);
    const { q } = DCMath._divmodMag(this.digits, DCMath._pow10(this.scale), 0);
    const res = new DCMath(0); res.digits = q; res.scale = 0; res.sign = q.length ? this.sign : 1;
    return res;
  }
  toString() {
    if (this.isZero()) return this.scale === 0 ? "0" : "." + "0".repeat(this.scale);
    let s = this.digits.slice().reverse().map((d, i) => i === 0 ? d.toString() : d.toString().padStart(2, "0")).join("");
    if (this.scale > 0) {
      while (s.length <= this.scale) s = "0" + s;
      const ip = s.slice(0, s.length - this.scale), fp = s.slice(s.length - this.scale);
      s = (ip === "0" ? "" : ip) + "." + fp;
    } else { s = s || "0"; }
    return this.sign === -1 ? "-" + s : s;
  }
  _trimLeadingZeros() { while (this.digits.length > 0 && this.digits[this.digits.length - 1] === 0) this.digits.pop(); }
  static _alignScales(a, b) {
    const t = Math.max(a.scale, b.scale);
    const aS = new DCMath(a); if (t > a.scale) { aS.digits = DCMath._mulMag(aS.digits, DCMath._pow10(t - a.scale)); aS.scale = t; }
    const bS = new DCMath(b); if (t > b.scale) { bS.digits = DCMath._mulMag(bS.digits, DCMath._pow10(t - b.scale)); bS.scale = t; }
    return [aS, bS];
  }
  static _pow10(n) {
    if (!DCMath._pow10Cache) DCMath._pow10Cache = new Map([[0, Object.freeze([1])]]);
    if (DCMath._pow10Cache.has(n)) return DCMath._pow10Cache.get(n);
    let best = 0;
    if (DCMath._pow10Cache.has(n - 1)) best = n - 1;
    else for (const k of DCMath._pow10Cache.keys()) if (k < n && k > best) best = k;
    let result = [...DCMath._pow10Cache.get(best)];
    for (let i = best; i < n; i++) result = DCMath._mulMagByDigit(result, 10);
    const fr = Object.freeze(result); DCMath._pow10Cache.set(n, fr); return fr;
  }
  static _mulMagByDigit(a, d) {
    if (!a.length || d === 0) return [];
    const r = []; let c = 0;
    for (let i = 0; i < a.length; i++) { const v = a[i] * d + c; r.push(v % 100); c = Math.trunc(v / 100); }
    while (c > 0) { r.push(c % 100); c = Math.trunc(c / 100); }
    return r;
  }
  static _addMag(a, b) {
    const len = Math.max(a.length, b.length); const r = []; let c = 0;
    for (let i = 0; i < len; i++) { const v = (a[i]||0) + (b[i]||0) + c; r.push(v % 100); c = Math.trunc(v / 100); }
    if (c) r.push(c); return r;
  }
  static _subMag(a, b) {
    const r = []; let bw = 0;
    for (let i = 0; i < a.length; i++) { let v = (a[i]||0) - (b[i]||0) - bw; if (v < 0) { v += 100; bw = 1; } else bw = 0; r.push(v); }
    while (r.length > 0 && r[r.length-1] === 0) r.pop(); return r;
  }
  static _mulMag(a, b) {
    if (!a.length || !b.length) return [];
    const r = new Array(a.length + b.length).fill(0);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i+j] += a[i]*b[j];
    let c = 0;
    for (let i = 0; i < r.length; i++) { const v = r[i]+c; r[i] = v%100; c = Math.trunc(v/100); }
    while (c > 0) { r.push(c%100); c = Math.trunc(c/100); }
    while (r.length > 0 && r[r.length-1] === 0) r.pop(); return r;
  }
  static _cmpMag(a, b) {
    let al = a.length; while (al > 0 && a[al-1] === 0) al--;
    let bl = b.length; while (bl > 0 && b[bl-1] === 0) bl--;
    if (al !== bl) return al < bl ? -1 : 1;
    for (let i = al-1; i >= 0; i--) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  }
  static _divmodMag(dividend, divisor, extraScale = 0) {
    if (!divisor.length || (divisor.length === 1 && divisor[0] === 0)) throw new Error("divide by zero");
    let dvd = extraScale > 0 ? DCMath._mulMag(dividend, DCMath._pow10(extraScale)) : [...dividend];
    const dvs = [...divisor];
    while (dvd.length > 0 && dvd[dvd.length-1] === 0) dvd.pop();
    while (dvs.length > 0 && dvs[dvs.length-1] === 0) dvs.pop();
    if (!dvd.length) return { q: [], r: [] };
    const q = []; let rem = [];
    for (let i = dvd.length-1; i >= 0; i--) {
      rem.unshift(dvd[i]); while (rem.length > 0 && rem[rem.length-1] === 0) rem.pop();
      let lo = 0, hi = 99, qd = 0, lp = [];
      while (lo <= hi) { const m = Math.trunc((lo+hi)/2); const p = DCMath._mulMagByDigit(dvs,m); if (DCMath._cmpMag(p,rem)<=0){qd=m;lp=p;lo=m+1;}else hi=m-1; }
      q.push(qd); if (qd > 0) rem = DCMath._subMag(rem, lp);
    }
    q.reverse();
    while (q.length > 0 && q[q.length-1] === 0) q.pop();
    while (rem.length > 0 && rem[rem.length-1] === 0) rem.pop();
    return { q, r: rem };
  }
  static _intSqrt(n) { if (n < 2) return Math.trunc(n); let x = n, y = Math.trunc((x + Math.trunc(n/x))/2); while (y < x) { x = y; y = Math.trunc((x + Math.trunc(n/x))/2); } return x; }
  add(other) {
    const [a, b] = DCMath._alignScales(this, other); const r = new DCMath(0); r.scale = a.scale;
    if (a.sign === b.sign) { r.digits = DCMath._addMag(a.digits, b.digits); r.sign = (a.isZero()&&b.isZero())?1:a.sign; }
    else { const c = DCMath._cmpMag(a.digits, b.digits); if (c===0) return r; if (c>0){r.digits=DCMath._subMag(a.digits,b.digits);r.sign=a.sign;}else{r.digits=DCMath._subMag(b.digits,a.digits);r.sign=b.sign;} }
    return r;
  }
  sub(other)  { return this.add(other.negate()); }
  mul(other, k = 0) {
    if (this.isZero() || other.isZero()) return new DCMath(0);
    const rs = this.scale + other.scale, ts = Math.min(rs, Math.max(k, this.scale, other.scale)), drop = rs - ts;
    let pm = DCMath._mulMag(this.digits, other.digits);
    if (drop > 0) pm = DCMath._divmodMag(pm, DCMath._pow10(drop), 0).q;
    const r = new DCMath(0); r.digits = pm; r.scale = ts; r.sign = this.sign===other.sign?1:-1; r._trimLeadingZeros(); if(r.isZero())r.sign=1; return r;
  }
  div(other, k) {
    if (other.isZero()) throw new Error("divide by zero");
    if (k === undefined) k = Math.max(this.scale, other.scale);
    if (this.isZero()) { const r = new DCMath(0); r.scale = k; return r; }
    const power = other.scale + k - this.scale;
    let qm; if (power >= 0) { qm = DCMath._divmodMag(this.digits, other.digits, power).q; } else { const sd = DCMath._mulMag(other.digits, DCMath._pow10(-power)); qm = DCMath._divmodMag(this.digits, sd, 0).q; }
    const r = new DCMath(0); r.digits = qm; r.scale = k; r.sign = this.sign===other.sign?1:-1; r._trimLeadingZeros(); if(r.isZero())r.sign=1; return r;
  }
  divmod(other, k) {
    if (other.isZero()) throw new Error("divide by zero");
    if (k === undefined) k = Math.max(this.scale, other.scale);
    const q = this.div(other, k), p = q.mul(other, q.scale + other.scale); return [q, this.sub(p)];
  }
  rem(other, k)  { return this.divmod(other, k)[1]; }
  pow(exp, k = 0) {
    if (exp.scale !== 0) throw new Error("exponent must be an integer");
    if (exp.isZero()) return new DCMath(1, 0);
    const en = exp.isNegative(), ea = en ? exp.negate() : new DCMath(exp);
    let n = 0; for (let i = ea.digits.length-1; i >= 0; i--) n = n*100 + ea.digits[i];
    const sa = this.scale, rs = sa*n, ts = Math.min(rs, Math.max(k, sa)), drop = rs - ts;
    let rm = [1], cb = [...this.digits], e = n;
    while (e > 0) { if (e&1) rm = DCMath._mulMag(rm, cb); cb = DCMath._mulMag(cb, cb); e = Math.trunc(e/2); }
    if (drop > 0) rm = DCMath._divmodMag(rm, DCMath._pow10(drop), 0).q;
    const r = new DCMath(0); r.digits = rm; r.scale = ts; r.sign = (this.sign===-1 && n%2===1)?-1:1; r._trimLeadingZeros(); if(r.isZero())r.sign=1;
    if (en) return new DCMath(1).div(r, k); return r;
  }
  sqrt(k = 0) {
    if (this.isNegative()) throw new Error("square root of negative number");
    const ts = Math.max(k, this.scale);
    if (this.isZero()) return new DCMath("0." + "0".repeat(ts));
    const sp = 2*ts - this.scale;
    const ym = sp > 0 ? DCMath._mulMag(this.digits, DCMath._pow10(sp)) : this.digits;
    const L = ym.length; let gv, m;
    if (L%2===1) { m = Math.floor((L-1)/2); gv = DCMath._intSqrt(ym[L-1])+1; }
    else         { m = Math.floor((L-2)/2); gv = DCMath._intSqrt(ym[L-1]*100 + ym[L-2])+1; }
    let xn = new Array(m).fill(0), tg = gv;
    while (tg > 0) { xn.push(tg%100); tg = Math.trunc(tg/100); }
    const two = [2];
    for (;;) { const {q} = DCMath._divmodMag(ym, xn, 0); const s = DCMath._addMag(xn, q); const {q: nx} = DCMath._divmodMag(s, two, 0); if (DCMath._cmpMag(nx, xn) >= 0) break; xn = nx; }
    const r = new DCMath(0); r.digits = xn; r.scale = ts; r.sign = 1; return r;
  }
}

// Expose as a global for classic <script> loading (index.html loads this
// file, dcengine.js, and calc-ui.js as plain sequential scripts, not ES
// modules, so this assignment is what makes DCMath visible to the other
// two files regardless of load order quirks).
if (typeof window !== "undefined") window.DCMath = DCMath;
