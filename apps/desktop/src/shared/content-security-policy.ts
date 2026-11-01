/**
 * The Content Security Policy of the built renderer, in one place. The main
 * process sends it as a header with every app:// response, and the renderer
 * build writes it into the meta element of index.html (config/csp.ts).
 *
 * Scripts, styles, images, and fonts come only from the page's own origin,
 * app://renderer, which serves only the built renderer files. No inline code,
 * no eval, no remote origin, and no network connection.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'";
