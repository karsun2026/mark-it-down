import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Next's dev server needs 'unsafe-eval' for React Refresh; production does not.
 * Without this split the dev build silently fails to hydrate — the page renders
 * but no event handler ever fires, which looks like broken UI rather than a
 * blocked script.
 */
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // §45 - security headers. No document ever renders untrusted HTML, and the
  // page loads no third-party origins, so the policy can be strict.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              // Uploads and downloads go straight to Blob storage, and the
              // browser talks to TWO different Blob hosts:
              //
              //   vercel.com/api/blob            the upload API (@vercel/blob
              //                                  `upload()`, including every
              //                                  multipart part request)
              //   <store>.private.blob.…         reading the source, the
              //                                  status object and the result
              //
              // Omitting vercel.com blocks the upload outright: the request
              // never leaves the browser, so progress sits at 0% with no
              // error the user can see. Note `*.blob.vercel-storage.com` does
              // NOT match the bare host, so it is listed separately.
              "connect-src 'self' https://vercel.com https://blob.vercel-storage.com https://*.blob.vercel-storage.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
