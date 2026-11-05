import { getCACertificates, setDefaultCACertificates } from "node:tls";

type CertificateStore = {
  getCACertificates: typeof getCACertificates;
  setDefaultCACertificates: typeof setDefaultCACertificates;
};

/**
 * Downloads go through Node's fetch, which trusts only the certificates bundled with Node. On a
 * school or company network that inspects traffic, every download then failed with "unable to
 * verify the first certificate", although the browser trusted the same network. This adds the
 * certificates the computer itself trusts, keeping Node's own.
 */
export function trustSystemCertificates(
  store: CertificateStore = { getCACertificates, setDefaultCACertificates },
): boolean {
  try {
    const bundled = store.getCACertificates("default");
    const system = store.getCACertificates("system");
    store.setDefaultCACertificates([...new Set([...bundled, ...system])]);
    return true;
  } catch {
    // Node's own certificates still work, which is how it was before.
    return false;
  }
}
