import { useState } from "react";

// models.dev serves a monochrome logo for every provider OpenCode lists, and a
// generic mark for any it doesn't know. Offline, the first letter stands in.
function logoUrl(providerId: string) {
  return `https://models.dev/logos/${encodeURIComponent(providerId)}.svg`;
}

interface ProviderLogoProps {
  providerId: string;
  name: string;
  className?: string;
}

function ProviderLogo({ providerId, name, className = "" }: ProviderLogoProps) {
  const [loaded, setLoaded] = useState(false);
  const url = logoUrl(providerId);

  return (
    <span
      aria-hidden="true"
      className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background text-foreground ${className}`}
    >
      {loaded ? (
        // A mask lets the logo take the text color, so it works in light and dark themes.
        <span
          className="h-3.5 w-3.5 bg-current"
          style={{
            maskImage: `url("${url}")`,
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
          }}
        />
      ) : (
        <span className="text-[11px] font-semibold text-muted-foreground">
          {name.trim().charAt(0).toUpperCase()}
        </span>
      )}
      {!loaded && (
        <img
          src={url}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          className="pointer-events-none absolute h-px w-px opacity-0"
        />
      )}
    </span>
  );
}

export default ProviderLogo;
