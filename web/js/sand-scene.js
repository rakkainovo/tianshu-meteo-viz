import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

const THEME = window.T.C;
const COLORS = [THEME.faceEmpty, ...['蓝色', '黄色', '橙色', '红色'].map(level => THEME.lvFace[level])];
const DOT_COLORS = [THEME.lv['未知'], ...['蓝色', '黄色', '橙色', '红色'].map(level => THEME.lv[level])];

function disposeTree(object) {
  object.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) [].concat(o.material).forEach(m => m.dispose());
  });
}

export class SandScene {
  constructor(host, hooks) {
    this.host = host;
    this.hooks = hooks;
    this.disposed = false;
    this.labels = [];
    this.pickables = [];
    this.regionMeshes = new Map();
    this.terrainData = null;
    this.terrainEnabled = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--panel-solid').trim());
    this.camera = new THREE.OrthographicCamera(-30, 30, 20, -20, 0.01, 500);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label', '全国预警三维地图');
    this.host.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minPolarAngle = 0.02;
    this.controls.maxPolarAngle = Math.PI * 0.43;
    this.controls.minZoom = 0.6;
    this.controls.maxZoom = 9;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.draw());
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#132c48', 1.8));
    const light = new THREE.DirectionalLight('#ffffff', 2);
    light.position.set(-25, 55, 18);
    this.scene.add(light);
    this.mapGroup = new THREE.Group();
    this.dataGroup = new THREE.Group();
    this.scene.add(this.mapGroup, this.dataGroup);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.onDown = e => { this.down = { x: e.clientX, y: e.clientY }; };
    this.onMove = e => {
      if (e.buttons || (e.pointerType === 'touch')) return;
      const hit = this.hit(e);
      const datum = hit ? this.datum(hit) : null;
      this.renderer.domElement.style.cursor = datum ? 'pointer' : 'grab';
      this.hooks.hover(datum, e.clientX, e.clientY);
    };
    this.onUp = e => {
      if (!this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6) return;
      const hit = this.hit(e);
      if (hit) this.hooks.pick(this.datum(hit));
    };
    this.onLeave = () => this.hooks.hover(null);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    this.onContextLost = e => { e.preventDefault(); this.hooks.error('三维绘制已中断，请重新载入或切换二维地图。'); };
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.animate = () => {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(this.animate);
      if (document.hidden || !this.host.clientWidth || !this.host.clientHeight) return;
      this.controls.update();
      const t = performance.now() * 0.002;
      if (this.focusRing) {
        this.focusRing.scale.setScalar(1 + Math.sin(t) * 0.1);
        this.focusRing.material.opacity = 0.65 + Math.sin(t) * 0.15;
      }
      this.draw();
    };
    this.resize();
    this.animate();
  }

  project(lon, lat) {
    return [(Number(lon) - 105) * Math.cos(34 * Math.PI / 180), 35 - Number(lat)];
  }

  setMap(geo) {
    disposeTree(this.mapGroup);
    this.mapGroup.clear();
    this.regionMeshes.clear();
    this.pickables = [];
    const extent = new THREE.Box3();
    (geo.features || []).forEach(f => {
      const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      polygons.forEach(p => p.forEach(r => r.forEach(c => {
        const q = this.project(c[0], c[1]); extent.expandByPoint(new THREE.Vector3(q[0], 0, q[1]));
      })));
    });
    const extentSize = extent.getSize(new THREE.Vector3());
    this.depth = Math.max(extentSize.x, extentSize.z) * 0.008;
    const boundaryMaterial = new THREE.LineBasicMaterial({ color: THEME.cyan, transparent: true, opacity: 0.4 });
    (geo.features || []).forEach(feature => {
      const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates]
        : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
      const props = feature.properties;
      const meshes = [];
      polygons.forEach(polygon => {
        if (!polygon[0] || polygon[0].length < 3) return;
        const rings = polygon.map(ring => ring.map(p => {
          const q = this.project(p[0], p[1]);
          return new THREE.Vector2(q[0], -q[1]);
        }));
        const shape = new THREE.Shape(rings[0]);
        rings.slice(1).forEach(r => shape.holes.push(new THREE.Path(r)));
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: this.depth, bevelEnabled: false, curveSegments: 1 });
        geometry.rotateX(-Math.PI / 2);
        const top = new THREE.MeshStandardMaterial({ color: COLORS[0], roughness: 0.88, metalness: 0.08 });
        const side = new THREE.MeshStandardMaterial({ color: '#10243b', roughness: 0.7 });
        const mesh = new THREE.Mesh(geometry, [top, side]);
        mesh.userData = { kind: 'region', name: props.name, adcode: String(props.adcode), feature };
        this.mapGroup.add(mesh);
        if (props.name) this.pickables.push(mesh);
        meshes.push(mesh);
        polygon.forEach(ring => {
          const points = ring.map(p => { const q = this.project(p[0], p[1]); return new THREE.Vector3(q[0], this.depth * 1.02, q[1]); });
          this.mapGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), boundaryMaterial));
        });
      });
      this.regionMeshes.set(props.name, meshes);
    });
    this.bounds = new THREE.Box3().setFromObject(this.mapGroup);
    const size = this.bounds.getSize(new THREE.Vector3());
    this.span = Math.max(size.x, size.z, 0.1);
    if (this.grid) { this.scene.remove(this.grid); disposeTree(this.grid); }
    this.grid = new THREE.GridHelper(this.span * 2.2, 22, THEME.axis, '#243c58');
    this.grid.position.copy(this.bounds.getCenter(new THREE.Vector3()));
    this.grid.position.y = -0.06;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.23;
    this.scene.add(this.grid);
    this.home();
  }

  setData(stats, records, { columns, points, labels, selected, referenceMax }) {
    disposeTree(this.dataGroup);
    this.dataGroup.clear();
    this.labels.forEach(l => l.el.remove());
    this.labels = [];
    this.focusRing = null;
    this.pickables = this.pickables.filter(m => m.userData.kind === 'region');
    const max = Math.max(1, referenceMax || 0, ...stats.map(s => s.count));
    const scale = this.span * 0.16 / max;
    this.hooks.scale(max);
    stats.forEach(stat => {
      (this.regionMeshes.get(stat.name) || []).forEach(mesh => {
        mesh.material[0].color.set(COLORS[stat.rank] || COLORS[0]);
        mesh.userData.stat = stat;
      });
      const c = stat.feature.properties.center || stat.feature.properties.centroid;
      if (!c) return;
      const p = this.project(c[0], c[1]);
      let height = 0;
      if (columns && stat.count) {
        height = stat.count * scale;
        const geom = new THREE.CylinderGeometry(this.span * 0.006, this.span * 0.006, height, 8);
        const mat = new THREE.MeshStandardMaterial({ color: DOT_COLORS[stat.rank], roughness: 0.35, metalness: 0.1 });
        const bar = new THREE.Mesh(geom, mat);
        bar.position.set(p[0], this.depth * 1.03 + height / 2, p[1]);
        bar.userData = { kind: 'region', name: stat.name, adcode: stat.adcode, feature: stat.feature, stat };
        this.dataGroup.add(bar);
        this.pickables.push(bar);
      }
      if (labels) {
        const el = document.createElement('span');
        el.className = 'sand-map-label';
        el.textContent = window.U.shortName(stat.name) + (columns && stat.count ? ' · ' + stat.count : '');
        this.host.appendChild(el);
        this.labels.push({ el, position: new THREE.Vector3(p[0], height + this.depth + this.span * 0.008, p[1]), priority: stat.count });
      }
    });
    const located = records.filter(r => Number.isFinite(r.lng) && Number.isFinite(r.lat) && r.lng > 0 && r.lat > 0);
    if (points && located.length) {
      const sphere = new THREE.SphereGeometry(this.span * 0.0037, 8, 6);
      const material = new THREE.MeshStandardMaterial({ roughness: 0.45, emissive: '#162e4a', emissiveIntensity: 0.5 });
      const dots = new THREE.InstancedMesh(sphere, material, located.length);
      const transform = new THREE.Object3D();
      located.forEach((r, i) => {
        const p = this.project(r.lng, r.lat);
        transform.position.set(p[0], this.depth + this.span * 0.004, p[1]);
        transform.updateMatrix();
        dots.setMatrixAt(i, transform.matrix);
        dots.setColorAt(i, new THREE.Color(DOT_COLORS[r.level_rank] || DOT_COLORS[0]));
      });
      dots.instanceMatrix.needsUpdate = true;
      dots.userData = { kind: 'points', records: located };
      this.dataGroup.add(dots);
      this.pickables.unshift(dots);
    }
    if (selected && Number.isFinite(selected.lng) && Number.isFinite(selected.lat)) {
      const p = this.project(selected.lng, selected.lat);
      const ring = new THREE.Mesh(new THREE.RingGeometry(this.span * 0.009, this.span * 0.012, 40),
        new THREE.MeshBasicMaterial({ color: THEME.cyan, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p[0], this.depth + this.span * 0.006, p[1]);
      this.dataGroup.add(ring);
      this.focusRing = ring;
    }
    this.draw();
  }

  datum(hit) {
    const data = hit.object.userData;
    return data.kind === 'points' ? { kind: 'alarm', record: data.records[hit.instanceId] } : data;
  }

  hit(e) {
    const box = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((e.clientX - box.left) / box.width * 2 - 1, -(e.clientY - box.top) / box.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.pickables, false)[0];
  }

  home(top = false) {
    if (!this.bounds) return;
    const center = this.bounds.getCenter(new THREE.Vector3());
    center.y = 0;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0, this.span * 1.3, top ? this.span * 0.025 : this.span * 0.8));
    this.camera.lookAt(center);
    this.camera.zoom = 1;
    this.camera.updateMatrixWorld();
    // Fit projected map corners, including room above the tallest data column.
    let mx = 0, my = 0;
    for (const x of [this.bounds.min.x, this.bounds.max.x]) {
      for (const y of [0, this.span * 0.18]) {
        for (const z of [this.bounds.min.z, this.bounds.max.z]) {
          const p = new THREE.Vector3(x, y, z).applyMatrix4(this.camera.matrixWorldInverse);
          mx = Math.max(mx, Math.abs(p.x)); my = Math.max(my, Math.abs(p.y));
        }
      }
    }
    this.fitX = mx; this.fitY = my;
    this.resize();
    this.controls.update();
  }

  zoom(factor) {
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, 0.6, 9);
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  resize() {
    if (this.disposed) return;
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h);
    const aspect = w / h;
    const half = Math.max(this.fitY || 20, (this.fitX || 25) / aspect) * 1.16;
    this.camera.left = -half * aspect; this.camera.right = half * aspect;
    this.camera.top = half; this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  draw() {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
    const occupied = [];
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.labels.sort((a, b) => b.priority - a.priority).forEach(label => {
      const p = label.position.clone().project(this.camera);
      const x = (p.x + 1) * w / 2, y = (1 - p.y) * h / 2;
      const width = label.el.offsetWidth || 70;
      const rect = { left: x - width / 2 - 4, right: x + width / 2 + 4, top: y - 28, bottom: y + 2 };
      const visible = p.z > -1 && p.z < 1 && rect.left > 6 && rect.right < w - 6 && y > 18 && y < h - 16
        && !occupied.some(r => rect.left < r.right && rect.right > r.left && rect.top < r.bottom && rect.bottom > r.top);
      label.el.style.visibility = visible ? 'visible' : 'hidden';
      if (visible) { occupied.push(rect); label.el.style.transform = `translate(${x}px,${y}px) translate(-50%,-100%)`; }
    });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointerleave', this.onLeave);
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.labels.forEach(l => l.el.remove());
    disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  // 加载地形高程数据
  async loadTerrain(adcode) {
    try {
      const response = await fetch(`/api/terrain/${adcode}`);
      if (!response.ok) {
        console.warn(`地形数据加载失败: ${adcode}`);
        return null;
      }
      this.terrainData = await response.json();
      return this.terrainData;
    } catch (e) {
      console.warn('地形数据加载失败:', e);
      return null;
    }
  }

  // 启用/禁用地形渲染
  toggleTerrain(enabled) {
    this.terrainEnabled = enabled;
    if (this.terrainMesh) {
      this.terrainMesh.visible = enabled;
    }
    this.draw();
  }

  // 应用地形高程到现有地图
  applyTerrain() {
    if (!this.terrainData || !this.terrainEnabled) return;

    const { width, height, min, max, data } = this.terrainData;
    const elevationScale = this.span * 0.15; // 夸张系数

    // 遍历所有区域 mesh，修改顶点高度
    this.regionMeshes.forEach(meshes => {
      meshes.forEach(mesh => {
        const geometry = mesh.geometry;
        const positions = geometry.attributes.position;

        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i);
          const z = positions.getZ(i);

          // 从投影坐标反推经纬度
          const lon = x / Math.cos(34 * Math.PI / 180) + 105;
          const lat = 35 - z;

          // 在高程网格中查找对应高度
          const elevation = this.sampleElevation(lon, lat);
          if (elevation !== null) {
            const heightOffset = ((elevation - min) / (max - min)) * elevationScale;
            positions.setY(i, positions.getY(i) + heightOffset);
          }
        }

        positions.needsUpdate = true;
        geometry.computeVertexNormals(); // 重新计算法线
      });
    });

    this.draw();
  }

  // 从高程网格采样
  sampleElevation(lon, lat) {
    if (!this.terrainData) return null;

    const { width, height, data } = this.terrainData;
    const bounds = this.bounds;

    // 归一化到 [0, 1]
    const u = (lon - (bounds.min.x / Math.cos(34 * Math.PI / 180) + 105)) /
              ((bounds.max.x - bounds.min.x) / Math.cos(34 * Math.PI / 180));
    const v = ((35 - lat) - bounds.min.z) / (bounds.max.z - bounds.min.z);

    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    // 双线性插值
    const x = u * (width - 1);
    const y = v * (height - 1);
    const x0 = Math.floor(x), x1 = Math.min(x0 + 1, width - 1);
    const y0 = Math.floor(y), y1 = Math.min(y0 + 1, height - 1);
    const fx = x - x0, fy = y - y0;

    const e00 = data[y0 * width + x0];
    const e10 = data[y0 * width + x1];
    const e01 = data[y1 * width + x0];
    const e11 = data[y1 * width + x1];

    return (e00 * (1 - fx) * (1 - fy) +
            e10 * fx * (1 - fy) +
            e01 * (1 - fx) * fy +
            e11 * fx * fy);
  }
}

// 台风三维云墙渲染器
export class TyphoonCloud {
  constructor(scene, typhoonData) {
    this.scene = scene;
    this.typhoonData = typhoonData;
    this.meshes = [];
  }

  // 生成简单的噪声函数（Simplex Noise 简化版）
  noise(x, y, z) {
    const sin = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return sin - Math.floor(sin) - 0.5;
  }

  // 创建台风云墙
  build(path, project) {
    // 清理旧的
    this.clear();

    if (!path || path.length < 2) return;

    path.forEach((point, i) => {
      const pos = project(point.lng, point.lat);
      const radius = (point.radius7 || 300) / 111 * 0.8; // 7级风圈半径转度数
      const height = 2 + (point.strong || 0) * 0.03; // 强度越大云顶越高
      const segments = 32;

      // 云墙几何体 (圆柱体)
      const geometry = new THREE.CylinderGeometry(
        radius * 0.2,  // 风眼
        radius,        // 底部
        height,
        segments,
        4
      );

      // 顶点扰动（模拟云层不规则）
      const positions = geometry.attributes.position;
      for (let j = 0; j < positions.count; j++) {
        const x = positions.getX(j);
        const y = positions.getY(j);
        const z = positions.getZ(j);

        const r = Math.sqrt(x * x + z * z);
        const noise = this.noise(x * 0.5, y * 0.3, z * 0.5);

        // 顶部扰动更大
        const factor = (y + height / 2) / height;
        positions.setY(j, y + noise * 0.5 * factor);

        // 径向扰动
        if (r > 0.01) {
          positions.setX(j, x + (x / r) * noise * 0.3);
          positions.setZ(j, z + (z / r) * noise * 0.3);
        }
      }

      geometry.computeVertexNormals();

      // 材质：半透明白色
      const material = new THREE.MeshPhongMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.35 + Math.min(point.strong || 0, 100) * 0.003, // 强度越大越不透明
        side: THREE.DoubleSide,
        depthWrite: false
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(pos[0], height / 2 + 0.3, pos[1]);

      // 添加旋转动画（逆时针）
      mesh.userData.rotationSpeed = -0.02 - (point.strong || 0) * 0.0001;

      this.scene.add(mesh);
      this.meshes.push(mesh);
    });
  }

  // 更新动画
  update() {
    this.meshes.forEach(mesh => {
      if (mesh.userData.rotationSpeed) {
        mesh.rotation.y += mesh.userData.rotationSpeed;
      }
    });
  }

  // 清理
  clear() {
    this.meshes.forEach(mesh => {
      this.scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    });
    this.meshes = [];
  }

  dispose() {
    this.clear();
  }
}

