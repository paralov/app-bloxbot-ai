import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import { describe, expect, it, vi } from "vitest";
import { disposeModel } from "@/components/ModelPreview";

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
