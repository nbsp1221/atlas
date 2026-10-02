# Automation Simulation

Programmable provider-independent simulation used by the product's test-run
workflow and by automated tests.

This package intentionally contains fake external-world adapters and scenarios.
It is a runtime implementation for simulation mode, not a production provider
integration and not an auth backend.

Real providers belong under packages/integrations/*.
