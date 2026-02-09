import { useStore } from "@/stores/opencode";

function ChatSetup() {
  const dismissWelcome = useStore((s) => s.dismissWelcome);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="animate-fade-in-up w-full max-w-sm text-center">
        <img src="/bloxbot-logo.svg" alt="" className="mx-auto h-14 w-14" />
        <p className="mt-3 font-serif text-lg italic text-foreground">bloxbot</p>

        <h2 className="mt-8 font-serif text-4xl italic text-foreground">Ready to build?</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Your AI co-pilot for Roblox Studio is warming up in the background.
        </p>

        <button
          onClick={dismissWelcome}
          className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Get Started
        </button>
      </div>
    </div>
  );
}

export default ChatSetup;
