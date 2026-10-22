/** 24x24 のラインアイコン。stroke=色で描画する */
export function Icon({ name, size, color, filled }: { name: string; size: number; color: string; filled?: boolean }) {
  const s = size / 24;
  const common = { fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const f = filled ? color : "none";
  let body;
  switch (name) {
    case "calendar":
      body = (
        <>
          <rect x="3" y="5" width="18" height="16" rx="2.5" {...common} />
          <path d="M3 10h18M8 3v4M16 3v4" {...common} />
          {[7, 11, 15].flatMap((x) => [13.5, 17].map((y) => <circle key={`${x}${y}`} cx={x + 1} cy={y} r="1" fill={color} />))}
        </>
      );
      break;
    case "pin":
      body = (
        <>
          <path d="M12 22s7-6.6 7-12.2A7 7 0 0 0 5 9.8C5 15.4 12 22 12 22z" fill={color} stroke={color} strokeWidth={1.5} />
          <circle cx="12" cy="9.8" r="2.6" fill="#fff" />
        </>
      );
      break;
    case "clock":
      body = (
        <>
          <circle cx="12" cy="12" r="9.5" {...common} strokeWidth={2.4} />
          <path d="M12 6.5V12h4.5" {...common} strokeWidth={2.4} />
        </>
      );
      break;
    case "beginner": // 初心者マーク（若葉マーク）
      body = (
        <>
          <path d="M12 7 L5 3 V15 L12 21 Z" fill="#ffd400" stroke="#1d1d1d" strokeWidth={1.2} strokeLinejoin="round" />
          <path d="M12 7 L19 3 V15 L12 21 Z" fill="#14a83b" stroke="#1d1d1d" strokeWidth={1.2} strokeLinejoin="round" />
        </>
      );
      break;
    case "heart":
      body = <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" {...common} fill={f} />;
      break;
    case "star":
      body = <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" {...common} fill={f} />;
      break;
    case "sparkle":
      body = <path d="M12 2c.8 5.2 4.8 9.2 10 10-5.2.8-9.2 4.8-10 10-.8-5.2-4.8-9.2-10-10 5.2-.8 9.2-4.8 10-10z" fill={color} />;
      break;
    case "camera":
      body = (
        <>
          <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H8l1.6-2.2h4.8L16 6h2.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" {...common} fill={f} />
          <circle cx="12" cy="13" r="4" {...common} />
          <circle cx="12" cy="13" r="1.6" {...common} />
        </>
      );
      break;
    case "plane":
      body = <path d="M2.5 13.5 21 4.5l-4.5 15-4.2-5.3-5 2.8 1.6-4.6z" {...common} fill={f} />;
      break;
    case "check":
      body = <path d="M4 12.5l5 5L20 6.5" {...common} strokeWidth={2.6} />;
      break;
    case "laptop":
      body = (
        <>
          <rect x="4" y="5" width="16" height="11" rx="1.5" {...common} />
          <path d="M2 19h20" {...common} />
        </>
      );
      break;
    case "chat":
      body = <path d="M4 5h16v11H9l-5 4z" {...common} fill={f} />;
      break;
    default:
      body = <circle cx="12" cy="12" r="9" {...common} />;
  }
  return <g transform={`scale(${s})`}>{body}</g>;
}
