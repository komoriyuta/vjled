export { GLSLRenderer } from "./glsl/GLSLRenderer";
export { ThreeJSRenderer } from "./threejs/ThreeJSRenderer";
export { P5Renderer } from "./p5/P5Renderer";
export { VideoRenderer } from "./video/VideoRenderer";
export type { Renderer } from "./types";

import type { SceneType } from "../types";
import type { Renderer } from "./types";
import { GLSLRenderer } from "./glsl/GLSLRenderer";
import { ThreeJSRenderer } from "./threejs/ThreeJSRenderer";
import { P5Renderer } from "./p5/P5Renderer";
import { VideoRenderer } from "./video/VideoRenderer";

export function createRenderer(type: SceneType): Renderer | null {
  switch (type) {
    case "glsl": return new GLSLRenderer();
    case "threejs": return new ThreeJSRenderer();
    case "p5": return new P5Renderer();
    case "video": return new VideoRenderer();
    default: return null;
  }
}
