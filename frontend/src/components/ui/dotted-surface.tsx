import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { cn } from '../../../@/lib/utils';
import { getResolvedTheme } from '../../features/editor/editorOptions';
import { usePreferencesStore } from '../../state/preferencesStore';

export interface DottedSurfaceProps {
  size?: number;
  opacity?: number;
  sizeAttenuation?: boolean;
  vertexColors?: boolean;
  className?: string;
}

/** Responsive, transparent Three.js point field for decorative page backgrounds. */
export default function DottedSurface({
  size = 7,
  opacity = 0.5,
  sizeAttenuation = true,
  vertexColors = true,
  className,
}: DottedSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const themePreference = usePreferencesStore((state) => state.theme);
  const reducedMotionPreference = usePreferencesStore((state) => state.reducedMotion);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || (typeof window.WebGLRenderingContext === 'undefined' && typeof window.WebGL2RenderingContext === 'undefined')) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.replaceChildren(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(52, 1, 1, 5000);
    camera.position.set(0, 390, 1050);
    camera.lookAt(0, 0, 0);

    const geometry = new THREE.BufferGeometry();
    const isLightTheme = () => getResolvedTheme(themePreference, colorSchemeQuery.matches) === 'light';
    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: Math.max(1, size),
      sizeAttenuation,
      transparent: true,
      opacity: THREE.MathUtils.clamp(opacity, 0, 1),
      depthWrite: false,
      vertexColors,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);

    let positions = new Float32Array();
    let baseX = new Float32Array();
    let baseZ = new Float32Array();
    let animationFrameId = 0;
    let disposed = false;
    let shouldAnimate = false;
    let elapsed = 0;
    let previousFrameTime = 0;

    const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: light)');
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const rebuildGrid = (width: number, height: number) => {
      const safeWidth = Math.max(width, 1);
      const safeHeight = Math.max(height, 1);
      const viewDepth = camera.position.length();
      const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * viewDepth;
      const spacing = 42;
      const columns = Math.max(2, Math.ceil((viewHeight * (safeWidth / safeHeight) * 1.18) / spacing));
      const rows = Math.max(2, Math.ceil((viewHeight * 1.18) / spacing));
      const count = columns * rows;
      positions = new Float32Array(count * 3);
      baseX = new Float32Array(count);
      baseZ = new Float32Array(count);
      const colors = vertexColors ? new Float32Array(count * 3) : null;
      const color = new THREE.Color();
      let index = 0;

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const x = (column - (columns - 1) / 2) * spacing;
          const z = (row - (rows - 1) / 2) * spacing;
          const offset = index * 3;
          baseX[index] = x;
          baseZ[index] = z;
          positions[offset] = x;
          positions[offset + 1] = 0;
          positions[offset + 2] = z;
          if (colors) {
            const hue = 0.39 + (column / Math.max(columns - 1, 1)) * 0.1;
            const lightness = isLightTheme() ? 0.34 + (row / Math.max(rows - 1, 1)) * 0.08 : 0.47 + (row / Math.max(rows - 1, 1)) * 0.12;
            color.setHSL(hue, 0.82, lightness);
            colors[offset] = color.r;
            colors[offset + 1] = color.g;
            colors[offset + 2] = color.b;
          }
          index += 1;
        }
      }

      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      else geometry.deleteAttribute('color');
      geometry.computeBoundingSphere();
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(safeWidth, safeHeight, false);
    };

    const renderFrame = (time: number) => {
      if (disposed) return;
      const delta = previousFrameTime ? Math.min((time - previousFrameTime) / 1000, 0.05) : 0;
      previousFrameTime = time;
      elapsed += delta;

      for (let index = 0; index < baseX.length; index += 1) {
        const x = baseX[index];
        const z = baseZ[index];
        positions[index * 3 + 1] = Math.sin(x * 0.012 + elapsed * 1.05) * 22
          + Math.cos(z * 0.014 - elapsed * 0.82) * 15;
      }
      const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute;
      positionAttribute.needsUpdate = true;
      renderer.render(scene, camera);
      if (shouldAnimate) animationFrameId = window.requestAnimationFrame(renderFrame);
      else animationFrameId = 0;
    };

    const applyMotionPreference = () => {
      shouldAnimate = !reducedMotionPreference && !reducedMotionQuery.matches;
      if (shouldAnimate && !animationFrameId) animationFrameId = window.requestAnimationFrame(renderFrame);
      if (!shouldAnimate) {
        if (animationFrameId) window.cancelAnimationFrame(animationFrameId);
        animationFrameId = 0;
        previousFrameTime = 0;
        renderFrame(0);
      }
    };

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      rebuildGrid(width, height);
      if (!shouldAnimate) renderFrame(0);
    };

    const applyTheme = () => {
      if (vertexColors) rebuildGrid(container.clientWidth, container.clientHeight);
      if (!shouldAnimate) renderFrame(0);
    };

    rebuildGrid(container.clientWidth, container.clientHeight);
    applyMotionPreference();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    resizeObserver?.observe(container);
    window.addEventListener('resize', resize);
    reducedMotionQuery.addEventListener('change', applyMotionPreference);
    colorSchemeQuery.addEventListener('change', applyTheme);

    return () => {
      disposed = true;
      if (animationFrameId) window.cancelAnimationFrame(animationFrameId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', resize);
      reducedMotionQuery.removeEventListener('change', applyMotionPreference);
      colorSchemeQuery.removeEventListener('change', applyTheme);
      geometry.dispose();
      material.dispose();
      scene.clear();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
    };
  }, [opacity, reducedMotionPreference, size, sizeAttenuation, themePreference, vertexColors]);

  return <div ref={containerRef} aria-hidden="true" className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)} />;
}
