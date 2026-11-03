// OpenCode's own provider logos (MIT, see the LICENSE beside them), and its generic mark for any
// provider without one. They're inlined because a CSS mask can't load a file:// URL.
const LOGOS = import.meta.glob<string>("../assets/provider-icons/*.svg", {
  eager: true,
  query: "?inline",
  import: "default",
});

function logoUrl(providerId: string) {
  return (
    LOGOS[`../assets/provider-icons/${providerId}.svg`] ??
    LOGOS["../assets/provider-icons/synthetic.svg"]
  );
}

interface ProviderLogoProps {
  providerId: string;
  className?: string;
}

function ProviderLogo({ providerId, className = "" }: ProviderLogoProps) {
  return (
    <span
      aria-hidden="true"
      className={`relative flex h-5 w-5 shrink-0 items-center justify-center text-foreground ${className}`}
    >
      {/* A mask lets the logo take the text color, so it works in light and dark themes. */}
      <span
        className="h-4 w-4 bg-current"
        style={{
          maskImage: `url("${logoUrl(providerId)}")`,
          maskSize: "contain",
          maskRepeat: "no-repeat",
          maskPosition: "center",
        }}
      />
    </span>
  );
}

export default ProviderLogo;
