# Security policy

Do not open a public issue containing Discord tokens, Treasury keys, webhook
secrets, encryption keys, database URLs, transaction details or personal data.
Use GitHub's private vulnerability reporting for this repository. If that
feature is unavailable, contact the repository owner privately before sharing
technical evidence.

Immediately rotate any credential that may have appeared in chat, logs, shell
history or screenshots. Set `FINANCE_MODE=disabled`, preserve database and
posting evidence, and follow the incident procedure in
[OPERATIONS.md](OPERATIONS.md). Never delete or manually rewrite financial
records while investigating an incident.

Supported security fixes are applied to the current `main` branch. Reports
should include the affected commit, reproduction steps with all secrets
redacted, impact, and whether money movement could have occurred.
