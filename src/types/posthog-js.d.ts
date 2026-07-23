declare module "posthog-js/dist/module.full.no-external.js" {
  const posthog: typeof import("posthog-js").default;
  export default posthog;
}
