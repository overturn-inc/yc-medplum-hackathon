# YC Medplum Hackathon Working Rules

## Source of truth

- Medplum packages are installed from npm. For source-level research, clone the
  public Medplum repository separately and create an ignored local
  `medplum-link` symlink as described in `README.md`.
- Read the relevant official Medplum documentation before implementing a
  Medplum or FHIR behavior.
- Use FHIR R4 only and type resources with `@medplum/fhirtypes`.
- Do not invent FHIR fields, search parameters, profiles, extensions, or medical codes.

## Product boundaries

- Use synthetic data only unless the user explicitly changes this rule.
- Keep Medplum credentials and Breakfast Factory credentials in server or Electron main-process boundaries.
- Require explicit approval before external submission or irreversible writes.
- Treat Medplum as the healthcare data and workflow plane, and Breakfast Factory as the agent execution plane.

## Validation

- Type-check all FHIR resources.
- Run tests and build before calling a feature complete.
- When a Medplum server is configured, validate resources server-side before demo acceptance.
