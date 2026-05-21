import p5 from "p5";
import type { Renderer } from "../types";
import type { AudioAnalysis } from "../../types";
import { emptyAudioAnalysis } from "../../stores/vjStore";

const MATH_CONST = `
var PI = Math.PI;
var TWO_PI = Math.PI * 2;
var HALF_PI = Math.PI / 2;
var QUARTER_PI = Math.PI / 4;
var TAU = Math.PI * 2;
`;

const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const RESERVED_ALIASES = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "constructor",
  "setup",
  "draw",
  "windowResized",
  "keyPressed",
  "keyReleased",
  "mousePressed",
  "mouseReleased",
  "mouseMoved",
  "mouseDragged",
]);

const MATH_FALLBACKS = [
  "abs", "ceil", "floor", "round", "min", "max", "pow", "sqrt",
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
  "exp", "log",
];

const P5_CONSTANTS = [
  "P2D", "P2DHDR", "WEBGL", "WEBGL2", "WEBGPU",
  "CENTER", "CORNER", "LEFT", "RIGHT", "TOP", "BOTTOM",
  "BASELINE", "WORD", "CHAR",
  "ROUND", "SQUARE", "PROJECT", "MITER", "BEVEL",
  "CLOSE", "OPEN", "PIE", "CHORD", "RADIUS", "DEGREES", "RADIANS",
  "RGB", "HSB", "HSL", "BLEND", "ADD", "DARKEST", "LIGHTEST",
  "DIFFERENCE", "EXCLUSION", "MULTIPLY", "SCREEN", "REPLACE", "REMOVE",
  "OVERLAY", "HARD_LIGHT", "SOFT_LIGHT", "DODGE", "BURN",
  "THRESHOLD", "GRAY", "OPAQUE", "INVERT", "POSTERIZE", "DILATE", "ERODE", "BLUR",
  "IMAGE", "ARROW", "CROSS", "HAND", "MOVE", "TEXT", "WAIT",
  "NORMAL", "ITALIC", "BOLD", "BOLDITALIC",
  "LINEAR", "QUADRATIC", "BEZIER", "CATMULLROM",
  "POINTS", "LINES", "TRIANGLES", "TRIANGLE_FAN", "TRIANGLE_STRIP",
  "QUADS", "QUAD_STRIP", "TESS",
];

const CONSTANT_FALLBACKS: Record<string, string | number> = {
  P2D: "p2d",
  P2DHDR: "p2d-hdr",
  WEBGL: "webgl",
  WEBGL2: "webgl2",
  WEBGPU: "webgpu",
  ARROW: "default",
  CROSS: "crosshair",
  HAND: "pointer",
  MOVE: "move",
  TEXT: "text",
  WAIT: "wait",
};

export class P5Renderer implements Renderer {
  private p5Instance: p5 | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private container: HTMLDivElement | null = null;
  private code = "";
  private audio: AudioAnalysis = emptyAudioAnalysis;

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.container = document.createElement("div");
    this.container.style.cssText = "position:fixed;top:-9999px;left:-9999px;pointer-events:none;";
    document.body.appendChild(this.container);
  }

  setCode(code: string): void {
    const normalizedCode = this.normalizeCode(code);
    if (normalizedCode === this.code && this.p5Instance) return;
    this.code = normalizedCode;
    this.recreate();
  }

  private normalizeCode(code: string): string {
    return code
      .trim()
      .replace(/^```(?:javascript|js|p5)?\s*/i, "")
      .replace(/\s*```$/i, "");
  }

  private buildPreamble(p: p5): string {
    const lines: string[] = [];
    const emitted = new Set<string>();
    const seenObjects = new Set<object>();

    const emitFunctionAlias = (name: string) => {
      if (!JS_IDENTIFIER.test(name) || name.startsWith("_") || RESERVED_ALIASES.has(name) || emitted.has(name)) {
        return;
      }
      try {
        if (typeof (p as unknown as Record<string, unknown>)[name] === "function") {
          lines.push(`var ${name} = function() { return p[${JSON.stringify(name)}].apply(p, arguments); };`);
          emitted.add(name);
        }
      } catch {
        // Some p5 properties are lazy getters and can throw before setup.
      }
    };

    let obj: object | null = p;
    while (obj && !seenObjects.has(obj)) {
      seenObjects.add(obj);
      for (const name of Object.getOwnPropertyNames(obj)) {
        emitFunctionAlias(name);
      }
      obj = Object.getPrototypeOf(obj);
    }

    for (const name of MATH_FALLBACKS) {
      if (!emitted.has(name)) {
        lines.push(`var ${name} = Math.${name};`);
        emitted.add(name);
      }
    }

    if (!emitted.has("constrain")) {
      lines.push("var constrain = function(n, low, high) { return Math.max(Math.min(n, high), low); };");
      emitted.add("constrain");
    }
    if (!emitted.has("map")) {
      lines.push(`var map = function(n, start1, stop1, start2, stop2, withinBounds) {
  var v = (n - start1) / (stop1 - start1) * (stop2 - start2) + start2;
  if (!withinBounds) return v;
  return start2 < stop2 ? constrain(v, start2, stop2) : constrain(v, stop2, start2);
};`);
      emitted.add("map");
    }
    if (!emitted.has("random")) {
      lines.push(`var random = function(min, max) {
  if (Array.isArray(min)) return min[Math.floor(Math.random() * min.length)];
  if (min === undefined) return Math.random();
  if (max === undefined) return Math.random() * min;
  return Math.random() * (max - min) + min;
};`);
      emitted.add("random");
    }

    for (const c of P5_CONSTANTS) {
      if ((p as unknown as Record<string, unknown>)[c] !== undefined) {
        lines.push(`var ${c} = p.${c};`);
      } else if (CONSTANT_FALLBACKS[c] !== undefined) {
        lines.push(`var ${c} = ${JSON.stringify(CONSTANT_FALLBACKS[c])};`);
      }
    }

    lines.push(MATH_CONST);
    lines.push("var width = 0;");
    lines.push("var height = 0;");
    lines.push("var mouseX = 0;");
    lines.push("var mouseY = 0;");
    lines.push("var pmouseX = 0;");
    lines.push("var pmouseY = 0;");
    lines.push("var frameCount = 0;");
    lines.push("var deltaTime = 0;");
    lines.push("var mouseIsPressed = false;");
    lines.push("var key = '';");
    lines.push("var keyCode = 0;");
    lines.push("var windowWidth = p.windowWidth;");
    lines.push("var windowHeight = p.windowHeight;");
    lines.push("var audio = p.__vjAudio;");
    lines.push("var bpm = 0;");
    lines.push("var beat = false;");
    lines.push("var beatPhase = 0;");
    lines.push("var beatCount = 0;");
    lines.push("var fft = [];");
    lines.push(`
var __syncP5Globals = function() {
  audio = p.__vjAudio;
  width = p.width;
  height = p.height;
  mouseX = p.mouseX;
  mouseY = p.mouseY;
  pmouseX = p.pmouseX;
  pmouseY = p.pmouseY;
  frameCount = p.frameCount;
  deltaTime = p.deltaTime;
  mouseIsPressed = p.mouseIsPressed;
  key = p.key;
  keyCode = p.keyCode;
  windowWidth = p.windowWidth;
  windowHeight = p.windowHeight;
  bpm = audio.bpm;
  beat = audio.beat;
  beatPhase = audio.beatPhase;
  beatCount = audio.beatCount;
  fft = audio.fft;
};`);

    return lines.join("\n");
  }

  private recreate(): void {
    this.destroyInstance();
    if (!this.container || !this.code) return;

    const userCode = this.code;

    try {
      const renderer = this;
      const sketch = (p: p5) => {
        (p as unknown as { __vjAudio: AudioAnalysis }).__vjAudio = renderer.audio;
        const preamble = renderer.buildPreamble(p);

        const body = `${preamble}\n${userCode}\n
if (typeof setup === 'function') {
  p.setup = function() {
    __syncP5Globals();
    setup();
    __syncP5Globals();
    p.noLoop();
  };
} else {
  p.setup = function() {
    __syncP5Globals();
    p.noLoop();
  };
}
if (typeof draw === 'function') {
  p.draw = function() {
    __syncP5Globals();
    draw();
    __syncP5Globals();
  };
}
if (typeof windowResized === 'function') {
  p.windowResized = function() {
    __syncP5Globals();
    windowResized();
    __syncP5Globals();
  };
}
if (typeof keyPressed === 'function') {
  p.keyPressed = function() {
    __syncP5Globals();
    return keyPressed();
  };
}
if (typeof keyReleased === 'function') {
  p.keyReleased = function() {
    __syncP5Globals();
    return keyReleased();
  };
}
if (typeof mousePressed === 'function') {
  p.mousePressed = function() {
    __syncP5Globals();
    return mousePressed();
  };
}
if (typeof mouseReleased === 'function') {
  p.mouseReleased = function() {
    __syncP5Globals();
    return mouseReleased();
  };
}
if (typeof mouseMoved === 'function') {
  p.mouseMoved = function() {
    __syncP5Globals();
    return mouseMoved();
  };
}
if (typeof mouseDragged === 'function') {
  p.mouseDragged = function() {
    __syncP5Globals();
    return mouseDragged();
  };
}`;

        const wrapped = new Function("p", body);
        wrapped(p);
      };

      this.p5Instance = new p5(sketch, this.container);
    } catch (e) {
      console.error("p5.js eval error:", e);
    }
  }

  update(_time: number, _dt: number, audio: AudioAnalysis): void {
    this.audio = audio;
    if (this.p5Instance) {
      (this.p5Instance as unknown as { __vjAudio: AudioAnalysis }).__vjAudio = audio;
      try {
        this.p5Instance.redraw();
      } catch {}
    }
    if (!this.canvas || !this.container) return;
    const pCanvas = this.container.querySelector("canvas");
    if (!pCanvas) return;
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(pCanvas, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  resize(w: number, h: number): void {
    if (this.p5Instance) {
      try {
        this.p5Instance.resizeCanvas(w, h);
      } catch {}
    }
  }

  private destroyInstance(): void {
    if (this.p5Instance) {
      this.p5Instance.remove();
      this.p5Instance = null;
    }
  }

  destroy(): void {
    this.destroyInstance();
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
