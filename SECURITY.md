# Security policy

## Reporting a vulnerability

Please report security issues **privately** rather than opening a public issue.

Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on the repository
(<https://github.com/nimiqtoolbox/nimiq-tax-dashboard/security/advisories/new>).

Please include a description of the issue, steps to reproduce, and the potential impact. We'll
acknowledge your report as soon as we can and keep you updated on the fix.

## Scope & context

This is a fully client-side static site with no backend and no server-side state:

- It never asks for or handles private keys or seed phrases — only **public** Nimiq addresses.
- All data is processed in the browser and stored locally (IndexedDB); nothing is transmitted to
  a server controlled by this project.
- The only outbound requests are read-only calls to the public services listed in the
  [README](README.md#data-sources).

Reports that respect this scope — for example XSS, dependency vulnerabilities, or data-leak
vectors — are especially appreciated. Thank you for helping keep users safe.
