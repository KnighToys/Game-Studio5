import assert from "node:assert/strict";
import test from "node:test";
import { Group, Mesh, PlaneGeometry, Vector3 } from "three";
import { ModelCollisionWorld } from "../src/model_collision.js";

function createWorld(t) {
    const world = new ModelCollisionWorld();

    t.after(() => {
        for (const root of world.entries.keys()) {
            world.removeModel(root);
            root.traverse((mesh) => {
                if (mesh.isMesh) {
                    mesh.geometry.dispose();
                    mesh.material.dispose();
                }
            });
        }
    });

    return world;
}

function addWall(world, z) {
    const wall = new Mesh(new PlaneGeometry(4, 4));
    wall.position.z = z;
    world.addModel(wall);
    return wall;
}

function assertNear(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should be near ${expected}`);
}

for (const depths of [[8, 3, 5], [3, 8, 5]]) {
    test(`segment returns the closest model with insertion order ${depths}`, (t) => {
        const world = createWorld(t);
        const walls = depths.map((z) => addWall(world, z));
        const start = new Vector3(0, 0, 0);
        const end = new Vector3(0, 0, 10);
        const hit = world.raycastSegment(start, end);

        assert.equal(hit.model, walls[depths.indexOf(3)]);
        assertNear(hit.distance, 3);
        assert.deepEqual(hit.point, new Vector3(0, 0, 3));
        assert.equal(typeof hit.faceIndex, "number");
        assert.deepEqual(start, new Vector3(0, 0, 0));
        assert.deepEqual(end, new Vector3(0, 0, 10));
    });
}

test("segment returns the closest surface within a model", (t) => {
    const world = createWorld(t);
    const root = new Group();

    for (const z of [8, 3, 5]) {
        const wall = new Mesh(new PlaneGeometry(4, 4));
        wall.position.z = z;
        root.add(wall);
    }

    world.addModel(root);
    const hit = world.raycastSegment(new Vector3(), new Vector3(0, 0, 10));

    assert.equal(hit.model, root);
    assertNear(hit.distance, 3);
    assertNear(hit.point.z, 3);
});

test("nested indexed geometry uses world-space transforms and distances", (t) => {
    const world = createWorld(t);
    const root = new Group();
    root.position.set(3, 1, -2);
    root.rotation.y = Math.PI / 2;
    root.scale.set(2, 3, 4);

    const child = new Group();
    child.position.z = 1;
    root.add(child);

    const wall = new Mesh(new PlaneGeometry(2, 2));
    assert.ok(wall.geometry.index, "exercise the indexed geometry used by imported models");
    wall.position.z = 0.5;
    child.add(wall);

    world.addModel(root);
    const hit = world.raycastSegment(new Vector3(4, 1, -2), new Vector3(14, 1, -2));

    assert.equal(hit.model, root);
    assertNear(hit.distance, 5);
    assertNear(hit.point.x, 9);
    assertNear(hit.point.y, 1);
    assertNear(hit.point.z, -2);
});

test("segment detects either side of a model wall", (t) => {
    const world = createWorld(t);
    addWall(world, 3);

    for (const [startZ, endZ, distance] of [[0, 10, 3], [10, 0, 7]]) {
        const hit = world.raycastSegment(new Vector3(0, 0, startZ), new Vector3(0, 0, endZ));
        assertNear(hit.distance, distance);
        assertNear(hit.point.z, 3);
    }
});

test("segment excludes surfaces past its end and includes its endpoint", (t) => {
    const world = createWorld(t);
    addWall(world, 3);
    const start = new Vector3();

    assert.equal(world.raycastSegment(start, new Vector3(0, 0, 2.99)), null);
    assert.equal(world.intersectsSegment(start, new Vector3(0, 0, 2.99)), false);
    assertNear(world.raycastSegment(start, new Vector3(0, 0, 3)).distance, 3);
    assert.equal(world.intersectsSegment(start, new Vector3(0, 0, 3)), true);
    assert.equal(world.raycastSegment(start, new Vector3(0, 0, -10)), null);
});

test("empty worlds and zero-length segments do not intersect", (t) => {
    const world = createWorld(t);
    const start = new Vector3();
    const end = new Vector3(0, 0, 10);

    assert.equal(world.raycastSegment(start, end), null);
    assert.equal(world.intersectsSegment(start, end), false);

    addWall(world, 3);
    const onWall = new Vector3(0, 0, 3);
    assert.equal(world.raycastSegment(onWall, onWall), null);
    assert.equal(world.intersectsSegment(onWall, onWall), false);
});
