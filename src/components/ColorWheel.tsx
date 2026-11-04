import { type PointerEvent, useRef } from "react";
import { type HsvColor, hsvToHex } from "@/lib/explorer";

const WHEEL_SIZE = 160;

/** Hue goes around the wheel and saturation out from the middle, as in Studio's color picker. */
export function ColorWheel({
  color,
  onChange,
}: {
  color: HsvColor;
  onChange: (color: HsvColor) => void;
}) {
  const wheelRef = useRef<HTMLDivElement>(null);

  const pick = (event: PointerEvent) => {
    const bounds = wheelRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const radius = bounds.width / 2;
    const x = event.clientX - bounds.left - radius;
    const y = event.clientY - bounds.top - radius;
    const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    onChange({ ...color, hue, saturation: Math.min(Math.hypot(x, y) / radius, 1) });
  };

  const angle = (color.hue * Math.PI) / 180;
  const markerRadius = (color.saturation * WHEEL_SIZE) / 2;
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        ref={wheelRef}
        data-testid="color-wheel"
        className="relative shrink-0 cursor-crosshair touch-none rounded-full ring-1 ring-border"
        style={{
          width: WHEEL_SIZE,
          height: WHEEL_SIZE,
          background:
            "radial-gradient(circle closest-side, #fff, transparent), conic-gradient(from 90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          pick(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) pick(event);
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 rounded-full bg-black"
          style={{ opacity: 1 - color.value }}
        />
        <div
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          style={{
            left: WHEEL_SIZE / 2 + Math.cos(angle) * markerRadius,
            top: WHEEL_SIZE / 2 + Math.sin(angle) * markerRadius,
            backgroundColor: hsvToHex(color),
          }}
        />
      </div>
      <input
        type="range"
        aria-label="Brightness"
        min={0}
        max={100}
        value={Math.round(color.value * 100)}
        onChange={(event) => onChange({ ...color, value: Number(event.target.value) / 100 })}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-foreground"
        style={{
          background: `linear-gradient(to right, #000, ${hsvToHex({ ...color, value: 1 })})`,
        }}
      />
    </div>
  );
}
