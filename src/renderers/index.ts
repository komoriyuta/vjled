export type { Renderer } from "./types";

import type { SceneType } from "../types";
import type { Renderer } from "./types";

export async function createRenderer(type: SceneType): Promise<Renderer | null> {
  switch (type) {
    case "glsl": {
      const { GLSLRenderer } = await import("./glsl/GLSLRenderer");
      return new GLSLRenderer();
    }
    case "threejs": {
      const { ThreeJSRenderer } = await import("./threejs/ThreeJSRenderer");
      return new ThreeJSRenderer();
    }
    case "p5": {
      const { P5Renderer } = await import("./p5/P5Renderer");
      return new P5Renderer();
    }
    case "video": {
      const { VideoRenderer } = await import("./video/VideoRenderer");
      return new VideoRenderer();
    }
    default: return null;
  }
}
