import { Vector3, Box3, Line3, Ray, BufferGeometry, Float32BufferAttribute, DoubleSide } from "three";
import { MeshBVH } from "three-mesh-bvh";

export class ModelCollisionWorld {
    constructor() {
        this.entries = new Map();
        this.segment = new Line3();
        this.bounds = new Box3();
        this.step = new Vector3();
        this.correction = new Vector3();
        this.trianglePoint = new Vector3();
        this.capsulePoint = new Vector3();
        this.ray = new Ray();
    }

    addModel(root) {
        root.updateWorldMatrix(true, true);

        const positions = [];
        const vertex = new Vector3();

        root.traverseVisible((mesh) => {
            if (!mesh.isMesh || mesh.userData.noCollision) {
                return;
            }

            const geometry = mesh.geometry;
            const position = geometry.attributes.position;

            if (!position) {
                return;
            }

            const index = geometry.index;
            const count = index ? index.count : position.count;

            for (let i = 0; i < count; i++) {
                const vertexIndex = index ? index.getX(i) : i;

                vertex.fromBufferAttribute(position, vertexIndex);
                vertex.applyMatrix4(mesh.matrixWorld);

                positions.push(vertex.x, vertex.y, vertex.z);
            }
        });

        this.removeModel(root);

        if (positions.length === 0) {
            return 0;
        }

        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));

        const tree = new MeshBVH(geometry, { targetLeafSize: 12 });

        this.entries.set(root, { tree: tree, geometry: geometry });

        return positions.length / 9;
    }

    removeModel(root) {
        const entry = this.entries.get(root);

        if (entry) {
            entry.geometry.dispose();
        }

        this.entries.delete(root);
    }

    move(position, displacement, { radius = 0.4, height = 1.8 } = {}) {
        const segment = this.segment;

        segment.start.copy(position);
        segment.start.y += radius;

        segment.end.copy(position);
        segment.end.y += height - radius;

        const stepCount = Math.max(1, Math.ceil(displacement.length() / (radius * 0.5)));

        this.step.copy(displacement).divideScalar(stepCount);

        let grounded = false;
        let hitCeiling = false;

        for (let i = 0; i < stepCount; i++) {
            segment.start.add(this.step);
            segment.end.add(this.step);

            for (let pass = 0; pass < 4; pass++) {
                let corrected = false;

                for (const entry of this.entries.values()) {
                    const tree = entry.tree;

                    this.bounds.makeEmpty();
                    this.bounds.expandByPoint(segment.start);
                    this.bounds.expandByPoint(segment.end);
                    this.bounds.expandByScalar(radius);

                    tree.shapecast({
                        intersectsBounds: (box) => {
                            return box.intersectsBox(this.bounds);
                        },
                        intersectsTriangle: (triangle) => {
                            const distance = triangle.closestPointToSegment(segment, this.trianglePoint, this.capsulePoint);

                            if (distance >= radius - 1e-7) {
                                return false;
                            }

                            this.correction.copy(this.capsulePoint).sub(this.trianglePoint);

                            if (distance > 1e-8) {
                                this.correction.divideScalar(distance);
                            } else {
                                triangle.getNormal(this.correction);

                                if (this.correction.dot(this.step) > 0) {
                                    this.correction.negate();
                                }
                            }

                            if (this.correction.y > 0.5) {
                                grounded = true;
                            }

                            if (this.correction.y < -0.5) {
                                hitCeiling = true;
                            }

                            this.correction.multiplyScalar(radius - distance + 1e-5);

                            segment.start.add(this.correction);
                            segment.end.add(this.correction);

                            corrected = true;

                            return false;
                        }
                    });
                }

                if (!corrected) {
                    break;
                }
            }
        }

        position.copy(segment.start);
        position.y -= radius;

        return { grounded: grounded, hitCeiling: hitCeiling };
    }

    // Model geometry is baked into world space by addModel, so the returned
    // point and distance use world coordinates too.
    raycastSegment(start, end) {
        this.ray.origin.copy(start);
        this.ray.direction.copy(end).sub(start);

        const length = this.ray.direction.length();

        if (length === 0) {
            return null;
        }

        this.ray.direction.divideScalar(length);

        let closestHit = null;

        for (const [model, entry] of this.entries) {
            const far = closestHit ? closestHit.distance : length;
            const hit = entry.tree.raycastFirst(this.ray, DoubleSide, 0, far);

            if (hit && (!closestHit || hit.distance < closestHit.distance)) {
                closestHit = { ...hit, model: model };
            }
        }

        return closestHit;
    }

    intersectsSegment(start, end) {
        return this.raycastSegment(start, end) !== null;
    }
}
