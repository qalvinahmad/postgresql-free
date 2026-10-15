# Security policy

## Reporting a vulnerability

Please do not open a public issue containing exploit details or credentials.
Use GitHub's **Report a vulnerability** feature for this repository so the
maintainers can investigate privately.

## Security boundaries

- Provider Management API keys must stay on a trusted server.
- CORS allowlists do not authenticate or authorize callers.
- Add authentication, authorization, and rate limiting to the usage endpoint
  when exposing it outside a trusted network.
- Client-side operation guards can be bypassed; enforce important policy on
  the server.
- Usage samples may lag and do not reserve quota atomically.
