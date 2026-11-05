import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModelPreview, { disposeModel } from "@/components/ModelPreview";

/** Each parse waits here until a test lets it finish. */
const parses = vi.hoisted(() => [] as ((scene: unknown) => void)[]);
const renderers = vi.hoisted(
  () =>
    [] as { domElement: HTMLCanvasElement; dispose: () => void; forceContextLoss: () => void }[],
);

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
    domElement = document.createElement("canvas");
    dispose = vi.fn();
    forceContextLoss = vi.fn();
    constructor() {
      renderers.push(this);
    }
    setPixelRatio() {}
    setSize() {}
    render() {}
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  parses.length = 0;
  renderers.length = 0;
});

const preview = (data: Uint8Array, onFailed = vi.fn(), onDrawn = vi.fn()) =>
  createElement(ModelPreview, { data, kind: "glb", name: "Crate", onFailed, onDrawn });

/** Released means disposed, with its context handed back and its canvas gone. */
function expectReleased(renderer: (typeof renderers)[number] | undefined) {
  expect(renderer?.dispose).toHaveBeenCalled();
  expect(renderer?.forceContextLoss).toHaveBeenCalled();
  expect(renderer?.domElement.isConnected).toBe(false);
}

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
    const { rerender } = render(preview(first, onFailed, onDrawn));
    await act(async () => parses[0]?.(new Group()));
    const canvas = screen.getByRole("img");
    expect(onDrawn).toHaveBeenLastCalledWith(first);
    expect(canvas.tabIndex).toBe(0);

    rerender(preview(second, onFailed, onDrawn));

    expectReleased(renderers[0]);
    expect(canvas.tabIndex).toBe(-1);
    expect(onDrawn).not.toHaveBeenCalledWith(second);
    await act(async () => parses[1]?.(new Group()));
    expect(onDrawn).toHaveBeenLastCalledWith(second);
    expect(canvas.tabIndex).toBe(0);
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe("keeping WebGL contexts few", () => {
  it("hands its context back when the card goes", async () => {
    const { unmount } = render(preview(new Uint8Array([1])));
    await act(async () => parses[0]?.(new Group()));
    expect(renderers[0]?.domElement.isConnected).toBe(true);

    unmount();

    expectReleased(renderers[0]);
  });

  it("only holds a context while it's near the screen", async () => {
    let report = (_near: boolean) => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          report = (near) => callback([{ isIntersecting: near }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    const onDrawn = vi.fn();
    render(preview(new Uint8Array([1]), vi.fn(), onDrawn));
    expect(parses).toHaveLength(0);

    act(() => report(true));
    await act(async () => parses[0]?.(new Group()));
    expect(renderers).toHaveLength(1);
    expect(onDrawn).toHaveBeenCalledTimes(1);

    act(() => report(false));
    expectReleased(renderers[0]);
    expect(screen.getByRole("img").tabIndex).toBe(-1);

    act(() => report(true));
    await act(async () => parses[1]?.(new Group()));
    expect(renderers).toHaveLength(2);
    expect(renderers[1]?.domElement.isConnected).toBe(true);
  });

  it("says it failed when the browser takes its context away", async () => {
    const onFailed = vi.fn();
    render(preview(new Uint8Array([1]), onFailed));
    await act(async () => parses[0]?.(new Group()));

    renderers[0]?.domElement.dispatchEvent(new Event("webglcontextlost"));

    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});
