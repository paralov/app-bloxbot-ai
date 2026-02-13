import { Toaster as Sonner, type ToasterProps } from "sonner";

/* ── Custom toast icons ──────────────────────────────────────────── */

function ErrorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8.866 2.5a1 1 0 0 0-1.732 0L1.34 13a1 1 0 0 0 .866 1.5h11.588a1 1 0 0 0 .866-1.5L8.866 2.5Z"
        fill="oklch(0.577 0.245 27.325 / 0.12)"
        stroke="oklch(0.577 0.245 27.325)"
        strokeWidth="1.2"
      />
      <path d="M8 6v3" stroke="oklch(0.577 0.245 27.325)" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.25" r="0.75" fill="oklch(0.577 0.245 27.325)" />
    </svg>
  );
}

function SuccessIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle
        cx="8"
        cy="8"
        r="6.4"
        fill="oklch(0.556 0.16 142 / 0.12)"
        stroke="oklch(0.556 0.16 142)"
        strokeWidth="1.2"
      />
      <path
        d="M5.5 8.2 7.1 9.8 10.5 6.4"
        stroke="oklch(0.556 0.16 142)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle
        cx="8"
        cy="8"
        r="6.4"
        fill="oklch(0.55 0.12 250 / 0.12)"
        stroke="oklch(0.55 0.12 250)"
        strokeWidth="1.2"
      />
      <path d="M8 7v3.5" stroke="oklch(0.55 0.12 250)" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="5.25" r="0.75" fill="oklch(0.55 0.12 250)" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8.866 2.5a1 1 0 0 0-1.732 0L1.34 13a1 1 0 0 0 .866 1.5h11.588a1 1 0 0 0 .866-1.5L8.866 2.5Z"
        fill="oklch(0.75 0.18 65 / 0.15)"
        stroke="oklch(0.75 0.18 65)"
        strokeWidth="1.2"
      />
      <path d="M8 6v3" stroke="oklch(0.65 0.16 65)" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.25" r="0.75" fill="oklch(0.65 0.16 65)" />
    </svg>
  );
}

/* ── Toaster component ───────────────────────────────────────────── */

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      position="top-right"
      closeButton
      gap={8}
      icons={{
        error: <ErrorIcon />,
        success: <SuccessIcon />,
        info: <InfoIcon />,
        warning: <WarningIcon />,
      }}
      toastOptions={{
        style: {
          pointerEvents: "auto",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // Ensure the toaster container doesn't block the title bar
          pointerEvents: "none",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
