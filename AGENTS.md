# Parc API Gateway Instructions

## Mission

This repository owns the public Kong Gateway configuration for Parc. It routes public traffic only to the Mobile and Admin BFFs and owns no business data or domain behavior.

## Rules

- Run Kong in DB-less mode with declarative, version-controlled configuration.
- Never expose domain services or their internal routes publicly.
- Bind the Kong Admin API to loopback in local development and keep it private in production.
- Treat gateway authentication as defense-in-depth. BFFs and domain services must independently authenticate and authorize requests.
- Do not trust or originate identity headers unless direct network access to upstream BFFs is blocked.
- Do not embed TLS keys, JWT keys, provider credentials, or other secrets.
- Pin container and JavaScript dependency versions.
- Validate configuration, formatting, route boundaries, and security invariants after changes.
