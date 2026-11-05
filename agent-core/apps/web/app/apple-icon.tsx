import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

/** The B.R.C x Grok leaf tile (components/kit/icons.tsx BrandTile, ~/Developer/brc-mac-app/icon.svg). */
export default function AppleIcon() {
  return new ImageResponse(
    <svg fill="none" viewBox="0 0 102 102" xmlns="http://www.w3.org/2000/svg">
      <rect width="102" height="102" rx="23" fill="#203119" />
      <g transform="translate(51 51) scale(2.19) translate(-14 -14)">
        <ellipse cx="14" cy="14" rx="6.2" ry="11" transform="rotate(32 14 14)" fill="#eef3e8" />
        <path d="M9.5 21.5C12 16 15.5 10.5 19 6.5" stroke="#203119" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      </g>
    </svg>,
    size,
  );
}
