/**
 * Decorative hero backdrop: an original, stylized mountain-and-skyline silhouette (forest green with warm window
 * lights). Purely presentational and static, so it costs no JS and causes no layout shift (fixed aspect ratio).
 */
export function MountainBackdrop({ className = "" }: { className?: string }) {
  const towers: [number, number, number][] = [
    [40, 34, 16], [60, 52, 14], [78, 40, 18], [100, 70, 16], [120, 58, 14], [138, 86, 18], [160, 64, 16], [180, 48, 14],
    [430, 44, 16], [450, 66, 18], [472, 52, 14], [490, 78, 16], [510, 60, 18], [532, 42, 14], [550, 56, 16],
  ];
  const trees = [196, 214, 236, 258, 282, 306, 330, 352, 376, 398, 418];
  return (
    <svg viewBox="0 0 600 120" className={`block aspect-[5/1] w-full ${className}`} aria-hidden focusable="false">
      <defs>
        <linearGradient id="mb-hill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--forest)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--forest-deep)" stopOpacity="0.15" />
        </linearGradient>
        <linearGradient id="mb-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </linearGradient>
        <mask id="mb-mask">
          <rect width="600" height="120" fill="url(#mb-fade)" />
        </mask>
      </defs>
      <g mask="url(#mb-mask)">
        <path d="M0 120 L0 104 Q120 92 190 70 Q260 26 300 22 Q350 26 410 66 Q480 94 600 104 L600 120Z" fill="url(#mb-hill)" />
        {trees.map((x, i) => {
          const y = 60 - Math.sin(((x - 190) / 230) * Math.PI) * 26 + (i % 2) * 4;
          return <path key={x} d={`M${x} ${y - 14} l6 14 h-12z`} fill="var(--forest)" opacity={0.55} />;
        })}
        {towers.map(([x, h, w], i) => (
          <g key={x}>
            <rect x={x} y={112 - h} width={w} height={h} fill="oklch(0.25 0.04 262)" />
            {Array.from({ length: Math.floor(h / 10) }, (_, r) => (
              <rect key={r} x={x + 3} y={116 - h + r * 10} width={w - 6} height={1.6} fill="var(--glow)" opacity={(i + r) % 3 ? 0.35 : 0.8} />
            ))}
          </g>
        ))}
      </g>
    </svg>
  );
}
