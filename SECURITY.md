# Security Policy

## Supported Versions

Only the latest published release of each package receives security fixes.

| Package | Supported release |
| --- | --- |
| `@j1nn0/agent-context-guard` | Latest release |
| `@j1nn0/agent-context-guard-pi` | Latest release |

These packages are pre-1.0. Fixes ship in a new release rather than being backported to older lines.

## Reporting a Vulnerability

Report privately at
[github.com/j1nn0/agent-primitives/security/advisories/new](https://github.com/j1nn0/agent-primitives/security/advisories/new),
or open the repository Security tab and select **Report a vulnerability**.
Either opens a private report visible only to maintainers.

Do not report vulnerabilities in public GitHub issues, discussions, or pull requests. Report ordinary non-security bugs and feature requests in normal GitHub issues.

If private reporting is unavailable to you, open an issue asking for a private channel. Do not include any vulnerability detail in that issue.

## What to Include

- The affected package and version.
- What an attacker can achieve and under what conditions.
- Steps to reproduce or a minimal proof of concept.
- The environment, including the Node.js version and whether the Pi adapter is involved.
- Any mitigation you already know.

Avoid destructive or disruptive testing. Do not access data that is not yours.

## Scope

This project can fix security issues in:

- The runtime behaviour of the two published packages.
- How they handle untrusted or attacker-influenced content.
- The integrity of published package artifacts.
- The release pipeline that produces them, since a weakness there could compromise what users install.

## Out of Scope

- Ordinary bugs and feature requests with no security impact.
- Issues that affect only versions other than the latest release.
- Problems only in an application that consumes these packages.
- Problems only in upstream software such as Node.js, npm, pnpm, GitHub Actions, or the Pi coding agent.

A weakness in upstream software is in scope when this project's use of it makes the weakness reachable or exploitable. Report those issues here.

## Coordination and Disclosure

Keep details private until a fix or a coordinated disclosure is ready.

Reports are handled privately. Severity and impact are assessed case by case. A fix normally ships as a new release.

A GitHub security advisory may be published. The reporter can be credited if they want it.

We aim to acknowledge reports within seven days. This is not a commitment. We do not promise a fix deadline; timing depends on severity and complexity.
