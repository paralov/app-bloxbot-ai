import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModelPreview, { disposeModel } from "@/components/ModelPreview";

/** Each parse waits here until a test lets it finish. */
const parses = vi.hoisted(() => [] as ((scene: unknown) => void)[]);
const renderers = vi.hoisted(() => [] as { clear: () => void }[]);

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    parseAsync() {
      return new Promise((resolve) => parses.push((scene) => resolve({ scene })));
    }
  },
}));
vi.mock("three", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three")>()),
  // jsdom has no WebGL, so this stands in for drawing.
  WebGLRenderer: class {
    clear = vi.fn();
    constructor() {
      renderers.push(this);
    }
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {}
  },
}));

afterEach(() => {
  cleanup();
  parses.length = 0;
  renderers.length = 0;
});

describe("closing a preview", () => {
  it("frees textures as well as geometry and materials", () => {
    const map = new Texture();
    const normalMap = new Texture();
    const material = new MeshStandardMaterial({ map, normalMap });
    const geometry = new BoxGeometry();
    const group = new Group();
    group.add(new Mesh(geometry, [material]));
    const freed = [map, normalMap, material, geometry].map((thing) => vi.spyOn(thing, "dispose"));

    disposeModel(group);

    for (const spy of freed) expect(spy).toHaveBeenCalled();
  });
});

describe("a file that changes while it's shown", () => {
  it("clears the old drawing, and isn't ready until the new one is drawn", async () => {
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    const onDrawn = vi.fn();
    const onFailed = vi.fn();
    const preview = (data: Uint8Array) =>
      createElement(ModelPreview, { data, kind: "glb", name: "Crate", onFailed, onDrawn });
    const { rerender } = render(preview(first));
    await act(async () => parses[0]?.(new Group()));
    const canvas = screen.getByRole("img");
    expect(onDrawn).toHaveBeenLastCalledWith(first);
    expect(canvas.tabIndex).toBe(0);

    rerender(preview(second));

    expect(renderers[0]?.clear).toHaveBeenCalled();
    expect(canvas.tabIndex).toBe(-1);
    expect(onDrawn).not.toHaveBeenCalledWith(second);
    await act(async () => parses[1]?.(new Group()));
    expect(onDrawn).toHaveBeenLastCalledWith(second);
    expect(canvas.tabIndex).toBe(0);
    expect(onFailed).not.toHaveBeenCalled();
  });
});
