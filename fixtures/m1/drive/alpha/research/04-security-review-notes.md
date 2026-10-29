# AW-M1 Alpha: Security review notes for feature-flag vendors

Meeting date: 2026-10-12. Owner: Security team (synthetic test data).

- Flagship passed the vendor security questionnaire with no high findings.
- Togglr passed with one medium finding: API tokens do not expire by default.
- The security team recorded Togglr's uptime SLA as 99.5%, based on a sales call.
  This conflicts with the Togglr evaluation document, which lists 99.9%.
- Requirement: any vendor must support EU data residency before 2027-03-31 because of the
  new EU customer contract.
