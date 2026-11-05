import { ImageResponse } from "next/og";
import { RISOLVE_MARK } from "@/components/kit/brand-mark";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

/** The Risolve mark, light on a Dark Green tile (same as app/icon.svg). */
export default function AppleIcon() {
  return new ImageResponse(
    <svg fill="none" viewBox="0 0 102 102" xmlns="http://www.w3.org/2000/svg">
      <rect width="102" height="102" rx="23" fill="#203119" />
      <g transform="translate(18.25 14.25) scale(0.0476) translate(-80.37 1619.85) scale(1 -1)" fill="#eef3e8">
        <path d={RISOLVE_MARK} />
      </g>
    </svg>,
    size,
  );
}
