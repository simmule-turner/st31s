// ═══════════════════════════════════════════════════════════════════════
//  DCEngine (version 28)
//  dc(1)-style RPN language interpreter. Depends on DCMath.
//  Load order: dcmath.js, then this file, then calc-ui.js.
// ═══════════════════════════════════════════════════════════════════════
const MAX_ARRAY_INDEX = 2048;
const MAX_ARRAY_KEYS  = 1024;
const MAX_BUFFER_CHARS = 8192;
const MAX_EXPONENT    = 9999;

class DCEngine {
  constructor(env) {
    if (!env.DCMath) throw new Error("DCMath library was not passed to DCEngine.");
    this.env    = env;
    this.DCMath = env.DCMath;
    this.config = env.config ?? new Map();
  }

  run(input, wrap=true) {
    if (!input) return "";
    const DCMath = this.DCMath;
    const MAX_EXECUTION_TIME_MS = this.config.get("MAX_EXECUTION_TIME_MS") ?? 5000;
    const MAX_RECURSION         = this.config.get("MAX_RECURSION")         ?? 1000;
    const MAX_SCALE             = this.config.get("MAX_SCALE")             ?? 110;
    const MAX_STACK_SIZE        = this.config.get("MAX_STACK_SIZE")        ?? 1000;

    let bracketDepth = 0;
    for (let i = 0; i < input.length; i++) {
      if (input[i] === "[") bracketDepth++;
      else if (input[i] === "]") bracketDepth--;
      if (bracketDepth < 0)  return `Syntax Error: Unbalanced brackets (unexpected closing bracket at position ${i}). Execution aborted.`;
      if (bracketDepth > 500) return "Syntax Error: Bracket nesting depth exceeds safe limits (max 500). Execution aborted.";
    }
    if (bracketDepth !== 0) return "Syntax Error: Unbalanced brackets (missing closing bracket). Execution aborted.";

    const savedState  = this.env.loadState() || {};
    const cleanRegs   = Object.create(null);
    if (savedState.registers) Object.keys(savedState.registers).forEach(k => { cleanRegs[k] = savedState.registers[k]; });

    const state = {
      stack: (Array.isArray(savedState.stack) ? savedState.stack : []).map(v => (typeof v==="string"||typeof v==="number") ? v.toString() : "0"),
      registers: cleanRegs,
      config: {
        i: (typeof savedState.config?.i==="number" && savedState.config.i>=2  && savedState.config.i<=16)          ? savedState.config.i : 10,
        o: (typeof savedState.config?.o==="number" && savedState.config.o>=2)                                       ? savedState.config.o : 10,
        k: (typeof savedState.config?.k==="number" && savedState.config.k>=0  && savedState.config.k<=MAX_SCALE)   ? savedState.config.k : 0
      }
    };

    const { stack, registers: regs, config: conf } = state;
    let buffer = "";

    const isString     = v => typeof v === "string" && v.startsWith("[") && v.endsWith("]");
    const getValue     = v => { if (v===undefined||v===null) return new DCMath("0"); try { let s=v.toString(); if(isString(s))s=s.slice(1,-1); return new DCMath(s); } catch { return new DCMath("0"); } };
    const popNum       = () => stack.length===0 ? undefined : getValue(stack.pop());
    const peekNum      = (d=1) => (stack.length<d||d<1) ? undefined : getValue(stack[stack.length-d]);
    const pushMath     = o => stack.push(o ? o.toString() : "0");
    const appendBuf    = str => { if (buffer.length+str.length > MAX_BUFFER_CHARS) { buffer += "... [Output truncated for safety]\n"; executionStack.length=0; return false; } buffer+=str; return true; };

    function checkNumericOperands(n=2) {
      if (stack.length < n) { buffer += "stack empty\n"; return false; }
      for (let i=1;i<=n;i++) if (isString(stack[stack.length-i])) { buffer += "non-numeric value\n"; return false; }
      return true;
    }

    const wrapNumber = (str, nl) => {
      const LL = wrap ? 69 : 10000;
      if (str.length <= LL) return str + (nl ? "\n" : "");
      let res = "", pos = 0;
      while (pos < str.length) {
        if (pos+LL < str.length) { res += str.substring(pos, pos+LL) + "\\\n"; pos += LL; }
        else { res += str.substring(pos) + (nl ? "\n" : ""); pos = str.length; }
      }
      return res;
    };

    const display = (vStr, rad) => {
      if (vStr===undefined||vStr===null) return "0";
      try {
        const s = vStr.toString();
        if (isString(s)) return s.slice(1,-1);
        if (rad === 10) return s;
        const numObj = new DCMath(s), sign = numObj.isNegative()?"-":"", absVal = numObj.abs();
        let tempInt = absVal.stripScale(); const intDigits = []; const baseDec = new DCMath(rad.toString());
        while (!tempInt.isZero()) { const {q,r} = DCMath._divmodMag(tempInt.digits, baseDec.digits, 0); let rv=0; for(let i=r.length-1;i>=0;i--)rv=rv*100+r[i]; intDigits.push(rv); tempInt=new DCMath(0); tempInt.digits=q; }
        intDigits.reverse();
        const decDigits = absVal.scale, radDigits = decDigits > 0 ? Math.ceil(decDigits*Math.log(10)/Math.log(rad)) : 0;
        let fracStr = "";
        if (radDigits > 0) { let fv = absVal.sub(absVal.stripScale()); fracStr = "."; for(let i=0;i<radDigits;i++){ fv=fv.mul(baseDec,radDigits+1); const d=fv.stripScale(); fv=fv.sub(d); const dv=parseInt(d.toString(),10); fracStr += rad<=16?dv.toString(16).toUpperCase():dv.toString()+" "; } fracStr=fracStr.trimEnd(); }
        const pw = (rad-1).toString().length;
        const intStr = intDigits.length>0?(rad<=16?intDigits.map(d=>d.toString(16).toUpperCase()).join(""):intDigits.map((d,i)=>i===0?d.toString():d.toString().padStart(pw,"0")).join(" ")):(absVal.scale>0?"":"0");
        return sign+intStr+fracStr;
      } catch { return "0"; }
    };

    function getOrInitReg(arg) {
      const rc = (typeof arg==="string"&&arg.length>0)?arg[0]:"_";
      if (!regs[rc]) regs[rc]={frames:[]};
      if (regs[rc].frames.length===0) regs[rc].frames.push({v:"0",array:Object.create(null)});
      return regs[rc].frames[regs[rc].frames.length-1];
    }

    const REG_CMDS = new Set(["s","l","S","L",":",";"," <",">","="]);

    const tokenize = s => {
      try {
        const src = s.replace(/#.*$/gm,""); const tokens = []; let i = 0;
        while (i < src.length) {
          const c = src[i];
          if (/[\s,]/.test(c)) { i++; continue; }
          if (c==="[") { let st=i,sd=1; i++; while(i<src.length&&sd>0){if(src[i]==="[")sd++;else if(src[i]==="]")sd--;i++;} tokens.push(src.substring(st,i)); continue; }
          const isH  = /[0-9A-F]/.test(c);
          const isDot= c==="."&&i+1<src.length&&/[0-9A-F]/.test(src[i+1]);
          if (c==="_"||isH||isDot) {
            let st=i; if(c==="_")i++;
            while(i<src.length&&/[0-9A-F]/.test(src[i]))i++;
            if(i<src.length&&src[i]==="."&&i+1<src.length&&/[0-9A-F]/.test(src[i+1])){i++;while(i<src.length&&/[0-9A-F]/.test(src[i]))i++;}
            tokens.push(src.substring(st,i)); continue;
          }
          if (c==="!"&&i+1<src.length&&"=><".includes(src[i+1])){const reg=(i+2<src.length)?src[i+2]:"";tokens.push("!"+src[i+1]+reg);i+=reg?3:2;continue;}
          const RCMDS = new Set(["s","l","S","L",":",";"," <",">","="]);
          if ("slSL:;<>=".includes(c)){const nx=(i+1<src.length)?src[i+1]:"";tokens.push(c+nx);i+=nx?2:1;continue;}
          tokens.push(c); i++;
        }
        return tokens;
      } catch { return []; }
    };

    const parseMacro = content => {
      let depth = 0;
      for (let i=0;i<content.length;i++){if(content[i]==="[")depth++;else if(content[i]==="]")depth--; if(depth<0)break;}
      if (depth!==0){buffer+="Syntax Error: Unbalanced brackets inside macro.\n";return [];}
      return tokenize(content);
    };

    let executionStack = [tokenize(input)];
    const startTime = Date.now();

    try {
      while (executionStack.length > 0) {
        if (Date.now()-startTime > MAX_EXECUTION_TIME_MS) { buffer+="Execution aborted: Operation timed out\n"; executionStack.length=0; break; }
        if (executionStack.length > MAX_RECURSION)        { buffer+="recursion too deep\n";                    executionStack.length=0; break; }
        if (stack.length > MAX_STACK_SIZE)                { buffer+="stack overflow\n";                        executionStack.length=0; break; }
        const cq = executionStack[executionStack.length-1];
        if (cq.length===0){executionStack.pop();continue;}
        const t = cq.shift();

        if (t.startsWith("[")) { stack.push(t); continue; }

        if (/^(_?[0-9A-F]+\.[0-9A-F]*|_?[0-9A-F]*\.[0-9A-F]+|_?[0-9A-F]+)$/.test(t)) {
          const isNeg = t.startsWith("_"), clean = t.replace("_","").toUpperCase();
          try {
            if (conf.i===10 && !/[A-F]/.test(clean)) { pushMath(new DCMath(t)); }
            else {
              const parts = clean.split("."), intP = parts[0]||"", fracP = parts[1]||"";
              const expScale = clean.includes(".")?fracP.length:0, baseO = new DCMath(conf.i.toString());
              let acc = new DCMath("0");
              for (const ch of intP) { const v=ch>="0"&&ch<="9"?ch.charCodeAt(0)-48:ch.charCodeAt(0)-55; acc=acc.mul(baseO,0).add(new DCMath(v.toString())); }
              if (fracP.length>0){let fa=new DCMath("0"),pw=new DCMath("1");const cs=Math.min(MAX_SCALE,Math.max(conf.k,fracP.length*2,20));for(const ch of fracP){const v=ch>="0"&&ch<="9"?ch.charCodeAt(0)-48:ch.charCodeAt(0)-55;pw=pw.mul(baseO,0);fa=fa.add(new DCMath(v.toString()).div(pw,cs));}acc=acc.add(fa);}
              let tot = acc.div(new DCMath("1"),expScale); if(isNeg)tot=new DCMath("0").sub(tot); pushMath(tot);
            }
          } catch(e){buffer+=e.message+"\n";}
          continue;
        }

        if (t==="_"||t==="."){pushMath(new DCMath("0"));continue;}

        const cmd=t[0], arg=t.substring(1);

        switch(cmd){
          case "p": { if(stack.length===0){buffer+="stack empty\n";break;} const top=stack[stack.length-1],isS=isString(top),fmt=display(top,conf.o); appendBuf(isS?(fmt+"\n"):wrapNumber(fmt,true)); break; }
          case "f": if(stack.length>0) for(let i=stack.length-1;i>=0;i--){const it=stack[i],isS=isString(it),fmt=display(it,conf.o);if(!appendBuf(isS?(fmt+"\n"):wrapNumber(fmt,true)))break;} break;
          case "n": { if(stack.length===0){buffer+="stack empty\n";break;} const v=stack.pop(),isS=isString(v),fmt=display(v,conf.o); appendBuf(isS?fmt:wrapNumber(fmt,false)); break; }
          case "P": { if(stack.length===0){buffer+="stack empty\n";break;} const val=stack.pop(); if(isString(val)){appendBuf(val.slice(1,-1));}else{const code=parseInt(getValue(val).stripScale().toString(),10);if(!isNaN(code))appendBuf(String.fromCharCode(Math.abs(code)%256));} break; }
          case "+": case "-": case "*": case "/": case "%": case "~": case "^": {
            if(!checkNumericOperands())break;
            const b=peekNum();
            if(cmd==="^"){if(b.scale!==0)buffer+="Runtime warning: non-zero scale in exponent\n";if(Math.abs(parseInt(b.stripScale().toString(),10))>MAX_EXPONENT){buffer+="exponent too large\n";break;}}
            else if((cmd==="/"||cmd==="%"||cmd==="~")&&b.isZero()){buffer+=(cmd==="%")?"remainder by zero\n":"divide by zero\n";break;}
            stack.pop(); const a=popNum();
            try {
              if(cmd==="+")pushMath(a.add(b));
              else if(cmd==="-")pushMath(a.sub(b));
              else if(cmd==="*")pushMath(a.mul(b,conf.k));
              else if(cmd==="/")pushMath(a.div(b,conf.k));
              else if(cmd==="%")pushMath(a.rem(b,conf.k));
              else if(cmd==="~"){const[q,r]=a.divmod(b,conf.k);pushMath(q);pushMath(r);}
              else if(cmd==="^")pushMath(a.pow(b.scale===0?b:b.stripScale(),conf.k));
            } catch(e){buffer+="Arithmetic error: "+e.message+"\n";stack.push("0");}
            break;
          }
          case "v": { if(!checkNumericOperands(1))break; try{pushMath(popNum().sqrt(conf.k));}catch(e){buffer+=e.message+"\n";stack.push("0");} break; }
          case "c": stack.length=0; break;
          case "d": if(stack.length>0)stack.push(stack[stack.length-1]);else buffer+="stack empty\n"; break;
          case "r": if(stack.length<2)buffer+="stack empty\n";else{const v1=stack.pop(),v2=stack.pop();stack.push(v1);stack.push(v2);} break;
          case "R": if(stack.length>0)stack.pop();else buffer+="stack empty\n"; break;
          case "s": case "S": {
            if(stack.length===0){buffer+="stack empty\n";break;}
            if(!arg||!arg.length){buffer+=`Runtime error: Command '${cmd}' requires a register identifier\n`;if(stack.length>0)stack.pop();break;}
            const rc=arg[0],vs=stack.pop().toString();
            if(cmd==="s"){getOrInitReg(rc).v=vs;}else{if(!regs[rc])regs[rc]={frames:[]};regs[rc].frames.push({v:vs,array:Object.create(null)});}
            break;
          }
          case "l": { if(!arg||!arg.length){buffer+=`Runtime error: Command '${cmd}' requires a register identifier\n`;break;} stack.push(getOrInitReg(arg[0]).v); break; }
          case "L": { if(!arg||!arg.length){buffer+=`Runtime error: Command '${cmd}' requires a register identifier\n`;break;} const rc=arg[0]; if(regs[rc]&&regs[rc].frames.length>0)stack.push(regs[rc].frames.pop().v);else buffer+=`stack register '${rc}' (0${rc.charCodeAt(0).toString(8)}) is empty\n`; break; }
          case ":": case ";": {
            if(stack.length===0||(cmd===":"&&stack.length<2)){buffer+="stack empty\n";break;}
            if(!arg||!arg.length){buffer+=`Runtime error: Command '${cmd}' requires an array identifier\n`;break;}
            const io=peekNum(); if(io.scale!==0){buffer+="array index must be a nonnegative integer\n";break;}
            const iv=parseInt(io.toString(),10);
            if(iv<0||iv>=MAX_ARRAY_INDEX||isNaN(iv)){buffer+=iv<0?"negative index\n":"index too big\n";break;}
            const cf=getOrInitReg(arg);
            if(cmd===":"){if(Object.keys(cf.array).length>=MAX_ARRAY_KEYS&&cf.array[iv]===undefined){buffer+="array overflow\n";stack.pop();stack.pop();break;}stack.pop();cf.array[iv]=stack.pop().toString();}
            else{stack.pop();stack.push(cf.array[iv]||"0");}
            break;
          }
          case "k": case "i": case "o": {
            if(!checkNumericOperands(1))break; const v=parseInt(popNum().stripScale().toString(),10);
            if(cmd==="k"){if(v>=0&&v<=MAX_SCALE)conf.k=v;else buffer+=v<0?"scale must be a nonnegative number\n":"scale too large\n";}
            else if(cmd==="i"){if(v>=2&&v<=16)conf.i=v;else buffer+="input base must be a number between 2 and 16\n";}
            else{if(v>=2)conf.o=v;else buffer+="output base must be a number greater than 1\n";}
            break;
          }
          case "K": stack.push(conf.k.toString()); break;
          case "I": stack.push(conf.i.toString()); break;
          case "O": stack.push(conf.o.toString()); break;
          case "a": {
            if(stack.length===0){buffer+="stack empty\n";break;}
            const val=stack.pop();
            if(isString(val)){const inner=val.slice(1,-1);stack.push("["+(inner.length>0?inner.charAt(0):"")+"]");}
            else{const code=Math.abs(parseInt(getValue(val).stripScale().toString(),10))%256;stack.push("["+String.fromCharCode(code)+"]");}
            break;
          }
          case "x": { if(stack.length===0){buffer+="stack empty\n";break;} const val=stack.pop(); if(isString(val))executionStack.push(parseMacro(val.slice(1,-1)));else stack.push(val); break; }
          case "?": { if(typeof window!=="undefined"&&window.prompt){const ui=window.prompt("dc.js interactive input:","");if(ui)executionStack[executionStack.length-1].unshift(...tokenize(ui));} break; }
          case "&": { if(stack.length<2){buffer+="stack empty\n";break;} const s2=stack.pop(),s1=stack.pop(); const st1=isString(s1)?s1.slice(1,-1):display(s1,conf.o),st2=isString(s2)?s2.slice(1,-1):display(s2,conf.o); stack.push("["+st1+st2+"]"); break; }
          case ">": case "<": case "=": case "!": {
            if(!checkNumericOperands())break;
            const isN=(cmd==="!"), op=isN?arg[0]:cmd, reg=isN?arg.slice(1):arg;
            const tos=popNum(), v1=popNum(), cmp=tos.compareTo(v1);
            let ok=(op===">"&&cmp>0)||(op==="<"&&cmp<0)||(op==="="&&cmp===0); if(isN)ok=!ok;
            if(ok&&reg&&regs[reg]?.frames?.length>0){const m=regs[reg].frames[regs[reg].frames.length-1].v;if(isString(m))executionStack.push(parseMacro(m.slice(1,-1)));else stack.push(m);}
            break;
          }
          case "z": stack.push(stack.length.toString()); break;
          case "Z": { if(stack.length===0){buffer+="stack empty\n";break;} const v=(stack.pop()||"0").toString(); stack.push(isString(v)?Math.max(0,v.length-2).toString():v.replace(/^[-_]|\./g,"").length.toString()); break; }
          case "X": if(stack.length===0){buffer+="stack empty\n";break;} stack.push(popNum().scale.toString()); break;
          case "q": executionStack.length=Math.max(0,executionStack.length-2); break;
          case "Q": { if(stack.length===0){buffer+="stack empty\n";break;} let lv=parseInt(popNum().stripScale().toString(),10); for(let i=0;i<lv&&executionStack.length>0;i++)executionStack.pop(); break; }
          default: buffer+=`${cmd} (0${cmd.charCodeAt(0).toString(8)}) is unimplemented\n`;
        }
      }
    } catch(e) { buffer+=`\nFatal Execution Error: ${e.message||e}\n`; }

    const result = buffer.trim() || " ";
    this.env.saveState(state);
    return result;
  }
}

if (typeof window !== "undefined") window.DCEngine = DCEngine;
